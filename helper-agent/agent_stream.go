package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// AgentStream represents a single TCP connection to an origin server opened on
// behalf of a helper's ProxyStream. It is the agent-side mirror of ProxyStream:
//
//   - ProxyStream: sends FRAME_OPEN → waits for FRAME_OPEN_OK → relays
//   - AgentStream: receives FRAME_OPEN → dials origin → sends FRAME_OPEN_OK → relays
//
// Flow-control semantics are symmetric: the helper grants send credit via
// FRAME_WINDOW; the agent does the same.
type AgentStream struct {
	id         uint32
	targetHost string
	targetPort uint16
	rt         *agentRuntime

	// TCP connection to the origin server (set after successful dial).
	conn net.Conn

	// recvCh buffers data arriving FROM the helper (FRAME_DATA) to be written
	// to conn. A nil payload signals EOF from the helper.
	recvCh chan []byte

	// Send flow control: credit granted by helper via FRAME_WINDOW.
	sendCreditMu   sync.Mutex
	sendCreditCond *sync.Cond
	sendCredit     int64
	sendOffset     uint64

	// Receive tracking: ordered delivery of DATA frames from the helper.
	recvOffset  uint64
	finOffset   uint64
	finReceived bool

	// Reorder buffer for out-of-order DATA frames.
	reorderMu    sync.Mutex
	recvPending  map[uint64][]byte
	pendingBytes int

	// Window accumulation: bytes delivered to conn but not yet ACKed via FRAME_WINDOW.
	windowMu      sync.Mutex
	pendingWindow int64
	windowFlushAt time.Time

	// State
	closed     int32 // atomic bool
	closeOnce  sync.Once
	doneCh     chan struct{}
	sendClosed bool
	closedMu   sync.Mutex
}

func newAgentStream(id uint32, host string, port uint16, rt *agentRuntime) *AgentStream {
	s := &AgentStream{
		id:          id,
		targetHost:  host,
		targetPort:  port,
		rt:          rt,
		recvCh:      make(chan []byte, 512),
		doneCh:      make(chan struct{}),
		sendCredit:  initialWindow,
		recvPending: make(map[uint64][]byte),
	}
	s.sendCreditCond = sync.NewCond(&s.sendCreditMu)
	return s
}

func (s *AgentStream) isClosed() bool {
	return atomic.LoadInt32(&s.closed) != 0
}

func (s *AgentStream) setClosed() {
	s.closeOnce.Do(func() {
		atomic.StoreInt32(&s.closed, 1)
		close(s.doneCh)
	})
	s.sendCreditCond.Broadcast()
}

// start dials the origin, sends FRAME_OPEN_OK/FAIL, and launches the relay.
// Must be called in a dedicated goroutine.
func (s *AgentStream) start() {
	addr := net.JoinHostPort(s.targetHost, fmt.Sprintf("%d", s.targetPort))
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	conn, err := s.rt.dialOrigin(ctx, "tcp", addr)
	if err != nil {
		_ = s.rt.transport.sendFrame(s.rt.transport.streamControlLane, &Frame{
			TypeID:   FrameOpenFail,
			StreamID: s.id,
			Payload:  makeErrorPayload(err.Error()),
		})
		s.rt.releaseStream(s.id)
		return
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true) //nolint:errcheck
	}
	s.conn = conn

	// The helper may have sent RST (e.g. "open timed out") while we were
	// dialling. Honour the cancellation: close the TCP connection we just
	// opened and release the slot without sending OPEN_OK.
	if s.isClosed() {
		conn.Close()
		s.rt.releaseStream(s.id)
		return
	}

	_ = s.rt.transport.sendFrame(s.rt.transport.streamControlLane, &Frame{
		TypeID:   FrameOpenOK,
		StreamID: s.id,
	})
	s.relay()
}

