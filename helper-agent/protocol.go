package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
)

// Frame type IDs — must match twoman_protocol.py
const (
	FrameHello       uint8 = 1
	FrameHelloOK     uint8 = 2
	FrameOpen        uint8 = 3
	FrameOpenOK      uint8 = 4
	FrameOpenFail    uint8 = 5
	FrameData        uint8 = 6
	FrameWindow      uint8 = 7
	FrameFIN         uint8 = 8
	FrameRST         uint8 = 9
	FramePing        uint8 = 10
	FrameGoAway      uint8 = 11
	FrameDNSQuery    uint8 = 12
	FrameDNSResponse uint8 = 13
	FrameDNSFail     uint8 = 14
)

const (
	ModeTCP      uint8 = 1
	FlagNone     uint8 = 0
	FlagDataBulk uint8 = 1

	LaneCTL  = "ctl"
	LanePRI  = "pri"
	LaneBulk = "bulk"
	LaneData = "data"

	// FRAME_HEADER = struct.Struct("!BBH I Q I") → 1+1+2+4+8+4 = 20 bytes
	frameHeaderSize = 20

	initialWindow               = 16 * 1024 * 1024
	priLimit                    = 64 * 1024
	readChunkSize               = 128 * 1024
	downReadBufferSize          = 256 * 1024
	windowFlushBytes            = 512 * 1024
	maxReorderBytes             = 32 * 1024 * 1024
	defaultMaxFramePayloadBytes = 2 * 1024 * 1024
)

var allLanes = []string{LaneCTL, LanePRI, LaneBulk}

// Frame mirrors the Python Frame dataclass.
type Frame struct {
	TypeID   uint8
	Flags    uint8
	StreamID uint32
	Offset   uint64
	Payload  []byte
}

// encodeFrame serialises a Frame into the on-wire big-endian format.
// Layout: type(1) flags(1) reserved(2) stream_id(4) offset(8) length(4) payload(N)
func encodeFrame(f *Frame) []byte {
	p := f.Payload
	buf := make([]byte, frameHeaderSize+len(p))
	buf[0] = f.TypeID
	buf[1] = f.Flags
	// buf[2:4] = reserved = 0
	binary.BigEndian.PutUint32(buf[4:8], f.StreamID)
	binary.BigEndian.PutUint64(buf[8:16], f.Offset)
	binary.BigEndian.PutUint32(buf[16:20], uint32(len(p)))
	copy(buf[20:], p)
	return buf
}

// FrameDecoder reconstructs frames from a byte stream.
// It accumulates bytes and emits complete frames without extra heap copies.
type FrameDecoder struct {
	buf                  []byte
	pos                  int
	maxFramePayloadBytes int
}

func newFrameDecoder(maxFramePayloadBytes int) *FrameDecoder {
	if maxFramePayloadBytes <= 0 {
		maxFramePayloadBytes = defaultMaxFramePayloadBytes
	}
	return &FrameDecoder{maxFramePayloadBytes: maxFramePayloadBytes}
}

func (d *FrameDecoder) feed(data []byte) ([]*Frame, error) {
	if d.maxFramePayloadBytes <= 0 {
		d.maxFramePayloadBytes = defaultMaxFramePayloadBytes
	}
	d.buf = append(d.buf[d.pos:], data...)
	d.pos = 0

	var frames []*Frame
	for {
		avail := len(d.buf) - d.pos
		if avail < frameHeaderSize {
			break
		}
		base := d.pos
		payloadLen := int(binary.BigEndian.Uint32(d.buf[base+16 : base+20]))
		if payloadLen > d.maxFramePayloadBytes {
			d.buf = nil
			d.pos = 0
			return nil, fmt.Errorf("frame payload too large: %d > %d", payloadLen, d.maxFramePayloadBytes)
		}
		total := frameHeaderSize + payloadLen
		if avail < total {
			break
		}
		payload := make([]byte, payloadLen)
		copy(payload, d.buf[base+frameHeaderSize:base+total])
		frames = append(frames, &Frame{
			TypeID:   d.buf[base],
			Flags:    d.buf[base+1],
			StreamID: binary.BigEndian.Uint32(d.buf[base+4 : base+8]),
			Offset:   binary.BigEndian.Uint64(d.buf[base+8 : base+16]),
			Payload:  payload,
		})
		d.pos += total
	}
	// Compact: only copy residual when we've consumed more than half.
	if d.pos > len(d.buf)/2 {
		d.buf = append([]byte(nil), d.buf[d.pos:]...)
		d.pos = 0
	}
	return frames, nil
}

// --- Payload helpers (mirror twoman_protocol.py) ---

func makeOpenPayload(host string, port uint16) []byte {
	h := []byte(host)
	buf := make([]byte, 5+len(h))
	buf[0] = ModeTCP
	binary.BigEndian.PutUint16(buf[1:3], port)
	binary.BigEndian.PutUint16(buf[3:5], uint16(len(h)))
	copy(buf[5:], h)
	return buf
}

func makeErrorPayload(msg string) []byte { return []byte(msg) }
func parseErrorPayload(p []byte) string  { return string(p) }

func parseOpenPayload(payload []byte) (host string, port uint16, err error) {
	if len(payload) < 5 {
		return "", 0, fmt.Errorf("open payload too short")
	}
	// layout: mode(1) port(2) hostLen(2) host(N)
	port = binary.BigEndian.Uint16(payload[1:3])
	hLen := int(binary.BigEndian.Uint16(payload[3:5]))
	if len(payload) < 5+hLen {
		return "", 0, fmt.Errorf("open payload host truncated")
	}
	return string(payload[5 : 5+hLen]), port, nil
}

func makeDNSQueryFramePayload(targetHost string, dnsPayload []byte) ([]byte, error) {
	h := []byte(targetHost)
	if len(h) > 65535 {
		return nil, fmt.Errorf("dns host too long")
	}
	buf := make([]byte, 2+len(h)+len(dnsPayload))
	binary.BigEndian.PutUint16(buf[0:2], uint16(len(h)))
	copy(buf[2:], h)
	copy(buf[2+len(h):], dnsPayload)
	return buf, nil
}

func parseDNSQueryFramePayload(payload []byte) (host string, dns []byte, err error) {
	if len(payload) < 2 {
		return "", nil, fmt.Errorf("dns frame payload too short")
	}
	hLen := int(binary.BigEndian.Uint16(payload[0:2]))
	if len(payload) < 2+hLen {
		return "", nil, fmt.Errorf("dns frame host truncated")
	}
	return string(payload[2 : 2+hLen]), payload[2+hLen:], nil
}

func randomPeerID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}
