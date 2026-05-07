package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	mathrand "math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// onFrameFunc is the callback the transport calls for every decoded inbound frame.
type onFrameFunc func(frame *Frame, lane string)

// laneTransport implements the HTTP polling transport that matches
// the managed-host transport profile. It runs one UP goroutine and one (or more)
// DOWN goroutines per lane.
type laneTransport struct {
	cfg           *Config
	token         string
	role          string
	peerLabel     string
	peerSessionID string
	onFrame       onFrameFunc
	routes        *routeProvider

	// Per-lane bounded queues (buffered channels).
	// Index: laneName → channel of *Frame
	queues map[string]chan *Frame
	// When collapse_data_lanes the pri/bulk queues are nil and both
	// write to dataQueue, which is served by the "data" lane workers.
	dataQueue         chan *Frame
	collapseDataLanes bool

	// Replay dequeues: frames that must be retried after an UP error.
	replayMu     sync.Mutex
	replayQueues map[string][]*Frame

	// Failure counters for backoff (direction+lane key → count)
	failMu    sync.Mutex
	failCount map[string]int

	// HTTP clients keyed by (lane, direction, workerIdx)
	clientMu sync.Mutex
	clients  map[string]*http.Client

	// User-Agent chosen once at session start and held constant.
	userAgent string

	// Stop signal
	ctx      context.Context
	cancel   context.CancelFunc
	stopCh   chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup

	rngMu sync.Mutex
	rng   *mathrand.Rand

	// Configurable tunables (derived from cfg once at start)
	maxBatchBytes        int
	flushDelay           time.Duration
	httpTimeout          time.Duration
	downReadTimeout      time.Duration
	downStreamMaxSession time.Duration
	intervalJitterRatio  float64
	backoffInitialDelay  time.Duration
	backoffMaxDelay      time.Duration
	downLanes            map[string]bool
	downParallelism      map[string]int
	uploadProfiles       map[string]uploadProfile
	streamControlLane    string
	sendQueueTimeout     time.Duration
	upWorkers            map[string]int
	adaptiveUpload       *adaptiveUploadController
	cipherSuite          string
	uploadBodyMode       string
	uploadFilename       string
}

type uploadProfile struct {
	maxBatchBytes int
	flushDelay    time.Duration
}

func newLaneTransport(cfg *Config, role, peerID string, onFrame onFrameFunc) *laneTransport {
	token := cfg.ClientToken
	if role == "agent" && cfg.AgentToken != "" {
		token = cfg.AgentToken
	}
	t := &laneTransport{
		cfg:           cfg,
		token:         token,
		role:          role,
		peerLabel:     peerID,
		peerSessionID: randomPeerID(),
		userAgent:     PickUserAgent(cfg),
		onFrame:       onFrame,
		routes: newRouteProvider(
			cfg.BrokerBaseURL,
			cfg.RouteTemplate,
			cfg.HSRouteTemplate,
			cfg.HealthTemplate,
		),
		queues:       make(map[string]chan *Frame),
		replayQueues: make(map[string][]*Frame),
		failCount:    make(map[string]int),
		clients:      make(map[string]*http.Client),
		stopCh:       make(chan struct{}),
		rng:          mathrand.New(mathrand.NewSource(time.Now().UnixNano())),

		maxBatchBytes:        cfg.MaxBatchBytes,
		flushDelay:           time.Duration(cfg.FlushDelaySeconds * float64(time.Second)),
		httpTimeout:          time.Duration(cfg.HTTPTimeoutSeconds * float64(time.Second)),
		downReadTimeout:      time.Duration(cfg.DownReadTimeoutSeconds * float64(time.Second)),
		downStreamMaxSession: time.Duration(cfg.DownStreamMaxSessionSeconds * float64(time.Second)),
		intervalJitterRatio:  cfg.IntervalJitterRatio,
		backoffInitialDelay:  time.Duration(cfg.BackoffInitialDelaySeconds * float64(time.Second)),
		backoffMaxDelay:      time.Duration(cfg.BackoffMaxDelaySeconds * float64(time.Second)),
		streamControlLane:    LaneCTL,
		sendQueueTimeout:     time.Duration(cfg.SendQueueTimeoutSeconds * float64(time.Second)),
		collapseDataLanes:    true,
		upWorkers:            map[string]int{LaneCTL: 1, LaneData: 2},
		cipherSuite:          cipherSuiteHMACSHA256CTR,
		uploadBodyMode:       strings.ToLower(strings.TrimSpace(cfg.UploadBodyMode)),
		uploadFilename:       randomFilename(),
	}
	if t.uploadBodyMode == "" {
		t.uploadBodyMode = "multipart"
	}
	t.routes.setCamouflage("", "", cfg.LaneRoutes)

	// ctl/pri/bulk queues kept for non-collapsed sends; dataQueue serves the
	// collapsed data lane (mirrors Python _transport_common_args collapse_data_lanes=True).
	for _, lane := range allLanes {
		t.queues[lane] = make(chan *Frame, 512)
	}
	t.dataQueue = make(chan *Frame, 512)

	// With collapseDataLanes=true, external lanes are (ctl, data).
	// data DOWN parallelism=2: one session stays active while the other reconnects after rotation.
	// data UP parallelism=2: handled in start() — two goroutines read the same dataQueue so one
	// batch is in-flight while the next is being collected, doubling effective upload throughput.
	t.downLanes = map[string]bool{LaneCTL: true, LaneData: true}
	t.downParallelism = map[string]int{LaneCTL: 1, LaneData: 2}

	// Default upload profiles.
	t.uploadProfiles = map[string]uploadProfile{
		LaneCTL:  {maxBatchBytes: 4096, flushDelay: 1 * time.Millisecond},
		LanePRI:  {maxBatchBytes: 4096, flushDelay: min2(t.flushDelay, time.Millisecond)},
		LaneBulk: {maxBatchBytes: min2i(t.maxBatchBytes, 32768), flushDelay: max2(t.flushDelay, 8*time.Millisecond)},
		// data lane: use full batch budget — throughput is RTT-bound so larger batches help directly
		LaneData: {maxBatchBytes: t.maxBatchBytes, flushDelay: min2(max2(t.flushDelay, time.Millisecond), 2*time.Millisecond)},
	}
	return t
}

