package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// agentRuntime implements the agent side of the relay. It:
//   - connects to the broker via laneTransport (role="agent")
//   - accepts FRAME_OPEN from the helper and dials the requested origin
//   - answers FRAME_DNS_QUERY by resolving DNS and returning FRAME_DNS_RESPONSE
//
// It owns the hidden-server side of the Go dataplane.
type agentRuntime struct {
	cfg       *Config
	transport *laneTransport

	streamsMu sync.RWMutex
	streams   map[uint32]*AgentStream

	// Semaphore: limits concurrent DNS resolutions.
	dnsSem chan struct{}

	originDialer *net.Dialer
}

func newAgentRuntime(cfg *Config) (*agentRuntime, error) {
	peerID := cfg.PeerID
	if peerID == "" {
		peerID = randomPeerID()
	}
	rt := &agentRuntime{
		cfg:     cfg,
		streams: make(map[uint32]*AgentStream),
		dnsSem:  make(chan struct{}, cfg.dnsMaxInflight()),
		originDialer: &net.Dialer{
			Timeout:   12 * time.Second,
			KeepAlive: 30 * time.Second,
		},
	}
	rt.transport = newLaneTransport(cfg, "agent", peerID, rt.onFrame)
	return rt, nil
}

func (rt *agentRuntime) dialOrigin(ctx context.Context, network, address string) (net.Conn, error) {
	if strings.TrimSpace(rt.cfg.OutboundProxyURL) == "" {
		return rt.originDialer.DialContext(ctx, network, address)
	}
	dialContext, ok, err := newProxyDialContext(rt.cfg.OutboundProxyURL, rt.originDialer)
	if err != nil {
		return nil, err
	}
	if !ok {
		return rt.originDialer.DialContext(ctx, network, address)
	}
	return dialContext(ctx, network, address)
}

func (rt *agentRuntime) start(ctx context.Context) error {
	if err := rt.transport.start(ctx); err != nil {
		return err
	}
	log.Printf("[agent] started peer=%s broker=%s", rt.transport.peerLabel, rt.cfg.BrokerBaseURL)
	return nil
}

func (rt *agentRuntime) stop() {
	rt.streamsMu.Lock()
	streams := make([]*AgentStream, 0, len(rt.streams))
	for _, s := range rt.streams {
		streams = append(streams, s)
	}
	rt.streams = make(map[uint32]*AgentStream)
	rt.streamsMu.Unlock()

	for _, s := range streams {
		s.reset("agent stopped")
		if s.conn != nil {
			s.conn.Close()
		}
	}
	if len(streams) > 0 {
		time.Sleep(250 * time.Millisecond)
	}
	rt.transport.stop()
}

func (rt *agentRuntime) releaseStream(id uint32) {
	rt.streamsMu.Lock()
	delete(rt.streams, id)
	rt.streamsMu.Unlock()
}

// onFrame is the transport callback. Dispatches to the right handler.
func (rt *agentRuntime) onFrame(f *Frame, _ string) {
	switch f.TypeID {
	case FrameOpen:
		host, port, err := parseOpenPayload(f.Payload)
		if err != nil {
			_ = rt.transport.sendFrame(rt.transport.streamControlLane, &Frame{
				TypeID:   FrameOpenFail,
				StreamID: f.StreamID,
				Payload:  makeErrorPayload("bad OPEN payload: " + err.Error()),
			})
			return
		}
		s := newAgentStream(f.StreamID, host, port, rt)
		rt.streamsMu.Lock()
		rt.streams[f.StreamID] = s
		rt.streamsMu.Unlock()
		go s.start()

	case FrameDNSQuery:
		go rt.handleDNSQuery(f)

	default:
		rt.streamsMu.RLock()
		s := rt.streams[f.StreamID]
		rt.streamsMu.RUnlock()
		if s == nil {
			return
		}
		s.onFrame(f)
		if f.TypeID == FrameRST {
			rt.releaseStream(f.StreamID)
		}
	}
}

// ---- DNS handling ----------------------------------------------------------

