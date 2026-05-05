package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"strings"
	"time"
)

func serveHTTP(ctx context.Context, ln net.Listener, rt *helperRuntime) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			select {
			case <-ctx.Done():
				return
			default:
				log.Printf("[http-proxy] accept error: %v", err)
				time.Sleep(10 * time.Millisecond)
				continue
			}
		}
		go handleHTTP(ctx, conn, rt)
	}
}

func handleHTTP(ctx context.Context, conn net.Conn, rt *helperRuntime) {
	defer conn.Close()

	br := bufio.NewReaderSize(conn, 8192)

	// Read request line
	requestLine, err := br.ReadString('\n')
	if err != nil {
		return
	}
	requestLine = strings.TrimRight(requestLine, "\r\n")

	// Read all headers
	headers := make(map[string]string)
	var rawHeaders []string
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		rawHeaders = append(rawHeaders, line)
		idx := strings.IndexByte(line, ':')
		if idx > 0 {
			name := strings.TrimSpace(line[:idx])
			value := strings.TrimSpace(line[idx+1:])
			headers[strings.ToLower(name)] = value
		}
	}

	// Drain any body that was already buffered (for non-CONNECT)
	var bodySoFar []byte
	if br.Buffered() > 0 {
		bodySoFar = make([]byte, br.Buffered())
		br.Read(bodySoFar) //nolint:errcheck
	}

	parts := strings.SplitN(requestLine, " ", 3)
	if len(parts) < 2 {
		return
	}
	method := strings.ToUpper(parts[0])
	target := parts[1]

	if method == "CONNECT" {
		host, portStr, err := parseAuthority(target)
		if err != nil {
			conn.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n")) //nolint:errcheck
			return
		}
		port := uint16(443)
		if portStr != "" {
			fmt.Sscanf(portStr, "%d", &port)
		}

		var initialPayload []byte
		if rt.cfg.EnforceConnectSNI {
			// Ack CONNECT first, then peek at TLS ClientHello for SNI.
			conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")) //nolint:errcheck

			probe := make([]byte, 4096)
			conn.SetReadDeadline(time.Now().Add(time.Second)) //nolint:errcheck
			n, _ := conn.Read(probe)
			conn.SetReadDeadline(time.Time{}) //nolint:errcheck
			initialPayload = probe[:n]

			if len(initialPayload) > 0 {
				sni := extractTLSServerName(initialPayload)
				if sni != "" && !strings.EqualFold(normalizeHost(sni), normalizeHost(host)) {
					log.Printf("[http-proxy] SNI mismatch: connect=%s sni=%s", host, sni)
					return
				}
			}
		}

		stream := rt.newStream(host, port)
		var connResp []byte
		if !rt.cfg.EnforceConnectSNI {
			connResp = []byte("HTTP/1.1 200 Connection Established\r\n\r\n")
		}
		if err := stream.relay(ctx, conn, conn.(io.WriteCloser), initialPayload, connResp, true); err != nil {
			if !isBenignError(err) {
				log.Printf("[http-proxy] CONNECT relay error %s:%d: %v", host, port, err)
			}
		}
		return
	}

	// Non-CONNECT: rebuild the request for forwarding.
	host, port, rebuRequest, err := rebuildHTTPRequest(method, target, headers, rawHeaders, bodySoFar)
	if err != nil {
		errBody := []byte(err.Error())
		fmt.Fprintf(conn,
			"HTTP/1.1 400 Bad Request\r\nContent-Length: %d\r\nContent-Type: text/plain\r\n\r\n",
			len(errBody))
		conn.Write(errBody) //nolint:errcheck
		return
	}

	stream := rt.newStream(host, port)
	if err := stream.relay(ctx, conn, conn.(io.WriteCloser), rebuRequest, nil, true); err != nil {
		if !isBenignError(err) {
			errBody := []byte(err.Error())
			fmt.Fprintf(conn,
				"HTTP/1.1 502 Bad Gateway\r\nContent-Length: %d\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n",
				len(errBody))
			conn.Write(errBody) //nolint:errcheck
		}
	}
}