func (t *laneTransport) applyBrokerCapabilities(ctx context.Context) error {
	profileName := strings.TrimSpace(t.cfg.TransportProfile)
	if profileName != "" && profileName != "auto" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, "GET", t.routes.healthURL(), nil)
	if err != nil {
		return err
	}
	headers := buildConnectionHeaders(t.token, t.role, t.peerLabel, t.peerSessionID, t.userAgent, t.cfg)
	headers["X-Twoman-Cipher"] = t.cipherSuite
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := t.buildHTTPClient(LaneCTL, "health")
	var resp *http.Response
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err = client.Do(req.Clone(ctx))
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("broker health probe: %w", err)
		}
		select {
		case <-time.After(250 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodySnip, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("broker health status %d: %s", resp.StatusCode, bodySnip)
	}
	var payload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return fmt.Errorf("broker health decode: %w", err)
	}
	capabilities := extractCapabilities(payload)
	if len(capabilities) == 0 {
		return nil
	}
	t.cipherSuite = selectCipherSuite(capabilities)
	t.applyCamouflage(capabilities)
	profileName = selectTransportProfile(t.cfg, capabilities)
	if profileName == "" {
		return nil
	}
	if err := t.applyTransportProfile(capabilities, profileName); err != nil {
		return err
	}
	log.Printf("[transport] profile=%s cipher=%s role=%s down_lanes=%v down_parallelism=%v up_workers=%v stream_control_lane=%s",
		profileName, t.cipherSuite, t.role, sortedLaneKeys(t.downLanes), t.downParallelism, t.upWorkers, t.streamControlLane)
	return nil
}

func (t *laneTransport) applyCamouflage(capabilities map[string]interface{}) {
	raw, ok := capabilities["camouflage"].(map[string]interface{})
	if !ok {
		return
	}
	if mediaType, ok := raw["binary_media_type"].(string); ok && strings.TrimSpace(mediaType) != "" {
		t.cfg.BinaryMediaType = strings.TrimSpace(mediaType)
	}
	if mode, ok := raw["upload_body_mode"].(string); ok && strings.TrimSpace(mode) != "" {
		t.uploadBodyMode = strings.ToLower(strings.TrimSpace(mode))
	}
	routeTemplate, _ := raw["route_template"].(string)
	healthTemplate, _ := raw["health_template"].(string)
	laneRoutes := stringMap(raw["lane_routes"])
	t.routes.setCamouflage(routeTemplate, healthTemplate, laneRoutes)
	if names := stringMap(raw["identity_cookie_names"]); len(names) > 0 {
		t.cfg.IdentityCookieNames = names
	}
}

func selectCipherSuite(capabilities map[string]interface{}) string {
	suites := stringSlice(capabilities["cipher_suites"])
	if hasString(suites, cipherSuiteAES256CTR) {
		return cipherSuiteAES256CTR
	}
	if hasString(suites, cipherSuiteHMACSHA256CTR) {
		return cipherSuiteHMACSHA256CTR
	}
	return cipherSuiteHMACSHA256CTR
}

func extractCapabilities(payload map[string]interface{}) map[string]interface{} {
	if cap, ok := payload["capabilities"].(map[string]interface{}); ok {
		return cap
	}
	stats, _ := payload["stats"].(map[string]interface{})
	if cap, ok := stats["capabilities"].(map[string]interface{}); ok {
		return cap
	}
	return nil
}

