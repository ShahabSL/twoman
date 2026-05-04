package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"time"
)

func serveSOCKS(ctx context.Context, ln net.Listener, rt *helperRuntime) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				log.Printf("[socks] accept error: %v", err)
				time.Sleep(10 * time.Millisecond)
				continue
			}
		}
		go handleSOCKS(ctx, conn, rt)
	}
}

func handleSOCKS(ctx context.Context, conn net.Conn, rt *helperRuntime) {
	defer conn.Close()

	// ----- SOCKS5 greeting -----
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return
	}
	if hdr[0] != 5 {
		return // only SOCKS5
	}
	nMethods := int(hdr[1])
	methods := make([]byte, nMethods)
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	// Require NO AUTH (0x00)
	hasNoAuth := false
	for _, m := range methods {
		if m == 0 {
			hasNoAuth = true
			break
		}
	}
	if !hasNoAuth {
		conn.Write([]byte{5, 0xFF}) //nolint:errcheck
		return
	}
	conn.Write([]byte{5, 0x00}) //nolint:errcheck

	// ----- Request -----
	req := make([]byte, 4)
	if _, err := io.ReadFull(conn, req); err != nil {
		return
	}
	if req[0] != 5 {
		return
	}
	cmd := req[1]
	atyp := req[3]

	host, port, err := readSOCKS5Address(conn, atyp)
	if err != nil {
		log.Printf("[socks] read address: %v", err)
		return
	}

	switch cmd {
	case 1: // CONNECT
		log.Printf("[socks] CONNECT %s:%d", host, port)
		stream := rt.newStream(host, port)
		if err := stream.open(ctx); err != nil {
			rt.releaseStream(stream.id)
			sendSOCKS5Reply(conn, 5, "0.0.0.0", 0) // host unreachable
			log.Printf("[socks] open %s:%d: %v", host, port, err)
			return
		}
		sendSOCKS5Reply(conn, 0, "0.0.0.0", 0) //nolint:errcheck
		if err := stream.relay(ctx, conn, conn.(io.WriteCloser), nil, nil, false); err != nil {
			if !isBenignError(err) {
				log.Printf("[socks] relay %s:%d: %v", host, port, err)
			}
		}

	case 3: // UDP ASSOCIATE
		assoc, err := newSocksUDPAssoc(rt)
		if err != nil {
			sendSOCKS5Reply(conn, 1, "0.0.0.0", 0)
			return
		}
		defer assoc.close()

		udpAddr := assoc.addr()
		log.Printf("[socks] UDP ASSOCIATE bound=%s", udpAddr)
		sendSOCKS5Reply(conn, 0, udpAddr.IP.String(), uint16(udpAddr.Port))

		// Hold open: when the TCP control connection closes, tear down UDP.
		io.Copy(io.Discard, conn) //nolint:errcheck

	default:
		sendSOCKS5Reply(conn, 7, "0.0.0.0", 0) // command not supported
	}
}

// readSOCKS5Address reads the ATYP + address + port from a SOCKS5 connection.
func readSOCKS5Address(conn net.Conn, atyp byte) (host string, port uint16, err error) {
	switch atyp {
	case 1: // IPv4
		buf := make([]byte, 4+2)
		if _, err = io.ReadFull(conn, buf); err != nil {
			return
		}
		host = net.IP(buf[:4]).String()
		port = binary.BigEndian.Uint16(buf[4:6])

	case 3: // Domain
		lenBuf := make([]byte, 1)
		if _, err = io.ReadFull(conn, lenBuf); err != nil {
			return
		}
		domBuf := make([]byte, int(lenBuf[0])+2)
		if _, err = io.ReadFull(conn, domBuf); err != nil {
			return
		}
		host = string(domBuf[:int(lenBuf[0])])
		port = binary.BigEndian.Uint16(domBuf[int(lenBuf[0]):])

	case 4: // IPv6
		buf := make([]byte, 16+2)
		if _, err = io.ReadFull(conn, buf); err != nil {
			return
		}
		host = net.IP(buf[:16]).String()
		port = binary.BigEndian.Uint16(buf[16:18])

	default:
		err = fmt.Errorf("unsupported SOCKS5 address type %d", atyp)
	}
	return
}

