package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	windowFlushDelay = 5 * time.Millisecond
)

// ProxyStream represents a single multiplexed TCP stream over the relay.
// It mirrors the Python ProxyStream class with the same flow-control semantics.
type ProxyStream struct {
	id         uint32
	targetHost string
	targetPort uint16
	rt         *helperRuntime

	// Open handshake
	openCh chan error // receives nil (ok) or error

	// Receive path: in-order data delivery
	recvCh chan []byte // nil = EOF sentinel

	// Send flow control (credit = how many bytes we may send upstream)
	sendCreditMu   sync.Mutex
	sendCreditCond *sync.Cond
	sendCredit     int64
	sendOffset     uint64

	// Receive flow control
	recvOffset  uint64
	finOffset   uint64
	finReceived bool

	// Reorder buffer for out-of-order DATA frames
	reorderMu    sync.Mutex
	recvPending  map[uint64][]byte
	pendingBytes int

	// Pending window grant (bytes read locally, not yet acked upstream)
	windowMu      sync.Mutex
	pendingWindow int64
	windowFlushAt time.Time

	// State
	closed     int32 // atomic bool
	closeOnce  sync.Once
	doneCh     chan struct{} // closed once when stream is torn down
	sendClosed bool
	closedMu   sync.Mutex

	// Stats
	sendDataBytes int64
	recvDataBytes int64
}

func newProxyStream(id uint32, host string, port uint16, rt *helperRuntime) *ProxyStream {
	s := &ProxyStream{
		id:          id,
		targetHost:  host,
		targetPort:  port,
		rt:          rt,
		openCh:      make(chan error, 1),
		recvCh:      make(chan []byte, 512), // large buffer avoids blocking DOWN loop
		doneCh:      make(chan struct{}),
		sendCredit:  initialWindow,
		recvPending: make(map[uint64][]byte),
	}
	s.sendCreditCond = sync.NewCond(&s.sendCreditMu)
	return s
}

func (s *ProxyStream) isClosed() bool {
	return atomic.LoadInt32(&s.closed) != 0
}

func (s *ProxyStream) setClosed() {
	s.closeOnce.Do(func() {
		atomic.StoreInt32(&s.closed, 1)
		close(s.doneCh)
	})
	// Unblock any waiter on send credit (safe to call multiple times)
	s.sendCreditCond.Broadcast()
}

// open sends FRAME_OPEN and waits for OPEN_OK / OPEN_FAIL (30 s timeout).
func (s *ProxyStream) open(ctx context.Context) error {
	targetAgentPeerLabel := strings.TrimSpace(s.rt.cfg.TargetAgentPeerLabel)
	if len([]byte(targetAgentPeerLabel)) > 65535 {
		return fmt.Errorf("target agent label is too long")
	}
	frame := &Frame{
		TypeID:   FrameOpen,
		StreamID: s.id,
		Payload:  makeOpenPayload(s.targetHost, s.targetPort, targetAgentPeerLabel),
	}
	if err := s.rt.transport.sendFrame(s.controlLane(), frame); err != nil {
		return err
	}

	select {
	case err := <-s.openCh:
		return err
	case <-time.After(30 * time.Second):
		// Send RST so the broker and agent release the stream slot immediately
		// instead of holding it until stream_ttl_seconds (300 s) expires.
		s.reset("open timed out")
		return fmt.Errorf("open timed out")
	case <-ctx.Done():
		s.reset("context cancelled")
		return ctx.Err()
	}
}