func selectTransportProfile(cfg *Config, capabilities map[string]interface{}) string {
	if forced := strings.TrimSpace(cfg.TransportProfile); forced != "" && forced != "auto" {
		return forced
	}
	supported := stringSlice(capabilities["supported_profiles"])
	recommended, _ := capabilities["recommended_profile"].(string)
	if hasString(supported, recommended) {
		return recommended
	}
	if hasString(supported, "managed_host_http") {
		return "managed_host_http"
	}
	if len(supported) > 0 {
		return supported[0]
	}
	return recommended
}

func (t *laneTransport) applyTransportProfile(capabilities map[string]interface{}, profileName string) error {
	profiles, _ := capabilities["profiles"].(map[string]interface{})
	rawProfile, ok := profiles[profileName].(map[string]interface{})
	if !ok {
		return fmt.Errorf("broker profile %q is not advertised", profileName)
	}
	rawRole, ok := rawProfile[t.role].(map[string]interface{})
	if !ok {
		return fmt.Errorf("broker profile %q has no %s settings", profileName, t.role)
	}
	if lanes := stringSlice(rawRole["down_lanes"]); len(lanes) > 0 {
		t.downLanes = make(map[string]bool)
		for _, lane := range lanes {
			t.downLanes[lane] = true
		}
	}
	if rawParallel, ok := rawRole["down_parallelism"].(map[string]interface{}); ok {
		t.downParallelism = parseIntMap(rawParallel, 1)
	}
	if rawWorkers, ok := rawRole["up_workers"].(map[string]interface{}); ok {
		for lane, workers := range parseIntMap(rawWorkers, 1) {
			t.upWorkers[lane] = workers
		}
	}
	if rawHTTP2, ok := rawRole["http2_enabled"].(map[string]interface{}); ok {
		if v, ok := rawHTTP2[LaneCTL].(bool); ok {
			t.cfg.http2CtlEnabled = v
		}
		if v, ok := rawHTTP2[LaneData].(bool); ok {
			t.cfg.http2DataEnabled = v
		}
	}
	if controlLane, ok := rawRole["stream_control_lane"].(string); ok && controlLane != "" {
		t.streamControlLane = controlLane
	}
	if timeoutSeconds, ok := numberValue(rawRole["down_read_timeout_seconds"]); ok && timeoutSeconds > 0 {
		t.downReadTimeout = time.Duration(timeoutSeconds * float64(time.Second))
	}
	if rawUploads, ok := rawRole["upload_profiles"].(map[string]interface{}); ok {
		for lane, value := range rawUploads {
			raw, ok := value.(map[string]interface{})
			if !ok {
				continue
			}
			profile := t.uploadProfile(lane)
			if maxBytes, ok := numberValue(raw["max_batch_bytes"]); ok && maxBytes > 0 {
				profile.maxBatchBytes = int(maxBytes)
			}
			if flushSeconds, ok := numberValue(raw["flush_delay_seconds"]); ok && flushSeconds >= 0 {
				profile.flushDelay = time.Duration(flushSeconds * float64(time.Second))
			}
			t.uploadProfiles[lane] = profile
		}
	}
	if maxFrame, ok := numberValue(capabilities["max_frame_payload_bytes"]); ok && maxFrame > 0 {
		t.cfg.MaxFramePayloadBytes = int(maxFrame)
	}
	if t.collapseDataLanes && t.downLanes[LaneData] {
		t.upWorkers[LaneData] = max2i(2, t.upWorkers[LaneData])
	}
	return nil
}

func (t *laneTransport) applyConfigOverrides() {
	if len(t.cfg.DownLanes) > 0 {
		t.downLanes = make(map[string]bool, len(t.cfg.DownLanes))
		for _, lane := range t.cfg.DownLanes {
			lane = strings.TrimSpace(lane)
			if lane != "" {
				t.downLanes[lane] = true
			}
		}
	}
	for lane, workers := range t.cfg.DownParallelism {
		if workers < 1 {
			workers = 1
		}
		t.downParallelism[lane] = workers
	}
	for lane, workers := range t.cfg.UpWorkers {
		if workers < 1 {
			workers = 1
		}
		t.upWorkers[lane] = workers
	}
	for lane, override := range t.cfg.UploadProfiles {
		profile := t.uploadProfile(lane)
		if override.MaxBatchBytes > 0 {
			profile.maxBatchBytes = override.MaxBatchBytes
		}
		if override.FlushDelaySeconds != nil && *override.FlushDelaySeconds >= 0 {
			profile.flushDelay = time.Duration(*override.FlushDelaySeconds * float64(time.Second))
		}
		t.uploadProfiles[lane] = profile
	}
}

func stringSlice(value interface{}) []string {
	raw, ok := value.([]interface{})
	if !ok {
		return nil
	}
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		text := strings.TrimSpace(fmt.Sprint(item))
		if text != "" {
			values = append(values, text)
		}
	}
	return values
}

