package main

import (
	"testing"
	"time"
)

func TestRequeueRetriesOnlyIdempotentFrames(t *testing.T) {
	tp := newLaneTransport(&Config{}, "helper", "peer", func(*Frame, string) {})
	tp.requeue(LaneData, []*Frame{
		{TypeID: FrameOpen, StreamID: 1},
		{TypeID: FrameWindow, StreamID: 1},
		{TypeID: FrameFIN, StreamID: 1},
		{TypeID: FrameRST, StreamID: 1},
		{TypeID: FrameData, StreamID: 1, Payload: []byte("data")},
		{TypeID: FramePing},
	})

	first := tp.popReplay(LaneData)
	second := tp.popReplay(LaneData)
	third := tp.popReplay(LaneData)

	if first == nil || first.TypeID != FrameData {
		t.Fatalf("expected DATA replay first, got %#v", first)
	}
	if second == nil || second.TypeID != FramePing {
		t.Fatalf("expected PING replay second, got %#v", second)
	}
	if third != nil {
		t.Fatalf("expected only idempotent replay frames, got %#v", third)
	}
}

func TestApplyTransportProfileUsesRoleSpecificCapabilities(t *testing.T) {
	cfg := &Config{}
	cfg.SetDefaults()
	tp := newLaneTransport(cfg, "agent", "peer", func(*Frame, string) {})
	capabilities := map[string]interface{}{
		"max_frame_payload_bytes": float64(12345),
		"profiles": map[string]interface{}{
			"managed_host_http": map[string]interface{}{
				"agent": map[string]interface{}{
					"down_lanes":                []interface{}{"data"},
					"down_parallelism":          map[string]interface{}{"data": float64(3)},
					"up_workers":                map[string]interface{}{"data": float64(5)},
					"stream_control_lane":       "pri",
					"down_read_timeout_seconds": float64(22),
					"upload_profiles": map[string]interface{}{
						"data": map[string]interface{}{
							"max_batch_bytes":     float64(262144),
							"flush_delay_seconds": float64(0.002),
						},
					},
				},
			},
		},
	}

	if err := tp.applyTransportProfile(capabilities, "managed_host_http"); err != nil {
		t.Fatal(err)
	}
	if !tp.downLanes[LaneData] || tp.downLanes[LaneCTL] {
		t.Fatalf("unexpected down lanes: %#v", tp.downLanes)
	}
	if tp.downParallelism[LaneData] != 3 {
		t.Fatalf("unexpected data parallelism: %#v", tp.downParallelism)
	}
	if tp.upWorkers[LaneData] != 5 {
		t.Fatalf("unexpected up workers: %#v", tp.upWorkers)
	}
	if tp.streamControlLane != LanePRI {
		t.Fatalf("unexpected control lane: %s", tp.streamControlLane)
	}
	if tp.cfg.MaxFramePayloadBytes != 12345 {
		t.Fatalf("frame limit not applied: %d", tp.cfg.MaxFramePayloadBytes)
	}
	if tp.uploadProfiles[LaneData].maxBatchBytes != 262144 {
		t.Fatalf("upload profile not applied: %#v", tp.uploadProfiles[LaneData])
	}
	if tp.uploadProfiles[LaneData].flushDelay != 2*time.Millisecond {
		t.Fatalf("flush delay not applied: %v", tp.uploadProfiles[LaneData].flushDelay)
	}
}

func TestConfigOverridesTransportProfileForBenchmarkTuning(t *testing.T) {
	flushDelay := 0.003
	cfg := &Config{
		UploadProfiles: map[string]UploadProfileOverride{
			LaneData: {
				MaxBatchBytes:     524288,
				FlushDelaySeconds: &flushDelay,
			},
		},
		UpWorkers:       map[string]int{LaneData: 4},
		DownParallelism: map[string]int{LaneData: 3},
		DownLanes:       []string{LaneData},
	}
	cfg.SetDefaults()
	tp := newLaneTransport(cfg, "agent", "peer", func(*Frame, string) {})
	if err := tp.applyTransportProfile(map[string]interface{}{
		"profiles": map[string]interface{}{
			"managed_host_http": map[string]interface{}{
				"agent": map[string]interface{}{
					"down_lanes":       []interface{}{LaneCTL, LaneData},
					"down_parallelism": map[string]interface{}{LaneData: float64(2)},
					"upload_profiles": map[string]interface{}{
						LaneData: map[string]interface{}{"max_batch_bytes": float64(131072)},
					},
				},
			},
		},
	}, "managed_host_http"); err != nil {
		t.Fatal(err)
	}

	tp.applyConfigOverrides()

	if tp.downLanes[LaneCTL] || !tp.downLanes[LaneData] {
		t.Fatalf("unexpected down lanes after override: %#v", tp.downLanes)
	}
	if tp.downParallelism[LaneData] != 3 {
		t.Fatalf("unexpected down parallelism after override: %#v", tp.downParallelism)
	}
	if tp.upWorkers[LaneData] != 4 {
		t.Fatalf("unexpected up workers after override: %#v", tp.upWorkers)
	}
	if tp.uploadProfiles[LaneData].maxBatchBytes != 524288 {
		t.Fatalf("unexpected data batch after override: %#v", tp.uploadProfiles[LaneData])
	}
	if tp.uploadProfiles[LaneData].flushDelay != 3*time.Millisecond {
		t.Fatalf("unexpected data flush after override: %v", tp.uploadProfiles[LaneData].flushDelay)
	}
}

