package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func shareText(t *testing.T, payload map[string]interface{}) string {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return profileSharePrefix + strings.TrimRight(base64.URLEncoding.EncodeToString(data), "=")
}

func TestParseProfileShareText(t *testing.T) {
	raw := shareText(t, map[string]interface{}{
		"name":                        "CLI test",
		"brokerBaseUrl":               "https://example.com/parvaneh",
		"clientToken":                 "client-token",
		"targetAgentPeerLabel":        "agent-nima",
		"verifyTls":                   true,
		"http2Ctl":                    false,
		"httpPort":                    18092,
		"socksPort":                   11092,
		"dataUploadMaxBatchBytes":     262144,
		"dataUploadFlushDelaySeconds": 0.006,
		"idleRepollCtlSeconds":        0.02,
		"idleRepollDataSeconds":       0.08,
	})
	prof, err := parseProfileShare(raw)
	if err != nil {
		t.Fatal(err)
	}
	if prof.Name != "CLI test" {
		t.Fatalf("unexpected name: %q", prof.Name)
	}
	if prof.BrokerBaseURL != "https://example.com/parvaneh" {
		t.Fatalf("unexpected broker: %q", prof.BrokerBaseURL)
	}
	if !prof.VerifyTLS {
		t.Fatal("verifyTls was not parsed")
	}
	if prof.HTTP2Ctl {
		t.Fatal("http2Ctl false was not parsed")
	}
	if prof.DataUploadMaxBatchBytes != 262144 {
		t.Fatalf("unexpected data batch: %d", prof.DataUploadMaxBatchBytes)
	}
	if prof.TargetAgentPeerLabel != "agent-nima" {
		t.Fatalf("unexpected target agent: %q", prof.TargetAgentPeerLabel)
	}
}

func TestImportProfilesAndRedactedConfig(t *testing.T) {
	home := t.TempDir()
	raw := shareText(t, map[string]interface{}{
		"name":          "Imported",
		"brokerBaseUrl": "https://example.com/parvaneh",
		"clientToken":   "secret-client-token",
	})
	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := run([]string{"--home", home, "import", raw}, &out, &errOut); err != nil {
		t.Fatalf("import failed: %v stderr=%s", err, errOut.String())
	}
	p, err := resolvePaths(home)
	if err != nil {
		t.Fatal(err)
	}
	store, err := loadProfiles(p)
	if err != nil {
		t.Fatal(err)
	}
	prof, err := store.selectProfile("")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRuntimeConfig(p, prof, "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	configData, err := os.ReadFile(p.runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(configData), `"target_agent_peer_label"`) {
		t.Fatal("runtime config did not include target agent field")
	}
	out.Reset()
	if err := run([]string{"--home", home, "config"}, &out, &errOut); err != nil {
		t.Fatalf("config failed: %v", err)
	}
	if strings.Contains(out.String(), "secret-client-token") {
		t.Fatal("redacted config leaked client token")
	}
	if !strings.Contains(out.String(), "<redacted>") {
		t.Fatal("config did not mark client token as redacted")
	}
}

func TestResolveHelperBinUsesEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "twoman-helper-agent")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TWOMAN_HELPER_BIN", path)
	resolved, err := resolveHelperBin("")
	if err != nil {
		t.Fatal(err)
	}
	if resolved != path {
		t.Fatalf("unexpected helper path: %s", resolved)
	}
}

func TestUsageShowsCleanTwomanFlow(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := run([]string{"--help"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if !strings.Contains(text, "twoman [--home DIR] connect [--profile NAME]") {
		t.Fatalf("usage does not show clean connect flow:\n%s", text)
	}
	if strings.Contains(text, "twoman-client") {
		t.Fatalf("usage still exposes old binary name:\n%s", text)
	}
}

func TestHelperSearchPathsIncludeBundleAndInstallLocations(t *testing.T) {
	paths := helperSearchPaths("/tmp/twoman-bundle/twoman")
	joined := strings.Join(paths, "\n")
	for _, expected := range []string{
		"/tmp/twoman-bundle/twoman-helper-agent",
		"/tmp/lib/twoman/twoman-helper-agent",
		"/usr/local/lib/twoman/twoman-helper-agent",
		"/usr/lib/twoman/twoman-helper-agent",
		"/opt/twoman/client/twoman-helper-agent",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("expected helper search path %q in:\n%s", expected, joined)
		}
	}
}

func TestReserveFreePort(t *testing.T) {
	port, err := reserveFreePort("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if port <= 0 || port > 65535 {
		t.Fatalf("invalid port: %d", port)
	}
}
