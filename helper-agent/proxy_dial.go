package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type proxyDialMode int

const (
	proxyDialDirect proxyDialMode = iota
	proxyDialSOCKS5LocalDNS
	proxyDialSOCKS5RemoteDNS
)

type proxyDialConfig struct {
	mode     proxyDialMode
	address  string
	username string
	password string
}

func parseProxyDialConfig(rawURL string) (proxyDialConfig, bool, error) {
	text := strings.TrimSpace(rawURL)
	if text == "" {
		return proxyDialConfig{mode: proxyDialDirect}, false, nil
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return proxyDialConfig{}, false, err
	}
	cfg := proxyDialConfig{address: parsed.Host}
	if parsed.User != nil {
		cfg.username = parsed.User.Username()
		cfg.password, _ = parsed.User.Password()
	}
	switch strings.ToLower(parsed.Scheme) {
	case "socks5":
		cfg.mode = proxyDialSOCKS5LocalDNS
	case "socks5h":
		cfg.mode = proxyDialSOCKS5RemoteDNS
	default:
		return proxyDialConfig{}, false, fmt.Errorf("unsupported dial proxy scheme %q", parsed.Scheme)
	}
	if cfg.address == "" {
		return proxyDialConfig{}, false, fmt.Errorf("proxy address is required")
	}
	return cfg, true, nil
}

func newProxyDialContext(rawURL string, base *net.Dialer) (func(context.Context, string, string) (net.Conn, error), bool, error) {
	cfg, ok, err := parseProxyDialConfig(rawURL)
	if err != nil || !ok {
		return nil, ok, err
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		target := address
		if cfg.mode == proxyDialSOCKS5LocalDNS {
			resolved, err := resolveTCPAddress(ctx, network, address)
			if err != nil {
				return nil, err
			}
			target = resolved
		}
		conn, err := base.DialContext(ctx, "tcp", cfg.address)
		if err != nil {
			return nil, err
		}
		if deadline, ok := ctx.Deadline(); ok {
			_ = conn.SetDeadline(deadline)
		} else {
			_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
		}
		if err := socks5Connect(conn, target, cfg.username, cfg.password); err != nil {
			_ = conn.Close()
			return nil, err
		}
		_ = conn.SetDeadline(time.Time{})
		return conn, nil
	}, true, nil
}

func resolveTCPAddress(ctx context.Context, network, address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	if ip := net.ParseIP(host); ip != nil {
		return net.JoinHostPort(ip.String(), port), nil
	}
	resolver := net.DefaultResolver
	ips, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", fmt.Errorf("no addresses for %s", host)
	}
	for _, candidate := range ips {
		if candidate.IP.To4() != nil {
			return net.JoinHostPort(candidate.IP.String(), port), nil
		}
	}
	if strings.HasSuffix(network, "4") {
		return "", fmt.Errorf("no IPv4 address for %s", host)
	}
	return net.JoinHostPort(ips[0].IP.String(), port), nil
}

func socks5Connect(conn net.Conn, target, username, password string) error {
	methods := []byte{0x00}
	if username != "" || password != "" {
		methods = append(methods, 0x02)
	}
	if _, err := conn.Write([]byte{0x05, byte(len(methods))}); err != nil {
		return err
	}
	if _, err := conn.Write(methods); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[0] != 0x05 {
		return fmt.Errorf("invalid SOCKS version %d", reply[0])
	}
	switch reply[1] {
	case 0x00:
	case 0x02:
		if err := socks5UsernamePasswordAuth(conn, username, password); err != nil {
			return err
		}
	default:
		return fmt.Errorf("SOCKS authentication method rejected: %d", reply[1])
	}

	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		return err
	}
	port64, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return err
	}
	req := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			req = append(req, 0x01)
			req = append(req, ip4...)
		} else {
			req = append(req, 0x04)
			req = append(req, ip.To16()...)
		}
	} else {
		if len(host) > 255 {
			return fmt.Errorf("SOCKS target host too long")
		}
		req = append(req, 0x03, byte(len(host)))
		req = append(req, []byte(host)...)
	}
	var port [2]byte
	binary.BigEndian.PutUint16(port[:], uint16(port64))
	req = append(req, port[:]...)
	if _, err := conn.Write(req); err != nil {
		return err
	}

	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return err
	}
	if header[0] != 0x05 {
		return fmt.Errorf("invalid SOCKS reply version %d", header[0])
	}
	if header[1] != 0x00 {
		return fmt.Errorf("SOCKS connect failed with code %d", header[1])
	}
	var discard int
	switch header[3] {
	case 0x01:
		discard = 4
	case 0x03:
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(conn, lenBuf); err != nil {
			return err
		}
		discard = int(lenBuf[0])
	case 0x04:
		discard = 16
	default:
		return fmt.Errorf("invalid SOCKS reply address type %d", header[3])
	}
	if discard > 0 {
		if _, err := io.CopyN(io.Discard, conn, int64(discard)); err != nil {
			return err
		}
	}
	if _, err := io.CopyN(io.Discard, conn, 2); err != nil {
		return err
	}
	return nil
}

func socks5UsernamePasswordAuth(conn net.Conn, username, password string) error {
	if len(username) > 255 || len(password) > 255 {
		return fmt.Errorf("SOCKS username/password too long")
	}
	req := []byte{0x01, byte(len(username))}
	req = append(req, []byte(username)...)
	req = append(req, byte(len(password)))
	req = append(req, []byte(password)...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[1] != 0x00 {
		return fmt.Errorf("SOCKS username/password authentication failed")
	}
	return nil
}
