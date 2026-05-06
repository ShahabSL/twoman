package main

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestFrameDecoderRejectsOversizedPayload(t *testing.T) {
	decoder := newFrameDecoder(8)
	header := make([]byte, frameHeaderSize)
	header[0] = FramePing
	binary.BigEndian.PutUint32(header[16:20], 64)

	frames, err := decoder.feed(header)
	if err == nil {
		t.Fatal("expected oversized frame error")
	}
	if frames != nil {
		t.Fatalf("expected no frames, got %d", len(frames))
	}
	if !strings.Contains(err.Error(), "frame payload too large") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFrameDecoderAcceptsFrameAtLimit(t *testing.T) {
	decoder := newFrameDecoder(4)
	frame := &Frame{TypeID: FramePing, Payload: []byte("test")}
	frames, err := decoder.feed(encodeFrame(frame))
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatalf("expected one frame, got %d", len(frames))
	}
	if string(frames[0].Payload) != "test" {
		t.Fatalf("unexpected payload: %q", frames[0].Payload)
	}
}

func TestOpenPayloadCarriesOptionalTargetAgent(t *testing.T) {
	payload := makeOpenPayload("example.com", 443, "agent-nima")
	host, port, target, err := parseOpenPayloadWithTarget(payload)
	if err != nil {
		t.Fatal(err)
	}
	if host != "example.com" || port != 443 || target != "agent-nima" {
		t.Fatalf("unexpected open payload: host=%q port=%d target=%q", host, port, target)
	}
}