func stringMap(value interface{}) map[string]string {
	raw, ok := value.(map[string]interface{})
	if !ok {
		return nil
	}
	values := make(map[string]string)
	for key, item := range raw {
		text := strings.TrimSpace(fmt.Sprint(item))
		if strings.TrimSpace(key) != "" && text != "" {
			values[strings.TrimSpace(key)] = text
		}
	}
	return values
}

func parseIntMap(raw map[string]interface{}, minimum int) map[string]int {
	values := make(map[string]int)
	for key, value := range raw {
		number, ok := numberValue(value)
		if !ok {
			continue
		}
		parsed := int(number)
		if parsed < minimum {
			parsed = minimum
		}
		values[key] = parsed
	}
	return values
}

func numberValue(value interface{}) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

func hasString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sortedLaneKeys(values map[string]bool) []string {
	lanes := make([]string, 0, len(values))
	for lane, enabled := range values {
		if enabled {
			lanes = append(lanes, lane)
		}
	}
	return lanes
}

// externalLanes returns the lanes that have their own UP/DOWN goroutines.
// With collapseDataLanes=true, pri+bulk are merged into the data lane.
func (t *laneTransport) externalLanes() []string {
	if t.collapseDataLanes {
		return []string{LaneCTL, LaneData}
	}
	return allLanes
}

func (t *laneTransport) start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	t.ctx, t.cancel = context.WithCancel(ctx)
	if err := t.applyBrokerCapabilities(t.ctx); err != nil {
		return err
	}
	t.applyConfigOverrides()
	t.adaptiveUpload = newAdaptiveUploadController(t.cfg.AdaptiveUpload, t.upWorkers, t.uploadProfiles)
	log.Printf("[transport] role=%s effective down_lanes=%v down_parallelism=%v up_workers=%v data_upload_profile=%+v adaptive_upload=%s",
		t.role, sortedLaneKeys(t.downLanes), t.downParallelism, t.upWorkers, t.uploadProfiles[LaneData], t.adaptiveUpload.describe())
	for _, lane := range t.externalLanes() {
		lane := lane
		upWorkers := t.uploadWorkerLimit(lane)
		if upWorkers < 1 {
			upWorkers = 1
		}
		for i := 0; i < upWorkers; i++ {
			workerIdx := i
			t.wg.Add(1)
			go func() {
				defer t.wg.Done()
				t.upLoop(lane, workerIdx)
			}()
		}
	}
	for lane := range t.downLanes {
		lane := lane
		workers := t.downParallelism[lane]
		if workers < 1 {
			workers = 1
		}
		for i := 0; i < workers; i++ {
			i := i
			t.wg.Add(1)
			go func() {
				defer t.wg.Done()
				t.downLoop(lane, i)
			}()
		}
	}
	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		t.pingLoop()
	}()
	return nil
}

func (t *laneTransport) stop() {
	t.stopOnce.Do(func() {
		if t.cancel != nil {
			t.cancel()
		}
		close(t.stopCh)
		t.clientMu.Lock()
		for _, client := range t.clients {
			client.CloseIdleConnections()
		}
		t.clients = make(map[string]*http.Client)
		t.clientMu.Unlock()
	})
	t.wg.Wait()
}

func (t *laneTransport) sendFrame(lane string, f *Frame) error {
	// With collapseDataLanes, pri and bulk both route to the data queue.
	// DATA frames get their FlagDataBulk bit set/cleared to preserve lane identity,
	// matching Python LaneTransport.send_frame collapse logic.
	if t.collapseDataLanes && (lane == LanePRI || lane == LaneBulk) {
		if f.TypeID == FrameData {
			newFlags := f.Flags
			if lane == LaneBulk {
				newFlags |= FlagDataBulk
			} else {
				newFlags &^= FlagDataBulk
			}
			f = &Frame{TypeID: f.TypeID, Flags: newFlags, StreamID: f.StreamID, Offset: f.Offset, Payload: f.Payload}
		}
		return t.enqueueFrame(t.dataQueue, f)
	}
	ch := t.queues[lane]
	if ch == nil {
		return fmt.Errorf("unknown lane %s", lane)
	}
	return t.enqueueFrame(ch, f)
}

func (t *laneTransport) enqueueFrame(ch chan *Frame, f *Frame) error {
	timeout := t.sendQueueTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ch <- f:
		return nil
	case <-t.stopCh:
		return context.Canceled
	case <-timer.C:
		return fmt.Errorf("transport send queue full after %v", timeout)
	}
}

// ---- UP loop ---------------------------------------------------------------

