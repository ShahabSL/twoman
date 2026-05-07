package main

import (
	"encoding/json"
	"testing"
)

func TestConfigDefaultsSecurityBooleans(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{}`), &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.SetDefaults()
	if !cfg.EnforceConnectSNI {
		t.Fatal("enforce_connect_sni should default true")
	}
	if !cfg.VerifyTLS {
		t.Fatal("verify_tls should default true")
	}
	if cfg.MaxFramePayloadBytes != defaultMaxFramePayloadBytes {
		t.Fatalf("unexpected frame limit: %d", cfg.MaxFramePayloadBytes)
	}
	if cfg.TLSHandshakeTimeoutSeconds != 15 {
		t.Fatalf("unexpected TLS handshake timeout: %v", cfg.TLSHandshakeTimeoutSeconds)
	}
}

func TestConfigAllowsExplicitFalseSecurityBooleans(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{"enforce_connect_sni": false, "verify_tls": false}`), &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.SetDefaults()
	if cfg.EnforceConnectSNI {
		t.Fatal("explicit enforce_connect_sni=false was not preserved")
	}
	if cfg.VerifyTLS {
		t.Fatal("explicit verify_tls=false was not preserved")
	}
}

func TestConfigPreservesExplicitDynamicListenPorts(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{"http_listen_port": 0, "socks_listen_port": 0}`), &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.SetDefaults()
	if cfg.HTTPListenPort != 0 {
		t.Fatalf("explicit dynamic HTTP port was not preserved: %d", cfg.HTTPListenPort)
	}
	if cfg.SOCKSListenPort != 0 {
		t.Fatalf("explicit dynamic SOCKS port was not preserved: %d", cfg.SOCKSListenPort)
	}
}

func TestConfigDefaultsMissingListenPorts(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{}`), &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.SetDefaults()
	if cfg.HTTPListenPort != 8080 {
		t.Fatalf("missing HTTP port should default to 8080, got %d", cfg.HTTPListenPort)
	}
	if cfg.SOCKSListenPort != 1080 {
		t.Fatalf("missing SOCKS port should default to 1080, got %d", cfg.SOCKSListenPort)
	}
}