func TestAdaptiveUploadControllerBoundsWorkersAndBatch(t *testing.T) {
	cfg := &Config{
		AdaptiveUpload: AdaptiveUploadConfig{
			Enabled:                 true,
			Lanes:                   []string{LaneData},
			MinWorkers:              2,
			InitialWorkers:          4,
			MaxWorkers:              6,
			MinBatchBytes:           262144,
			MaxBatchBytes:           1048576,
			IncreaseAfterSuccesses:  2,
			DecreaseAfterErrors:     1,
			BacklogThresholdFrames:  1,
			DecisionIntervalSeconds: 0,
		},
	}
	cfg.SetDefaults()
	tp := newLaneTransport(cfg, "helper", "peer", func(*Frame, string) {})
	tp.upWorkers[LaneData] = 4
	tp.uploadProfiles[LaneData] = uploadProfile{maxBatchBytes: 524288, flushDelay: time.Millisecond}
	tp.adaptiveUpload = newAdaptiveUploadController(cfg.AdaptiveUpload, tp.upWorkers, tp.uploadProfiles)

	if got := tp.uploadWorkerLimit(LaneData); got != 6 {
		t.Fatalf("expected adaptive worker limit 6, got %d", got)
	}
	if !tp.adaptiveUpload.workerActive(LaneData, 3) {
		t.Fatal("expected initial worker index 3 to be active")
	}
	if tp.adaptiveUpload.workerActive(LaneData, 4) {
		t.Fatal("expected worker index 4 to start inactive")
	}
	if got := tp.uploadProfile(LaneData).maxBatchBytes; got != 524288 {
		t.Fatalf("expected initial adaptive batch 524288, got %d", got)
	}

	tp.adaptiveUpload.markSuccess(LaneData, 2, 524288)
	if tp.adaptiveUpload.workerActive(LaneData, 4) {
		t.Fatal("expected one success below threshold to keep worker index 4 inactive")
	}
	tp.adaptiveUpload.markSuccess(LaneData, 2, 524288)
	if !tp.adaptiveUpload.workerActive(LaneData, 4) {
		t.Fatal("expected second backlogged success to activate worker index 4")
	}

	tp.adaptiveUpload.markError(LaneData)
	if tp.adaptiveUpload.workerActive(LaneData, 4) {
		t.Fatal("expected error to reduce active workers")
	}
	if got := tp.uploadProfile(LaneData).maxBatchBytes; got != 262144 {
		t.Fatalf("expected error to reduce batch to floor, got %d", got)
	}
}

func TestAdaptiveUploadDisabledKeepsFixedWorkersAndProfile(t *testing.T) {
	cfg := &Config{}
	cfg.SetDefaults()
	tp := newLaneTransport(cfg, "helper", "peer", func(*Frame, string) {})
	tp.upWorkers[LaneData] = 8
	tp.uploadProfiles[LaneData] = uploadProfile{maxBatchBytes: 524288, flushDelay: time.Millisecond}

	if got := tp.uploadWorkerLimit(LaneData); got != 8 {
		t.Fatalf("expected fixed worker count 8, got %d", got)
	}
	if got := tp.uploadProfile(LaneData).maxBatchBytes; got != 524288 {
		t.Fatalf("expected fixed batch 524288, got %d", got)
	}
}

func TestSelectCipherSuitePrefersAESWhenBrokerAdvertisesIt(t *testing.T) {
	cipher := selectCipherSuite(map[string]interface{}{
		"cipher_suites": []interface{}{cipherSuiteHMACSHA256CTR, cipherSuiteAES256CTR},
	})
	if cipher != cipherSuiteAES256CTR {
		t.Fatalf("expected AES suite, got %s", cipher)
	}
}

func TestGrantWindowDoesNotFlushImmediatelyOnZeroDeadline(t *testing.T) {
	cfg := &Config{}
	cfg.SetDefaults()
	rt, err := newHelperRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	stream := newProxyStream(17, "example.com", 443, rt)

	stream.grantWindow(1)
	select {
	case frame := <-rt.transport.queues[LaneCTL]:
		t.Fatalf("unexpected immediate WINDOW frame: %#v", frame)
	default:
	}

	select {
	case frame := <-rt.transport.queues[LaneCTL]:
		if frame.TypeID != FrameWindow || frame.Offset != 1 {
			t.Fatalf("unexpected delayed frame: %#v", frame)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("expected delayed WINDOW frame")
	}
}