func (t *laneTransport) upLoop(lane string, workerIdx int) {
	for {
		if !t.waitUploadWorkerActive(lane, workerIdx) {
			return
		}
		batch, batchBytes := t.collectBatch(lane)
		if batch == nil {
			return // stopped
		}

		// Encrypt: prepend 16-byte random IV then AES-256-CTR encrypt.
		iv := make([]byte, 16)
		rand.Read(iv) //nolint:errcheck
		cipher := newTransportCipherSuite(t.cipherSuite, []byte(t.token), iv)
		plain := encodeBatch(batch)
		body := make([]byte, 16+len(plain))
		copy(body[:16], iv)
		cipher.process(body[16:], plain)

		client := t.getClient(lane, "up", 0)
		reqURL := t.routes.laneURL(lane, "up")
		headers := buildConnectionHeaders(t.token, t.role, t.peerLabel, t.peerSessionID, t.userAgent, t.cfg)
		headers["X-Twoman-Cipher"] = t.cipherSuite
		requestBody := body
		if t.uploadBodyMode == "multipart" {
			multipartBody, contentType := wrapMultipart(body, t.uploadFilename)
			requestBody = multipartBody
			headers["Content-Type"] = contentType
		} else {
			headers["Content-Type"] = t.cfg.BinaryMediaType
		}

		err := t.doPost(client, reqURL, headers, requestBody, t.httpTimeout)
		if err != nil {
			t.markUploadError(lane)
			t.requeue(lane, batch)
			t.resetClient(lane, "up", 0)
			delay := t.backoff("up", lane)
			if delay > 0 {
				log.Printf("[transport] up error lane=%s delay=%v err=%v", lane, delay, err)
			}
			select {
			case <-time.After(delay):
			case <-t.stopCh:
				return
			}
		} else {
			t.markSuccess("up", lane)
			t.markUploadSuccess(lane, batchBytes)
		}
	}
}

func encodeBatch(frames []*Frame) []byte {
	total := 0
	for _, f := range frames {
		total += wireSize(f)
	}
	buf := make([]byte, total)
	offset := 0
	for _, f := range frames {
		offset += writeFrameInto(buf[offset:], f)
	}
	return buf
}

func writeFrameInto(dst []byte, f *Frame) int {
	payload := f.Payload
	dst[0] = f.TypeID
	dst[1] = f.Flags
	dst[2] = 0
	dst[3] = 0
	binary.BigEndian.PutUint32(dst[4:8], f.StreamID)
	binary.BigEndian.PutUint64(dst[8:16], f.Offset)
	binary.BigEndian.PutUint32(dst[16:20], uint32(len(payload)))
	copy(dst[20:], payload)
	return frameHeaderSize + len(payload)
}

// wireSize returns the encoded byte size of a frame without allocating.
func wireSize(f *Frame) int {
	return frameHeaderSize + len(f.Payload)
}

// collectBatch blocks until at least one frame is available on lane,
// then accumulates frames until the batch budget or flush timeout expires.
func (t *laneTransport) collectBatch(lane string) ([]*Frame, int) {
	var ch chan *Frame
	if t.collapseDataLanes && lane == LaneData {
		ch = t.dataQueue
	} else {
		ch = t.queues[lane]
	}
	profile := t.uploadProfile(lane)

	// Drain replays first (frames that failed and need retry).
	if f := t.popReplay(lane); f != nil {
		batch := []*Frame{f}
		total := wireSize(f)
		// Try to top-up without blocking.
		for total < profile.maxBatchBytes {
			g := t.popReplay(lane)
			if g == nil {
				break
			}
			sz := wireSize(g)
			if total+sz > profile.maxBatchBytes {
				t.pushReplayFront(lane, g)
				break
			}
			batch = append(batch, g)
			total += sz
		}
		return batch, total
	}

	// Wait for first frame.
	var first *Frame
	select {
	case first = <-ch:
	case <-t.stopCh:
		return nil, 0
	}

	batch := []*Frame{first}
	total := wireSize(first)

	if profile.flushDelay <= 0 || total >= profile.maxBatchBytes {
		return batch, total
	}

	// Use a single timer for the whole flush window — avoids creating a new
	// channel + goroutine on every loop iteration with time.After.
	timer := time.NewTimer(profile.flushDelay)
	defer timer.Stop()
	for total < profile.maxBatchBytes {
		select {
		case f := <-ch:
			sz := wireSize(f)
			if total+sz > profile.maxBatchBytes {
				t.pushReplayFront(lane, f)
				goto done
			}
			batch = append(batch, f)
			total += sz
		case <-timer.C:
			goto done
		case <-t.stopCh:
			return batch, total
		}
	}
done:
	return batch, total
}

func (t *laneTransport) doPost(client *http.Client, reqURL string, headers map[string]string, body []byte, timeout time.Duration) error {
	baseCtx := t.ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(baseCtx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodySnip, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("server returned %d: %s", resp.StatusCode, bodySnip)
	}
	// Validate JSON ack {"ok": true}
	var ack map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&ack); err != nil {
		return fmt.Errorf("invalid ack: %v", err)
	}
	if ok, _ := ack["ok"].(bool); !ok {
		return fmt.Errorf("server ack ok=false: %v", ack)
	}
	return nil
}