// sendSOCKS5Reply writes a SOCKS5 reply packet.
func sendSOCKS5Reply(conn net.Conn, repCode byte, bindHost string, bindPort uint16) {
	ip := net.ParseIP(bindHost)
	if ip == nil {
		ip = net.IPv4zero
	}
	ip4 := ip.To4()
	if ip4 == nil {
		ip4 = net.IPv4zero.To4()
	}
	buf := make([]byte, 10)
	buf[0] = 5
	buf[1] = repCode
	buf[2] = 0
	buf[3] = 1 // IPv4
	copy(buf[4:8], ip4)
	binary.BigEndian.PutUint16(buf[8:10], bindPort)
	conn.Write(buf) //nolint:errcheck
}

// ---- SOCKS5 UDP packet parsing (used by socksUDPAssoc) ---------------------

// parseSocksUDPPacket parses a SOCKS5 UDP datagram.
// Format: RSV(2) + FRAG(1) + ATYP(1) + ADDR + PORT(2) + DATA
func parseSocksUDPPacket(pkt []byte) (host string, port uint16, payload []byte, err error) {
	if len(pkt) < 4 {
		return "", 0, nil, fmt.Errorf("packet too short")
	}
	if pkt[2] != 0 {
		return "", 0, nil, fmt.Errorf("fragmented UDP not supported")
	}
	atyp := pkt[3]
	offset := 4
	switch atyp {
	case 1:
		if len(pkt) < offset+6 {
			return "", 0, nil, fmt.Errorf("truncated IPv4")
		}
		host = net.IP(pkt[offset : offset+4]).String()
		port = binary.BigEndian.Uint16(pkt[offset+4 : offset+6])
		payload = pkt[offset+6:]
	case 3:
		if len(pkt) < offset+1 {
			return "", 0, nil, fmt.Errorf("truncated domain length")
		}
		domLen := int(pkt[offset])
		offset++
		if len(pkt) < offset+domLen+2 {
			return "", 0, nil, fmt.Errorf("truncated domain")
		}
		host = string(pkt[offset : offset+domLen])
		port = binary.BigEndian.Uint16(pkt[offset+domLen : offset+domLen+2])
		payload = pkt[offset+domLen+2:]
	case 4:
		if len(pkt) < offset+18 {
			return "", 0, nil, fmt.Errorf("truncated IPv6")
		}
		host = net.IP(pkt[offset : offset+16]).String()
		port = binary.BigEndian.Uint16(pkt[offset+16 : offset+18])
		payload = pkt[offset+18:]
	default:
		return "", 0, nil, fmt.Errorf("unknown address type %d", atyp)
	}
	return
}

// buildSocksUDPPacket wraps a UDP payload in a SOCKS5 UDP header.
func buildSocksUDPPacket(host string, port uint16, payload []byte) []byte {
	var addrBuf []byte
	ip := net.ParseIP(host)
	if ip4 := ip.To4(); ip4 != nil {
		addrBuf = append([]byte{1}, ip4...)
	} else if ip != nil {
		addrBuf = append([]byte{4}, ip.To16()...)
	} else {
		h := []byte(host)
		addrBuf = append([]byte{3, byte(len(h))}, h...)
	}
	portBuf := []byte{byte(port >> 8), byte(port)}
	pkt := make([]byte, 3+len(addrBuf)+2+len(payload))
	// RSV(2) + FRAG(1)
	pkt[0], pkt[1], pkt[2] = 0, 0, 0
	copy(pkt[3:], addrBuf)
	copy(pkt[3+len(addrBuf):], portBuf)
	copy(pkt[3+len(addrBuf)+2:], payload)
	return pkt
}