// handleDNSQuery resolves the DNS query payload received from the helper and
// sends back FRAME_DNS_RESPONSE or FRAME_DNS_FAIL.
func (rt *agentRuntime) handleDNSQuery(f *Frame) {
	targetHost, dnsPayload, err := parseDNSQueryFramePayload(f.Payload)
	if err != nil {
		_ = rt.transport.sendFrame(LanePRI, &Frame{
			TypeID:   FrameDNSFail,
			StreamID: f.StreamID,
			Payload:  makeErrorPayload("parse: " + err.Error()),
		})
		return
	}

	// Enforce concurrency cap.
	select {
	case rt.dnsSem <- struct{}{}:
	case <-time.After(rt.cfg.dnsQueryTimeout()):
		_ = rt.transport.sendFrame(LanePRI, &Frame{
			TypeID:   FrameDNSFail,
			StreamID: f.StreamID,
			Payload:  makeErrorPayload("dns semaphore timeout"),
		})
		return
	}
	defer func() { <-rt.dnsSem }()

	upstreams := rt.dnsUpstreams(targetHost)
	response, err := queryDNSUpstreams(upstreams, dnsPayload, rt.cfg.dnsQueryTimeout())
	if err != nil {
		log.Printf("[agent] dns fail host=%s err=%v", targetHost, err)
		_ = rt.transport.sendFrame(LanePRI, &Frame{
			TypeID:   FrameDNSFail,
			StreamID: f.StreamID,
			Payload:  makeErrorPayload(err.Error()),
		})
		return
	}
	_ = rt.transport.sendFrame(LanePRI, &Frame{
		TypeID:   FrameDNSResponse,
		StreamID: f.StreamID,
		Payload:  response,
	})
}

// dnsUpstreams returns the list of DNS servers to try.
// The targetHost (provided by the helper) is tried first, then well-known
// public resolvers as fallback. Deduplication is applied.
func (rt *agentRuntime) dnsUpstreams(targetHost string) []string {
	seen := make(map[string]bool)
	var list []string
	for _, h := range append([]string{targetHost}, "1.1.1.1", "8.8.8.8") {
		if h != "" && !seen[h] {
			seen[h] = true
			list = append(list, h)
		}
	}
	return list
}

// queryDNSUpstreams queries all upstreams in parallel and returns the first
// successful response. Mirrors Python's resolve_dns_via_upstreams.
func queryDNSUpstreams(upstreams []string, payload []byte, timeout time.Duration) ([]byte, error) {
	type result struct {
		resp []byte
		err  error
	}
	ch := make(chan result, len(upstreams))
	for _, host := range upstreams {
		host := host
		go func() {
			resp, err := queryDNSSingle(host, payload, timeout)
			ch <- result{resp, err}
		}()
	}
	var lastErr error
	for i := 0; i < len(upstreams); i++ {
		r := <-ch
		if r.err == nil {
			return r.resp, nil
		}
		lastErr = r.err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("all dns upstreams failed")
	}
	return nil, lastErr
}

// queryDNSSingle tries UDP first; falls back to TCP only on truncation (TC bit).
// If UDP fails with a network error, TCP to the same host will fail identically
// and only burn another full timeout — so we return the error immediately.
func queryDNSSingle(host string, payload []byte, timeout time.Duration) ([]byte, error) {
	resp, err := udpDNSQuery(host, payload, timeout)
	if err != nil {
		return nil, err // UDP network error — skip TCP, same result
	}
	if !dnsTC(resp) {
		return resp, nil
	}
	// TC bit set: response was truncated, retry over TCP as RFC 1035 requires.
	return tcpDNSQuery(host, payload, timeout)
}

func udpDNSQuery(host string, payload []byte, timeout time.Duration) ([]byte, error) {
	conn, err := net.DialTimeout("udp", net.JoinHostPort(host, "53"), timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout)) //nolint:errcheck
	if _, err := conn.Write(payload); err != nil {
		return nil, err
	}
	buf := make([]byte, 65535)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

func tcpDNSQuery(host string, payload []byte, timeout time.Duration) ([]byte, error) {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, "53"), timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout)) //nolint:errcheck

	// DNS over TCP: 2-byte big-endian length prefix.
	var lenBuf [2]byte
	binary.BigEndian.PutUint16(lenBuf[:], uint16(len(payload)))
	if _, err := conn.Write(append(lenBuf[:], payload...)); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
		return nil, err
	}
	respLen := int(binary.BigEndian.Uint16(lenBuf[:]))
	if respLen > 65535 {
		return nil, fmt.Errorf("dns tcp response length %d out of range", respLen)
	}
	resp := make([]byte, respLen)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// dnsTC returns true if the TC (TrunCated) bit is set in the DNS response.
func dnsTC(payload []byte) bool {
	if len(payload) < 4 {
		return false
	}
	return binary.BigEndian.Uint16(payload[2:4])&0x0200 != 0
}