// ---- DOWN loop -------------------------------------------------------------

func (t *laneTransport) downLoop(lane string, workerIdx int) {
	for {
		select {
		case <-t.stopCh:
			return
		default:
		}

		err := t.doDownSession(lane, workerIdx)
		if err != nil {
			t.resetClient(lane, "down", workerIdx)
			delay := t.backoff("down", lane)
			if delay > 0 {
				log.Printf("[transport] down error lane=%s worker=%d delay=%v err=%v", lane, workerIdx, delay, err)
			}
			select {
			case <-time.After(delay):
			case <-t.stopCh:
				return
			}
		}
	}
}

// doDownSession runs one streaming GET session. It returns when the session
// ends (EOF, rotation, error) so downLoop can reconnect.
func (t *laneTransport) doDownSession(lane string, workerIdx int) error {
	buf := make([]byte, downReadBufferSize)
	client := t.getClient(lane, "down", workerIdx)
	reqURL := t.routes.laneURL(lane, "down")
	headers := buildConnectionHeaders(t.token, t.role, t.peerLabel, t.peerSessionID, t.userAgent, t.cfg)
	if lane == LaneData {
		for k, v := range buildDownloadHeaders(t.userAgent, t.cfg.BrokerBaseURL, t.uploadFilename) {
			headers[k] = v
		}
	}
	headers["X-Twoman-Cipher"] = t.cipherSuite

	baseCtx := t.ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	reqCtx, cancel := context.WithTimeout(baseCtx, t.downRequestTimeout())
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, "GET", reqURL, nil)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 204 {
		return nil // idle — poll again
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		io.Copy(io.Discard, resp.Body) //nolint:errcheck
		return fmt.Errorf("down status %d", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "application/json") {
		// Error JSON from server
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body) //nolint:errcheck
		return fmt.Errorf("down json response: %v", body)
	}

	t.markSuccess("down", lane)

	// --- Streaming decrypt + frame decode ---
	var cipher transportCipher
	var ivBuf []byte
	decoder := newFrameDecoder(t.cfg.MaxFramePayloadBytes)
	sessionStart := time.Now()
	var sawNonPing bool

	bodyReader := resp.Body
	// Optional read deadline wrapper
	if t.downReadTimeout > 0 {
		bodyReader = &deadlineReader{r: resp.Body, timeout: t.downReadTimeout}
	}

	for {
		// Session rotation
		if t.downStreamMaxSession > 0 && time.Since(sessionStart) >= t.downStreamMaxSession {
			return nil // rotate — reconnect
		}

		n, readErr := bodyReader.Read(buf)
		if n > 0 {
			chunk := buf[:n]

			// Peel the 16-byte IV from the front of the stream.
			if cipher == nil {
				need := 16 - len(ivBuf)
				if need > len(chunk) {
					ivBuf = append(ivBuf, chunk...)
					chunk = nil
				} else {
					ivBuf = append(ivBuf, chunk[:need]...)
					chunk = chunk[need:]
					cipher = newTransportCipherSuite(t.cipherSuite, []byte(t.token), ivBuf)
				}
			}

			if cipher != nil && len(chunk) > 0 {
				// Decrypt in-place — no allocation in the hot path.
				cipher.processInPlace(chunk)
				frames, err := decoder.feed(chunk)
				if err != nil {
					return err
				}
				for _, f := range frames {
					if f.TypeID != FramePing {
						sawNonPing = true
					}
					t.onFrame(f, lane)
				}
			}
		}

		if readErr != nil {
			if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
				_ = sawNonPing
				return nil
			}
			return readErr
		}
	}
}

// ---- Ping loop -------------------------------------------------------------

func (t *laneTransport) pingLoop() {
	for {
		interval := t.jitteredInterval(time.Duration(t.cfg.HeartbeatIntervalSeconds * float64(time.Second)))
		select {
		case <-time.After(interval):
		case <-t.stopCh:
			return
		}
		t.sendFrame(LaneCTL, &Frame{
			TypeID: FramePing,
			Offset: uint64(time.Now().UnixMilli()),
		})
	}
}

// ---- Client management -----------------------------------------------------

func (t *laneTransport) clientKey(lane, direction string, workerIdx int) string {
	if workerIdx == 0 {
		return lane + "/" + direction
	}
	return fmt.Sprintf("%s/%s/%d", lane, direction, workerIdx)
}

func (t *laneTransport) getClient(lane, direction string, workerIdx int) *http.Client {
	key := t.clientKey(lane, direction, workerIdx)
	t.clientMu.Lock()
	defer t.clientMu.Unlock()
	if c, ok := t.clients[key]; ok {
		return c
	}
	c := t.buildHTTPClient(lane, direction)
	t.clients[key] = c
	return c
}

