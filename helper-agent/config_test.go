package main

import (
	"encoding/json"
	"testing"
	"time"
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
	if cfg.dnsQueryTimeout() != 10*time.Second {
		t.Fatalf("unexpected DNS timeout: %v", cfg.dnsQueryTimeout())
	}
	if cfg.dnsCacheTTL() != 60*time.Second {
		t.Fatalf("unexpected DNS cache TTL: %v", cfg.dnsCacheTTL())
	}
	if cfg.dnsMaxInflight() != 8 {
		t.Fatalf("unexpected DNS max in-flight: %d", cfg.dnsMaxInflight())
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

func TestConfigParsesAndroidNetworkHandle(t *testing.T) {
	tests := []struct {
		name string
		json string
		want uint64
	}{
		{name: "number", json: `{"android_network_handle": 548866543629}`, want: 548866543629},
		{name: "unsigned string", json: `{"android_network_handle": "18446744073709551615"}`, want: ^uint64(0)},
		{name: "signed string", json: `{"android_network_handle": "-1"}`, want: ^uint64(0)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var cfg Config
			if err := json.Unmarshal([]byte(test.json), &cfg); err != nil {
				t.Fatal(err)
			}
			if cfg.AndroidNetworkHandle != test.want {
				t.Fatalf("AndroidNetworkHandle = %d, want %d", cfg.AndroidNetworkHandle, test.want)
			}
		})
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

func TestConfigUsesVPNDNSOverrides(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{
		"dns_query_timeout_seconds": 4,
		"dns_cache_ttl_seconds": 60,
		"dns_max_inflight": 8,
		"vpn_dns_query_timeout_seconds": 15,
		"vpn_dns_cache_ttl_seconds": 30,
		"vpn_dns_max_inflight": 32
	}`), &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.SetDefaults()
	if cfg.dnsQueryTimeout() != 15*time.Second {
		t.Fatalf("VPN DNS timeout override not applied: %v", cfg.dnsQueryTimeout())
	}
	if cfg.dnsCacheTTL() != 30*time.Second {
		t.Fatalf("VPN DNS cache TTL override not applied: %v", cfg.dnsCacheTTL())
	}
	if cfg.dnsMaxInflight() != 32 {
		t.Fatalf("VPN DNS max in-flight override not applied: %d", cfg.dnsMaxInflight())
	}
}

func TestRuntimeUsesConfiguredDNSInflightLimit(t *testing.T) {
	cfg := &Config{VPNDNSMaxInflight: 32}
	cfg.SetDefaults()
	rt, err := newHelperRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if cap(rt.dnsSem) != 32 {
		t.Fatalf("helper runtime DNS semaphore cap = %d, want 32", cap(rt.dnsSem))
	}

	agent, err := newAgentRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if cap(agent.dnsSem) != 32 {
		t.Fatalf("agent runtime DNS semaphore cap = %d, want 32", cap(agent.dnsSem))
	}
}
