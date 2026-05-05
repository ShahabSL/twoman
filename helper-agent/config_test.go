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