func (t *laneTransport) resetClient(lane, direction string, workerIdx int) {
	key := t.clientKey(lane, direction, workerIdx)
	t.clientMu.Lock()
	defer t.clientMu.Unlock()
	if old, ok := t.clients[key]; ok {
		old.CloseIdleConnections()
		delete(t.clients, key)
	}
}

func (t *laneTransport) buildHTTPClient(lane, direction string) *http.Client {
	useHTTP2 := false
	switch lane {
	case LaneCTL:
		useHTTP2 = t.cfg.http2CtlEnabled
	case LaneData:
		useHTTP2 = t.cfg.http2DataEnabled
	}

	baseDialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	tr := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     120 * time.Second,
		TLSHandshakeTimeout: t.tlsHandshakeTimeout(),
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: !t.cfg.VerifyTLS},
		DialContext:         baseDialer.DialContext,
		DisableKeepAlives:   false,
		DisableCompression:  true, // we request identity encoding; prevent accidental gzip decode of binary payloads
		ForceAttemptHTTP2:   useHTTP2,
	}
	if !useHTTP2 {
		// Disable HTTP/2 by removing the upgrade handler.
		tr.TLSNextProto = make(map[string]func(string, *tls.Conn) http.RoundTripper)
	}

	if t.cfg.UpstreamProxyURL != "" {
		proxyURL, err := url.Parse(t.cfg.UpstreamProxyURL)
		if err == nil && (proxyURL.Scheme == "http" || proxyURL.Scheme == "https") {
			tr.Proxy = http.ProxyURL(proxyURL)
		} else if dialContext, ok, err := newProxyDialContext(t.cfg.UpstreamProxyURL, baseDialer); err != nil {
			log.Printf("[transport] ignoring invalid upstream proxy URL: %v", err)
		} else if ok {
			tr.DialContext = dialContext
		}
	}
	if direction == "down" {
		tr.ResponseHeaderTimeout = t.downResponseHeaderTimeout()
		if t.cfg.UpstreamProxyURL != "" {
			// WARP/WireProxy can leave dead local SOCKS connections half-closed.
			// Down-polls are latency-sensitive and cheap, so do not reuse proxied
			// sockets here; uploads still keep their pooling for throughput.
			tr.DisableKeepAlives = true
			tr.MaxIdleConnsPerHost = 0
			tr.IdleConnTimeout = 0
		}
	}

	timeout := http.DefaultClient.Timeout
	if direction == "down" {
		// No overall timeout for streaming — we use the deadlineReader instead.
		timeout = 0
	} else {
		timeout = t.httpTimeout
	}
	return &http.Client{Transport: tr, Timeout: timeout}
}

func (t *laneTransport) downResponseHeaderTimeout() time.Duration {
	timeout := t.downReadTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	if timeout < 5*time.Second {
		timeout = 5 * time.Second
	}
	return timeout
}

func (t *laneTransport) tlsHandshakeTimeout() time.Duration {
	timeout := time.Duration(t.cfg.TLSHandshakeTimeoutSeconds * float64(time.Second))
	if timeout <= 0 {
		return 15 * time.Second
	}
	if timeout < time.Second {
		return time.Second
	}
	return timeout
}

func (t *laneTransport) downRequestTimeout() time.Duration {
	headerTimeout := t.downResponseHeaderTimeout()
	bodyTimeout := t.downReadTimeout
	if bodyTimeout <= 0 {
		bodyTimeout = 10 * time.Second
	}
	sessionTimeout := t.downStreamMaxSession
	if sessionTimeout <= 0 {
		sessionTimeout = 60 * time.Second
	}
	return headerTimeout + bodyTimeout + sessionTimeout + 5*time.Second
}

// ---- Replay queue ----------------------------------------------------------

func (t *laneTransport) popReplay(lane string) *Frame {
	t.replayMu.Lock()
	defer t.replayMu.Unlock()
	rq := t.replayQueues[lane]
	if len(rq) == 0 {
		return nil
	}
	f := rq[0]
	t.replayQueues[lane] = rq[1:]
	return f
}

func (t *laneTransport) pushReplayFront(lane string, f *Frame) {
	t.replayMu.Lock()
	defer t.replayMu.Unlock()
	t.replayQueues[lane] = append([]*Frame{f}, t.replayQueues[lane]...)
}

func (t *laneTransport) requeue(lane string, frames []*Frame) {
	if len(frames) == 0 {
		return
	}
	retriable := make([]*Frame, 0, len(frames))
	for _, frame := range frames {
		if frame.TypeID == FrameData || frame.TypeID == FramePing {
			retriable = append(retriable, frame)
		}
	}
	if len(retriable) == 0 {
		return
	}
	t.replayMu.Lock()
	defer t.replayMu.Unlock()
	t.replayQueues[lane] = append(retriable, t.replayQueues[lane]...)
}