// relay bridges the origin TCP connection and the transport frame channel.
func (s *AgentStream) relay() {
	defer func() {
		s.conn.Close()
		if !s.isClosed() {
			s.finish()
		}
		s.rt.releaseStream(s.id)
	}()

	type relaySide uint8
	const (
		originToHelper relaySide = iota
		helperToOrigin
	)
	type relayResult struct {
		side relaySide
		err  error
	}
	errCh := make(chan relayResult, 2)

	// origin → helper: read bytes from origin, send FRAME_DATA upstream.
	go func() {
		buf := make([]byte, readChunkSize)
		for {
			n, err := s.conn.Read(buf)
			if n > 0 {
				if sendErr := s.sendData(buf[:n]); sendErr != nil {
					errCh <- relayResult{side: originToHelper, err: sendErr}
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					s.finish()
					errCh <- relayResult{side: originToHelper}
				} else {
					s.reset("origin read: " + err.Error())
					errCh <- relayResult{side: originToHelper, err: err}
				}
				return
			}
		}
	}()

	// helper → origin: receive buffered data from recvCh, write to origin.
	go func() {
		for {
			select {
			case payload, ok := <-s.recvCh:
				if !ok || payload == nil {
					agentCloseWrite(s.conn)
					errCh <- relayResult{side: helperToOrigin}
					return
				}
				if _, err := s.conn.Write(payload); err != nil {
					s.reset("origin write: " + err.Error())
					errCh <- relayResult{side: helperToOrigin, err: err}
					return
				}
				s.grantWindow(len(payload))
			case <-s.doneCh:
				errCh <- relayResult{side: helperToOrigin}
				return
			}
		}
	}()

	var firstErr error
	for i := 0; i < 2; i++ {
		result := <-errCh
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		// If the origin read side is done, the origin socket cannot produce more
		// useful bytes; close it now so the write goroutine cannot park forever.
		// On write-side EOF from the helper, keep the socket half-open so origin
		// responses can still flow back to the helper.
		if i == 0 && (result.err != nil || result.side == originToHelper) {
			if result.side == originToHelper {
				s.setClosed()
			}
			_ = s.conn.Close()
		}
	}
	if firstErr != nil && !s.isClosed() {
		s.reset("relay: " + firstErr.Error())
	}
}

func agentCloseWrite(conn net.Conn) {
	if cw, ok := conn.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite() //nolint:errcheck
	}
}

// onFrame is called by the agentRuntime dispatcher for each frame addressed to
// this stream. Must not block for long (called from the DOWN goroutine).
func (s *AgentStream) onFrame(f *Frame) {
	switch f.TypeID {
	case FrameWindow:
		s.sendCreditMu.Lock()
		s.sendCredit += int64(f.Offset)
		s.sendCreditCond.Broadcast()
		s.sendCreditMu.Unlock()

	case FrameData:
		rawOffset := f.Offset
		payload := f.Payload

		s.reorderMu.Lock()
		if rawOffset < s.recvOffset {
			delta := s.recvOffset - rawOffset
			if delta >= uint64(len(payload)) {
				s.reorderMu.Unlock()
				return
			}
			payload = payload[delta:]
			rawOffset = s.recvOffset
		}
		if rawOffset > s.recvOffset {
			end := rawOffset + uint64(len(payload))
			if end <= s.recvOffset {
				s.reorderMu.Unlock()
				return
			}
			if s.pendingBytes+len(payload) > maxReorderBytes {
				s.reorderMu.Unlock()
				log.Printf("[agent stream %d] reorder overflow — resetting", s.id)
				s.reset("reorder buffer overflow")
				return
			}
			if existing, ok := s.recvPending[rawOffset]; !ok || len(payload) > len(existing) {
				if ok {
					s.pendingBytes -= len(existing)
				}
				s.recvPending[rawOffset] = payload
				s.pendingBytes += len(payload)
			}
			s.reorderMu.Unlock()
			return
		}
		// In-order: accept and flush any now-deliverable pending frames.
		s.acceptInOrder(payload)
		s.flushPending()
		s.reorderMu.Unlock()

	case FrameFIN:
		s.reorderMu.Lock()
		s.finOffset = f.Offset
		s.finReceived = true
		if s.recvOffset >= s.finOffset {
			s.sendEOF()
		}
		s.reorderMu.Unlock()

	case FrameRST:
		if len(f.Payload) > 0 {
			msg := parseErrorPayload(f.Payload)
			if !isBenignError(fmt.Errorf("%s", msg)) {
				log.Printf("[agent stream %d] RST: %s", s.id, msg)
			}
		}
		s.setClosed()
		s.sendEOF()
	}
}

// acceptInOrder advances recvOffset and queues payload for the relay writer.
// Caller must hold reorderMu.
func (s *AgentStream) acceptInOrder(payload []byte) {
	s.recvOffset += uint64(len(payload))
	select {
	case s.recvCh <- payload:
	case <-s.doneCh:
	default:
		go s.reset("receive buffer full")
	}
}

// flushPending delivers buffered out-of-order frames now that recvOffset advanced.
// Caller must hold reorderMu.
func (s *AgentStream) flushPending() {
	for {
		payload, ok := s.recvPending[s.recvOffset]
		if !ok {
			break
		}
		delete(s.recvPending, s.recvOffset)
		s.pendingBytes -= len(payload)
		s.acceptInOrder(payload)
		if s.finReceived && s.recvOffset >= s.finOffset {
			s.sendEOF()
		}
	}
}

