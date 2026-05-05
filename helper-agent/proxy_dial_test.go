package main

import "testing"

func TestParseProxyDialConfigDistinguishesSOCKSDNSMode(t *testing.T) {
	local, ok, err := parseProxyDialConfig("socks5://127.0.0.1:1280")
	if err != nil || !ok {
		t.Fatalf("parse local DNS socks: ok=%v err=%v", ok, err)
	}
	if local.mode != proxyDialSOCKS5LocalDNS {
		t.Fatalf("expected local DNS mode, got %v", local.mode)
	}

	remote, ok, err := parseProxyDialConfig("socks5h://user:pass@127.0.0.1:1280")
	if err != nil || !ok {
		t.Fatalf("parse remote DNS socks: ok=%v err=%v", ok, err)
	}
	if remote.mode != proxyDialSOCKS5RemoteDNS {
		t.Fatalf("expected remote DNS mode, got %v", remote.mode)
	}
	if remote.username != "user" || remote.password != "pass" {
		t.Fatalf("proxy auth not parsed: %#v", remote)
	}
}

func TestParseProxyDialConfigRejectsHTTPForDialer(t *testing.T) {
	_, ok, err := parseProxyDialConfig("http://127.0.0.1:8080")
	if err == nil || ok {
		t.Fatalf("expected unsupported scheme error, ok=%v err=%v", ok, err)
	}
}