// ---- Backoff / jitter ------------------------------------------------------

func (t *laneTransport) markSuccess(dir, lane string) {
	t.failMu.Lock()
	delete(t.failCount, dir+"/"+lane)
	t.failMu.Unlock()
}

func (t *laneTransport) backoff(dir, lane string) time.Duration {
	key := dir + "/" + lane
	t.failMu.Lock()
	t.failCount[key]++
	failures := t.failCount[key]
	t.failMu.Unlock()

	exp := failures - 2 // first free_failures=1 is free
	if exp <= 0 {
		return 0
	}
	ceiling := t.backoffMaxDelay
	if exp < 20 {
		ceiling = time.Duration(math.Min(
			float64(t.backoffMaxDelay),
			float64(t.backoffInitialDelay)*math.Pow(2, float64(exp-1)),
		))
	}
	// jitter in [0, ceiling]
	return time.Duration(t.randFloat64() * float64(ceiling))
}

func (t *laneTransport) jitteredInterval(base time.Duration) time.Duration {
	ratio := t.intervalJitterRatio
	if ratio <= 0 {
		return base
	}
	delta := float64(base) * ratio
	lo := float64(base) - delta
	hi := float64(base) + delta
	return time.Duration(lo + t.randFloat64()*(hi-lo))
}

func (t *laneTransport) randFloat64() float64 {
	t.rngMu.Lock()
	defer t.rngMu.Unlock()
	return t.rng.Float64()
}

// ---- Helpers ---------------------------------------------------------------

func (t *laneTransport) uploadProfile(lane string) uploadProfile {
	if p, ok := t.uploadProfiles[lane]; ok {
		return t.adaptiveUpload.applyProfile(lane, p)
	}
	return t.adaptiveUpload.applyProfile(lane, uploadProfile{maxBatchBytes: t.maxBatchBytes, flushDelay: t.flushDelay})
}

func (t *laneTransport) uploadWorkerLimit(lane string) int {
	workers := t.upWorkers[lane]
	if workers < 1 {
		workers = 1
	}
	return t.adaptiveUpload.maxWorkers(lane, workers)
}

func (t *laneTransport) waitUploadWorkerActive(lane string, workerIdx int) bool {
	for {
		if t.adaptiveUpload.workerActive(lane, workerIdx) {
			return true
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-timer.C:
		case <-t.stopCh:
			timer.Stop()
			return false
		}
	}
}

func (t *laneTransport) markUploadSuccess(lane string, batchBytes int) {
	t.adaptiveUpload.markSuccess(lane, t.uploadBacklogFrames(lane), batchBytes)
}

func (t *laneTransport) markUploadError(lane string) {
	t.adaptiveUpload.markError(lane)
}

func (t *laneTransport) uploadBacklogFrames(lane string) int {
	backlog := 0
	if t.collapseDataLanes && lane == LaneData {
		backlog += len(t.dataQueue)
	} else if ch := t.queues[lane]; ch != nil {
		backlog += len(ch)
	}
	t.replayMu.Lock()
	backlog += len(t.replayQueues[lane])
	t.replayMu.Unlock()
	return backlog
}

func min2(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
func max2(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
func min2i(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func max2i(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// deadlineReader wraps an io.Reader and returns a timeout error if a single
// Read call takes longer than timeout.
type deadlineReader struct {
	r       io.ReadCloser
	timeout time.Duration
}

func (d *deadlineReader) Read(p []byte) (int, error) {
	type result struct {
		n   int
		err error
	}
	ch := make(chan result, 1)
	go func() {
		n, err := d.r.Read(p)
		ch <- result{n, err}
	}()
	select {
	case r := <-ch:
		return r.n, r.err
	case <-time.After(d.timeout):
		// Close the underlying body — this unblocks the goroutine above so it
		// exits immediately instead of leaking and writing into a stale buffer.
		d.r.Close()
		<-ch // drain to avoid the goroutine staying alive
		return 0, fmt.Errorf("read timeout after %v", d.timeout)
	}
}

func (d *deadlineReader) Close() error {
	return d.r.Close()
}

// atomic counter for stream IDs (odd numbers, matching Python behaviour)
var globalStreamIDCounter uint32

func nextStreamID() uint32 {
	for {
		v := atomic.AddUint32(&globalStreamIDCounter, 2)
		if v > 0 {
			return v
		}
	}
}

func init() {
	// Seed with random odd number matching Python: seed | 1
	var b [4]byte
	rand.Read(b[:]) //nolint:errcheck
	seed := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])) & 0x7FFFFFFF
	seed |= 1
	atomic.StoreUint32(&globalStreamIDCounter, seed)
}