// onFrame is called by the runtime dispatcher for every inbound frame that
// belongs to this stream. It is called from the transport's DOWN goroutine
// and must not block for long.
func (s *ProxyStream) onFrame(f *Frame) {
	switch f.TypeID {
	case FrameOpenOK:
		select {
		case s.openCh <- nil:
		default:
		}

	case FrameOpenFail:
		msg := parseErrorPayload(f.Payload)
		select {
		case s.openCh <- fmt.Errorf("%s", msg):
		default:
		}
		s.sendEOF()

	case FrameWindow:
		amount := int64(f.Offset)
		s.sendCreditMu.Lock()
		s.sendCredit += amount
		s.sendCreditCond.Broadcast()
		s.sendCreditMu.Unlock()

	case FrameData:
		rawOffset := f.Offset
		payload := f.Payload

		s.reorderMu.Lock()
		if rawOffset < s.recvOffset {
			// Duplicate or already-delivered prefix — trim.
			delta := s.recvOffset - rawOffset
			if delta >= uint64(len(payload)) {
				s.reorderMu.Unlock()
				return
			}
			payload = payload[delta:]
			rawOffset = s.recvOffset
		}
		if rawOffset > s.recvOffset {
			// Out of order — buffer it (if buffer not full).
			end := rawOffset + uint64(len(payload))
			if end <= s.recvOffset {
				s.reorderMu.Unlock()
				return
			}
			if s.pendingBytes+len(payload) > maxReorderBytes {
				s.reorderMu.Unlock()
				log.Printf("[stream %d] reorder overflow — resetting", s.id)
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
		// In-order — accept and flush pending.
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
			log.Printf("[stream %d] RST: %s", s.id, parseErrorPayload(f.Payload))
		}
		s.setClosed()
		s.sendEOF()
	}
}

// acceptInOrder advances recvOffset and queues payload for local delivery.
// Caller must hold reorderMu.
func (s *ProxyStream) acceptInOrder(payload []byte) {
	s.recvOffset += uint64(len(payload))
	s.recvDataBytes += int64(len(payload))
	select {
	case s.recvCh <- payload:
	case <-s.doneCh:
	default:
		go s.reset("receive buffer full")
	}
}

// flushPending delivers any buffered out-of-order frames that are now in order.
// Caller must hold reorderMu.
func (s *ProxyStream) flushPending() {
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

func (s *ProxyStream) sendEOF() {
	select {
	case s.recvCh <- nil:
	default:
	}
}

// ---- Send path -------------------------------------------------------------

// sendData sends payload upstream, respecting flow control credit.
// It blocks until credit is available or the stream is closed.
func (s *ProxyStream) sendData(ctx context.Context, payload []byte) error {
	view := payload
	for len(view) > 0 {
		if s.isClosed() {
			return fmt.Errorf("stream closed")
		}

		// Wait for credit.
		s.sendCreditMu.Lock()
		for s.sendCredit <= 0 && !s.isClosed() {
			s.sendCreditMu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
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
		atomic.AddInt64(&s.sendDataBytes, chunkLen)
		view = view[chunkLen:]
	}
	return nil
}

// finish sends FIN to signal local EOF upstream.
func (s *ProxyStream) finish() {
	s.closedMu.Lock()
	defer s.closedMu.Unlock()
	if s.sendClosed {
		return
	}
	s.sendClosed = true
	s.flushWindow()
	_ = s.rt.transport.sendFrame(s.controlLane(), &Frame{
		TypeID:   FrameFIN,
		StreamID: s.id,
		Offset:   s.sendOffset,
	})
}

// reset sends RST upstream.
func (s *ProxyStream) reset(reason string) {
	if s.isClosed() {
		return
	}
	s.setClosed()
	_ = s.rt.transport.sendFrame(s.controlLane(), &Frame{
		TypeID:   FrameRST,
		StreamID: s.id,
		Payload:  makeErrorPayload(reason),
	})
}

// grantWindow accumulates bytes read locally and periodically sends WINDOW frames.
func (s *ProxyStream) grantWindow(n int) {
	if n <= 0 || s.isClosed() {
		return
	}
	s.windowMu.Lock()
	s.pendingWindow += int64(n)
	now := time.Now()
	flush := s.pendingWindow >= windowFlushBytes || (!s.windowFlushAt.IsZero() && now.After(s.windowFlushAt))
	if flush {
		s.flushWindowLocked()
	} else {
		// Schedule a delayed flush if not already scheduled.
		if s.windowFlushAt.IsZero() {
			s.windowFlushAt = now.Add(windowFlushDelay)
			go func() {
				time.Sleep(windowFlushDelay)
				s.windowMu.Lock()
				s.flushWindowLocked()
				s.windowMu.Unlock()
			}()
		}
	}
	s.windowMu.Unlock()
}

// flushWindow sends accumulated window grant immediately.
func (s *ProxyStream) flushWindow() {
	s.windowMu.Lock()
	s.flushWindowLocked()
	s.windowMu.Unlock()
}

func (s *ProxyStream) flushWindowLocked() {
	if s.pendingWindow <= 0 || s.isClosed() {
		return
	}
	v := s.pendingWindow
	s.pendingWindow = 0
	s.windowFlushAt = time.Time{}
	_ = s.rt.transport.sendFrame(s.controlLane(), &Frame{
		TypeID:   FrameWindow,
		StreamID: s.id,
		Offset:   uint64(v),
	})
}

func (s *ProxyStream) controlLane() string {
	return s.rt.transport.streamControlLane
}

// ---- Relay -----------------------------------------------------------------

// relay bridges a local TCP connection (reader/writer) to this ProxyStream.
// If openStream is true it first performs the OPEN handshake.
// initialPayload (if non-nil) is sent upstream before starting the relay loop.
// connectedResponse (if non-nil) is written locally after OPEN succeeds.
func (s *ProxyStream) relay(
	ctx context.Context,
	reader io.Reader,
	writer io.WriteCloser,
	initialPayload []byte,
	connectedResponse []byte,
	openStream bool,
) error {
	defer writer.Close()
	defer func() {
		if !s.isClosed() {
			s.finish()
		}
		s.rt.releaseStream(s.id)
	}()

	if openStream {
		if err := s.open(ctx); err != nil {
			return fmt.Errorf("stream open: %w", err)
		}
	}

	if len(connectedResponse) > 0 {
		if _, err := writer.Write(connectedResponse); err != nil {
			s.reset("write connected response failed")
			return err
		}
	}
	if len(initialPayload) > 0 {
		if err := s.sendData(ctx, initialPayload); err != nil {
			s.reset("send initial payload failed")
			return err
		}
	}

	// Two goroutines: local→remote and remote→local.
	type relaySide uint8
	const (
		localToRemote relaySide = iota
		remoteToLocal
	)
	type relayResult struct {
		side relaySide
		err  error
	}
	errCh := make(chan relayResult, 2)

	// local → remote (upload)
	go func() {
		buf := make([]byte, readChunkSize)
		for {
			n, err := reader.Read(buf)
			if n > 0 {
				if sendErr := s.sendData(ctx, buf[:n]); sendErr != nil {
					errCh <- relayResult{side: localToRemote, err: sendErr}
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					s.finish()
					errCh <- relayResult{side: localToRemote}
				} else {
					s.reset("local read error: " + err.Error())
					errCh <- relayResult{side: localToRemote, err: err}
				}
				return
			}
		}
	}()

	// remote → local (download)
	go func() {
		for {
			select {
			case payload := <-s.recvCh:
				if payload == nil {
					// EOF from remote
					tryWriteEOF(writer)
					errCh <- relayResult{side: remoteToLocal}
					return
				}
				if _, err := writer.Write(payload); err != nil {
					s.reset("local write error: " + err.Error())
					errCh <- relayResult{side: remoteToLocal, err: err}
					return
				}
				s.grantWindow(len(payload))
			case <-s.doneCh:
				errCh <- relayResult{side: remoteToLocal}
				return
			}
		}
	}()

	// Wait for both goroutines; first error wins.
	var firstErr error
	for i := 0; i < 2; i++ {
		result := <-errCh
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		// On write-side errors or remote EOF, close the local endpoint now so the
		// opposite read goroutine cannot keep the relay and stream slot alive.
		// Local read EOF is different: keep the connection half-open for a valid
		// response path from the remote side.
		if i == 0 && (result.err != nil || result.side == remoteToLocal) {
			closeRelayIO(reader, writer)
		}
	}
	if firstErr != nil && !s.isClosed() {
		s.reset("relay error: " + firstErr.Error())
	}
	return firstErr
}

func tryWriteEOF(w io.Writer) {
	if cw, ok := w.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite() //nolint:errcheck
	}
}

func closeRelayIO(reader io.Reader, writer io.WriteCloser) {
	_ = writer.Close()
	if closer, ok := reader.(io.Closer); ok {
		_ = closer.Close()
	}
}
