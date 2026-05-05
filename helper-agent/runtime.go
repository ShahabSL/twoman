package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// helperRuntime manages the transport, active streams, and DNS requests.
// It mirrors the Python HelperRuntime class.
type helperRuntime struct {
	cfg       *Config
	transport *laneTransport

	streamsMu sync.RWMutex
	streams   map[uint32]*ProxyStream

	// DNS request state
	dnsReqMu  sync.Mutex
	dnsReqs   map[uint32]chan dnsResult
	nextDNSID uint32

	// DNS cache
	cacheMu  sync.Mutex
	dnsCache map[string]dnsCacheEntry

	// DNS semaphore (max parallel DNS queries)
	dnsSem chan struct{}
}

type dnsResult struct {
	payload []byte
	err     error
}

type dnsCacheEntry struct {
	response  []byte
	expiresAt time.Time
}

func newHelperRuntime(cfg *Config) (*helperRuntime, error) {
	peerID := cfg.PeerID
	if peerID == "" {
		peerID = randomPeerID()
	}
	rt := &helperRuntime{
		cfg:      cfg,
		streams:  make(map[uint32]*ProxyStream),
		dnsReqs:  make(map[uint32]chan dnsResult),
		dnsCache: make(map[string]dnsCacheEntry),
		dnsSem:   make(chan struct{}, 8), // max 8 concurrent DNS queries
	}
	// Seed nextDNSID with a random even number (matching Python: dns_seed & 0x7FFFFFFE)
	var seed [4]byte
	if _, err := rand.Read(seed[:]); err == nil {
		rt.nextDNSID = binary.BigEndian.Uint32(seed[:]) & 0x7FFFFFFE
	}
	if rt.nextDNSID == 0 {
		rt.nextDNSID = 2
	}
	rt.transport = newLaneTransport(cfg, "helper", peerID, rt.onFrame)
	return rt, nil
}

func (rt *helperRuntime) start(ctx context.Context) error {
	return rt.transport.start(ctx)
}

func (rt *helperRuntime) stop() {
	rt.streamsMu.Lock()
	streams := make([]*ProxyStream, 0, len(rt.streams))
	for _, stream := range rt.streams {
		streams = append(streams, stream)
	}
	rt.streams = make(map[uint32]*ProxyStream)
	rt.streamsMu.Unlock()

	for _, stream := range streams {
		stream.reset("helper stopped")
	}
	if len(streams) > 0 {
		time.Sleep(250 * time.Millisecond)
	}
	rt.transport.stop()
}

// newStream allocates a new ProxyStream with the next odd stream ID.
func (rt *helperRuntime) newStream(host string, port uint16) *ProxyStream {
	id := nextStreamID()
	s := newProxyStream(id, host, port, rt)
	rt.streamsMu.Lock()
	rt.streams[id] = s
	rt.streamsMu.Unlock()
	return s
}

func (rt *helperRuntime) releaseStream(id uint32) {
	rt.streamsMu.Lock()
	delete(rt.streams, id)
	rt.streamsMu.Unlock()
}

// onFrame is the transport callback: dispatches incoming frames to the right stream.
func (rt *helperRuntime) onFrame(f *Frame, lane string) {
	// DNS response frames
	if f.TypeID == FrameDNSResponse || f.TypeID == FrameDNSFail {
		rt.dispatchDNSResponse(f)
		return
	}

	rt.streamsMu.RLock()
	s := rt.streams[f.StreamID]
	rt.streamsMu.RUnlock()
	if s == nil {
		return
	}
	s.onFrame(f)
}

// ---- DNS relay -------------------------------------------------------------

const (
	dnsQueryTimeout = 2500 * time.Millisecond
	dnsCacheTTL     = 60 * time.Second
	dnsCacheMaxSize = 256
	dnsTypeAAAA     = 28
	dnsTypeHTTPS    = 65
)