// rebuildHTTPRequest rewrites an HTTP proxy request into the form seen by the origin.
// Returns (host, port, forwardPayload, err).
func rebuildHTTPRequest(
	method, target string,
	headers map[string]string,
	rawHeaders []string,
	body []byte,
) (string, uint16, []byte, error) {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" {
		// Relative-form or origin-form with Host header.
		hostHeader := headers["host"]
		host, portStr, _ := net.SplitHostPort(hostHeader)
		if host == "" {
			host = hostHeader
		}
		port := uint16(80)
		if portStr != "" {
			fmt.Sscanf(portStr, "%d", &port)
		}
		// Re-emit as-is, stripping Proxy-Connection.
		rebuilt := buildForwardRequest(method, target, rawHeaders, body)
		return host, port, rebuilt, nil
	}

	host := parsed.Hostname()
	port := uint16(80)
	if parsed.Scheme == "https" {
		port = 443
	}
	if p := parsed.Port(); p != "" {
		fmt.Sscanf(p, "%d", &port)
	}

	path := parsed.RequestURI()
	if path == "" {
		path = "/"
	}
	rebuilt := buildForwardRequest(method, path, rawHeaders, body)
	return host, port, rebuilt, nil
}

func buildForwardRequest(method, path string, rawHeaders []string, body []byte) []byte {
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "%s %s HTTP/1.1\r\n", method, path)
	for _, h := range rawHeaders {
		lower := strings.ToLower(strings.SplitN(h, ":", 2)[0])
		if lower == "proxy-connection" || lower == "connection" {
			continue
		}
		buf.WriteString(h)
		buf.WriteString("\r\n")
	}
	buf.WriteString("Connection: close\r\n\r\n")
	buf.Write(body)
	return buf.Bytes()
}

func parseAuthority(authority string) (host, port string, err error) {
	if strings.Contains(authority, "[") {
		// IPv6
		h, p, err := net.SplitHostPort(authority)
		return h, p, err
	}
	if strings.Contains(authority, ":") {
		h, p, err := net.SplitHostPort(authority)
		return h, p, err
	}
	return authority, "", nil
}

func normalizeHost(h string) string {
	h = strings.TrimSpace(h)
	h = strings.Trim(h, "[]")
	return strings.ToLower(h)
}

func isBenignError(err error) bool {
	if err == nil {
		return true
	}
	s := err.Error()
	for _, needle := range []string{
		"connection reset", "broken pipe", "use of closed",
		"EOF", "context canceled", "forcibly closed",
		"open timed out",
	} {
		if strings.Contains(strings.ToLower(s), strings.ToLower(needle)) {
			return true
		}
	}
	return false
}

// extractTLSServerName parses a TLS ClientHello and returns the SNI value.
// This is a direct port of the Python extract_tls_server_name function.
func extractTLSServerName(payload []byte) string {
	if len(payload) < 5 || payload[0] != 22 {
		return "" // not a TLS handshake record
	}
	recordLen := int(binary.BigEndian.Uint16(payload[3:5]))
	record := payload[5:]
	if len(record) > recordLen {
		record = record[:recordLen]
	}
	if len(record) < 4 || record[0] != 1 {
		return "" // not ClientHello
	}
	bodyLen := int(record[1])<<16 | int(record[2])<<8 | int(record[3])
	body := record[4:]
	if len(body) > bodyLen {
		body = body[:bodyLen]
	}
	if len(body) < 34 {
		return ""
	}
	idx := 34
	if idx >= len(body) {
		return ""
	}
	sessionIDLen := int(body[idx])
	idx += 1 + sessionIDLen
	if idx+2 > len(body) {
		return ""
	}
	cipherSuitesLen := int(binary.BigEndian.Uint16(body[idx : idx+2]))
	idx += 2 + cipherSuitesLen
	if idx >= len(body) {
		return ""
	}
	compMethodsLen := int(body[idx])
	idx += 1 + compMethodsLen
	if idx+2 > len(body) {
		return ""
	}
	extLen := int(binary.BigEndian.Uint16(body[idx : idx+2]))
	idx += 2
	end := idx + extLen
	if end > len(body) {
		end = len(body)
	}
	for idx+4 <= end {
		extType := binary.BigEndian.Uint16(body[idx : idx+2])
		extSize := int(binary.BigEndian.Uint16(body[idx+2 : idx+4]))
		idx += 4
		extData := body[idx:min3(idx+extSize, end)]
		idx += extSize
		if extType != 0 || len(extData) < 5 {
			continue
		}
		// SNI extension: list_length(2) + name_type(1) + name_length(2) + name
		listLen := int(binary.BigEndian.Uint16(extData[0:2]))
		namesEnd := 2 + listLen
		if namesEnd > len(extData) {
			namesEnd = len(extData)
		}
		ni := 2
		for ni+3 <= namesEnd {
			nameType := extData[ni]
			nameLen := int(binary.BigEndian.Uint16(extData[ni+1 : ni+3]))
			ni += 3
			if ni+nameLen > namesEnd {
				break
			}
			if nameType == 0 {
				return string(extData[ni : ni+nameLen])
			}
			ni += nameLen
		}
	}
	return ""
}

func min3(a, b int) int {
	if a < b {
		return a
	}
	return b
}