func (s *AgentStream) sendEOF() {
	select {
	case s.recvCh <- nil:
	default:
	}
}

// ---- Send path (origin → helper) -------------------------------------------

// sendData sends payload upstream to the helper, respecting send credit.
// It blocks until credit is available or the stream is closed.
func (s *AgentStream) sendData(payload []byte) error {
	view := payload
	for len(view) > 0 {
		if s.isClosed() {
			return fmt.Errorf("stream closed")
		}
		s.sendCreditMu.Lock()
		for s.sendCredit <= 0 && !s.isClosed() {
			s.sendCreditMu.Unlock()
			select {
			case <-s.doneCh:
				return fmt.Errorf("stream closed")
			case <-time.After(50 * time.Millisecond):
			}
			s.sendCreditMu.Lock()
		}
		if s.isClosed() {
			s.sendCreditMu.Unlock()
			return fmt.Errorf("stream closed")
		}
		chunkLen := int64(len(view))
		if s.sendOffset < priLimit {
			priRemaining := int64(priLimit - s.sendOffset)
			if priRemaining < chunkLen {
				chunkLen = priRemaining
			}
		} else if int64(readChunkSize) < chunkLen {
			chunkLen = readChunkSize
		}
		if s.sendCredit < chunkLen {
			chunkLen = s.sendCredit
		}
		s.sendCredit -= chunkLen
		s.sendCreditMu.Unlock()

		chunk := view[:chunkLen]
		flags := FlagNone
		lane := LanePRI
		if s.sendOffset >= priLimit || uint64(chunkLen) > priLimit-s.sendOffset {
			lane = LaneBulk
			flags = FlagDataBulk
		}
		if err := s.rt.transport.sendFrame(lane, &Frame{
			TypeID:   FrameData,
			Flags:    flags,
			StreamID: s.id,
			Offset:   s.sendOffset,
			Payload:  append([]byte{}, chunk...),
		}); err != nil {
			s.sendCreditMu.Lock()
			s.sendCredit += chunkLen
			s.sendCreditMu.Unlock()
			return err
		}
		s.sendOffset += uint64(chunkLen)
		view = view[chunkLen:]
	}
	return nil
}

// finish sends FRAME_FIN to signal local EOF upstream.
func (s *AgentStream) finish() {
	s.closedMu.Lock()
	defer s.closedMu.Unlock()
	if s.sendClosed {
		return
	}
	s.sendClosed = true
	s.flushWindow()
	_ = s.rt.transport.sendFrame(s.rt.transport.streamControlLane, &Frame{
		TypeID:   FrameFIN,
		StreamID: s.id,
		Offset:   s.sendOffset,
	})
}

// reset sends FRAME_RST upstream and marks the stream closed.
func (s *AgentStream) reset(reason string) {
	if s.isClosed() {
		return
	}
	s.setClosed()
	_ = s.rt.transport.sendFrame(s.rt.transport.streamControlLane, &Frame{
		TypeID:   FrameRST,
		StreamID: s.id,
		Payload:  makeErrorPayload(reason),
	})
}

// ---- Window management (bytes delivered to origin → ack to helper) ----------

func (s *AgentStream) grantWindow(n int) {
	if n <= 0 || s.isClosed() {
		return
	}
	s.windowMu.Lock()
	s.pendingWindow += int64(n)
	now := time.Now()
	flush := s.pendingWindow >= windowFlushBytes || (!s.windowFlushAt.IsZero() && now.After(s.windowFlushAt))
	if flush {
		s.flushWindowLocked()
	} else if s.windowFlushAt.IsZero() {
		s.windowFlushAt = now.Add(windowFlushDelay)
		go func() {
			time.Sleep(windowFlushDelay)
			s.windowMu.Lock()
			s.flushWindowLocked()
			s.windowMu.Unlock()
		}()
	}
	s.windowMu.Unlock()
}

func (s *AgentStream) flushWindow() {
	s.windowMu.Lock()
	s.flushWindowLocked()
	s.windowMu.Unlock()
}

func (s *AgentStream) flushWindowLocked() {
	if s.pendingWindow <= 0 || s.isClosed() {
		return
	}
	v := s.pendingWindow
	s.pendingWindow = 0
	s.windowFlushAt = time.Time{}
	_ = s.rt.transport.sendFrame(s.rt.transport.streamControlLane, &Frame{
		TypeID:   FrameWindow,
		StreamID: s.id,
		Offset:   uint64(v),
	})
}