// resolveDNS sends a DNS query payload through the relay and returns the response.
// It handles caching, deduplication, and AAAA/HTTPS filtering.
func (rt *helperRuntime) resolveDNS(targetHost string, payload []byte) ([]byte, error) {
	txID := dnsTransactionID(payload)
	qtype := dnsQuestionType(payload)

	// Filter AAAA/HTTPS if vpn_prefer_ipv4
	if rt.cfg.VPNFilterAAAA || rt.cfg.VPNPreferIPv4 {
		if qtype == dnsTypeAAAA || qtype == dnsTypeHTTPS {
			return withDNSTransactionID(synthesizeEmptyDNSResponse(payload), txID), nil
		}
	}

	cacheKey := dnsCacheKey(payload)

	rt.cacheMu.Lock()
	if entry, ok := rt.dnsCache[cacheKey]; ok && time.Now().Before(entry.expiresAt) {
		rt.cacheMu.Unlock()
		return withDNSTransactionID(entry.response, txID), nil
	}
	rt.cacheMu.Unlock()

	// Enforce parallelism limit.
	select {
	case rt.dnsSem <- struct{}{}:
	case <-time.After(dnsQueryTimeout):
		return nil, errDNSTimeout
	}
	defer func() { <-rt.dnsSem }()

	response, err := rt.queryDNSTransport(targetHost, payload)
	if err != nil {
		return nil, err
	}

	rt.cacheMu.Lock()
	rt.expireDNSCache()
	rt.dnsCache[cacheKey] = dnsCacheEntry{
		response:  response,
		expiresAt: time.Now().Add(dnsCacheTTL),
	}
	rt.cacheMu.Unlock()

	return withDNSTransactionID(response, txID), nil
}

var errDNSTimeout = fmt.Errorf("dns query timeout")

// queryDNSTransport sends FRAME_DNS_QUERY via the relay and waits for the response.
func (rt *helperRuntime) queryDNSTransport(targetHost string, payload []byte) ([]byte, error) {
	reqID := rt.allocateDNSID()
	ch := make(chan dnsResult, 1)

	rt.dnsReqMu.Lock()
	rt.dnsReqs[reqID] = ch
	rt.dnsReqMu.Unlock()

	defer func() {
		rt.dnsReqMu.Lock()
		delete(rt.dnsReqs, reqID)
		rt.dnsReqMu.Unlock()
	}()

	framePayload, err := makeDNSQueryFramePayload(targetHost, payload)
	if err != nil {
		return nil, err
	}
	if err := rt.transport.sendFrame(LanePRI, &Frame{
		TypeID:   FrameDNSQuery,
		StreamID: reqID,
		Payload:  framePayload,
	}); err != nil {
		return nil, err
	}

	select {
	case result := <-ch:
		return result.payload, result.err
	case <-time.After(dnsQueryTimeout):
		return nil, errDNSTimeout
	}
}

func (rt *helperRuntime) dispatchDNSResponse(f *Frame) {
	rt.dnsReqMu.Lock()
	ch := rt.dnsReqs[f.StreamID]
	rt.dnsReqMu.Unlock()
	if ch == nil {
		return
	}
	if f.TypeID == FrameDNSResponse {
		select {
		case ch <- dnsResult{payload: f.Payload}:
		default:
		}
	} else {
		errMsg := parseErrorPayload(f.Payload)
		if errMsg == "" {
			errMsg = "dns query failed"
		}
		select {
		case ch <- dnsResult{err: fmt.Errorf("%s", errMsg)}:
		default:
		}
	}
}

func (rt *helperRuntime) allocateDNSID() uint32 {
	rt.dnsReqMu.Lock()
	defer rt.dnsReqMu.Unlock()
	id := rt.nextDNSID
	for rt.dnsReqs[id] != nil {
		id += 2
		if id > 0xFFFFFFFE {
			id = 2
		}
	}
	rt.nextDNSID = id + 2
	if rt.nextDNSID > 0xFFFFFFFE {
		rt.nextDNSID = 2
	}
	return id
}

func (rt *helperRuntime) expireDNSCache() {
	now := time.Now()
	for k, v := range rt.dnsCache {
		if now.After(v.expiresAt) {
			delete(rt.dnsCache, k)
		}
	}
	for len(rt.dnsCache) > dnsCacheMaxSize {
		for k := range rt.dnsCache {
			delete(rt.dnsCache, k)
			break
		}
	}
}

// ---- DNS wire helpers (mirror twoman_dns.py) --------------------------------

func dnsTransactionID(payload []byte) []byte {
	if len(payload) >= 2 {
		return append([]byte{}, payload[:2]...)
	}
	return []byte{0, 0}
}

func withDNSTransactionID(payload, txID []byte) []byte {
	if len(payload) < 2 || len(txID) != 2 {
		return payload
	}
	out := append([]byte{}, payload...)
	out[0] = txID[0]
	out[1] = txID[1]
	return out
}

func dnsCacheKey(payload []byte) string {
	if len(payload) < 2 {
		return string(payload)
	}
	return string(payload[2:])
}

func dnsQuestionType(payload []byte) uint16 {
	if len(payload) < 12 {
		return 0
	}
	qcount := binary.BigEndian.Uint16(payload[4:6])
	if qcount != 1 {
		return 0
	}
	idx := 12
	for {
		if idx >= len(payload) {
			return 0
		}
		labelLen := int(payload[idx])
		idx++
		if labelLen == 0 {
			break
		}
		if labelLen&0xC0 != 0 {
			return 0 // compressed
		}
		idx += labelLen
	}
	if idx+4 > len(payload) {
		return 0
	}
	return binary.BigEndian.Uint16(payload[idx : idx+2])
}

func synthesizeEmptyDNSResponse(payload []byte) []byte {
	if len(payload) < 12 {
		return payload
	}
	out := append([]byte{}, payload...)
	flags := binary.BigEndian.Uint16(out[2:4])
	respFlags := uint16(0x8000) | (flags & 0x7910) | 0x0080
	binary.BigEndian.PutUint16(out[2:4], respFlags)
	// Zero answer/authority/additional counts
	binary.BigEndian.PutUint16(out[6:8], 0)
	binary.BigEndian.PutUint16(out[8:10], 0)
	binary.BigEndian.PutUint16(out[10:12], 0)
	// Truncate to question section only
	return out[:12+questionSectionLen(payload)]
}

func questionSectionLen(payload []byte) int {
	idx := 12
	for idx < len(payload) {
		l := int(payload[idx])
		idx++
		if l == 0 {
			break
		}
		idx += l
	}
	if idx+4 <= len(payload) {
		idx += 4
	}
	return idx - 12
}

// ---- SOCKS UDP association UDP socket management ---------------------------

// socksUDPAssoc manages a local UDP socket for SOCKS5 UDP ASSOCIATE.
type socksUDPAssoc struct {
	rt         *helperRuntime
	conn       *net.UDPConn
	clientAddr *net.UDPAddr
	mu         sync.Mutex
	closed     int32
}

func newSocksUDPAssoc(rt *helperRuntime) (*socksUDPAssoc, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		return nil, err
	}
	a := &socksUDPAssoc{rt: rt, conn: conn}
	go a.readLoop()
	return a, nil
}

func (a *socksUDPAssoc) addr() *net.UDPAddr {
	return a.conn.LocalAddr().(*net.UDPAddr)
}

func (a *socksUDPAssoc) close() {
	atomic.StoreInt32(&a.closed, 1)
	a.conn.Close()
}

func (a *socksUDPAssoc) readLoop() {
	buf := make([]byte, 65535)
	for {
		n, addr, err := a.conn.ReadFromUDP(buf)
		if err != nil {
			if atomic.LoadInt32(&a.closed) != 0 {
				return
			}
			log.Printf("[udp-assoc] read error: %v", err)
			return
		}
		a.mu.Lock()
		if a.clientAddr == nil {
			a.clientAddr = addr
		}
		a.mu.Unlock()
		if n < 4 {
			continue
		}
		pkt := append([]byte{}, buf[:n]...)
		go a.handlePacket(pkt, addr)
	}
}

func (a *socksUDPAssoc) handlePacket(pkt []byte, addr *net.UDPAddr) {
	// SOCKS5 UDP packet: RSV(2) + FRAG(1) + ATYP(1) + ADDR + PORT(2) + DATA
	if len(pkt) < 4 || pkt[0] != 0 || pkt[1] != 0 || pkt[2] != 0 {
		return
	}
	host, port, payload, err := parseSocksUDPPacket(pkt)
	if err != nil || port != 53 || len(payload) == 0 {
		return
	}

	resp, err := a.rt.resolveDNS(host, payload)
	if err != nil {
		log.Printf("[udp-assoc] dns relay failed host=%s: %v", host, err)
		return
	}

	out := buildSocksUDPPacket(host, port, resp)
	a.conn.WriteToUDP(out, addr) //nolint:errcheck
}
