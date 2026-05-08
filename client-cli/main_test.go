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
		"targetAgentPeerLabel":        "agent-alt",
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
	if prof.TargetAgentPeerLabel != "agent-alt" {
		t.Fatalf("unexpected target agent: %q", prof.TargetAgentPeerLabel)
	}
}

func TestImportedZeroPortsUseStableDefaults(t *testing.T) {
	raw := shareText(t, map[string]interface{}{
		"name":          "Stable local ports",
		"brokerBaseUrl": "https://example.com/parvaneh",
		"clientToken":   "client-token",
		"httpPort":      0,
		"socksPort":     0,
	})
	prof, err := parseProfileShare(raw)
	if err != nil {
		t.Fatal(err)
	}
	if prof.HTTPPort != defaultHTTPPort || prof.SOCKSPort != defaultSOCKSPort {
		t.Fatalf("imported zero ports should migrate to stable defaults, got HTTP %d SOCKS %d", prof.HTTPPort, prof.SOCKSPort)
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
	if !strings.Contains(string(configData), `"adaptive_upload"`) {
		t.Fatal("runtime config did not include adaptive upload defaults")
	}
	if strings.Contains(string(configData), `"upload_profiles"`) {
		t.Fatal("auto profile unexpectedly wrote upload profile overrides")
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

func TestProfilesDeleteAndDefault(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer
	var errOut bytes.Buffer
	alpha := shareText(t, map[string]interface{}{
		"name":          "Alpha",
		"brokerBaseUrl": "https://example.com/parvaneh",
		"clientToken":   "alpha-token",
	})
	beta := shareText(t, map[string]interface{}{
		"name":          "Beta",
		"brokerBaseUrl": "https://example.com/parvaneh",
		"clientToken":   "beta-token",
	})
	if err := run([]string{"--home", home, "import", alpha}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--home", home, "import", beta}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run([]string{"--home", home, "profiles", "default", "Alpha"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Default profile: Alpha") {
		t.Fatalf("unexpected default output: %s", out.String())
	}
	out.Reset()
	if err := run([]string{"--home", home, "profiles", "delete", "Beta"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Deleted profile: Beta") {
		t.Fatalf("unexpected delete output: %s", out.String())
	}
	p, err := resolvePaths(home)
	if err != nil {
		t.Fatal(err)
	}
	store, err := loadProfiles(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.Profiles) != 1 || store.Profiles[0].Name != "Alpha" || store.Default != "Alpha" {
		t.Fatalf("unexpected store after delete: %+v", store)
	}
}

func TestLogsExportRedactsSecrets(t *testing.T) {
	home := t.TempDir()
	exportParent := filepath.Join(t.TempDir(), "exports")
	raw := shareText(t, map[string]interface{}{
		"name":          "Diagnostics",
		"brokerBaseUrl": "https://example.com/parvaneh",
		"clientToken":   "secret-client-token",
	})
	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := run([]string{"--home", home, "import", raw}, &out, &errOut); err != nil {
		t.Fatal(err)
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
	if err := os.WriteFile(p.logPath, []byte("line one\nline two\n"), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run([]string{"--home", home, "logs", "export", "--output", exportParent, "-n", "10"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Diagnostics exported:") {
		t.Fatalf("unexpected export output: %s", out.String())
	}
	entries, err := os.ReadDir(exportParent)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !entries[0].IsDir() {
		t.Fatalf("expected one diagnostics directory, got %v", entries)
	}
	bundle := filepath.Join(exportParent, entries[0].Name())
	for _, name := range []string{"profiles.redacted.json", "runtime-config.redacted.json", "helper.log", "paths.txt"} {
		if _, err := os.Stat(filepath.Join(bundle, name)); err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
	}
	all := strings.Builder{}
	filepath.WalkDir(bundle, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			data, _ := os.ReadFile(path)
			all.Write(data)
		}
		return nil
	})
	if strings.Contains(all.String(), "secret-client-token") {
		t.Fatal("diagnostics export leaked client token")
	}
	if !strings.Contains(all.String(), "<redacted>") {
		t.Fatal("diagnostics export did not redact secret fields")
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
	if !strings.Contains(text, "twoman [--home DIR] service install [--profile NAME]") {
		t.Fatalf("usage does not show service flow:\n%s", text)
	}
	if !strings.Contains(text, "twoman [--home DIR] logs export --output DIR") {
		t.Fatalf("usage does not show diagnostics export flow:\n%s", text)
	}
	if !strings.Contains(text, "twoman [--home DIR] profiles delete NAME") {
		t.Fatalf("usage does not show profile deletion flow:\n%s", text)
	}
	if strings.Contains(text, "twoman-client") {
		t.Fatalf("usage still exposes old binary name:\n%s", text)
	}
}

func TestBuildServiceUnit(t *testing.T) {
	home := t.TempDir()
	p, err := resolvePaths(home)
	if err != nil {
		t.Fatal(err)
	}
	unit, err := buildServiceUnit(p, "/usr/local/bin/twoman", serviceInstallOptions{
		ProfileName: "CLI E2E",
		HelperBin:   "/usr/local/lib/twoman/twoman-helper-agent",
		ListenHost:  "127.0.0.1",
		HTTPPort:    18092,
		SOCKSPort:   11092,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"[Service]",
		"Restart=always",
		"KillMode=control-group",
		"WantedBy=default.target",
		"--home " + home,
		`--profile "CLI E2E"`,
		"--helper-bin /usr/local/lib/twoman/twoman-helper-agent",
		"--http-port 18092",
		"--socks-port 11092",
	} {
		if !strings.Contains(unit, expected) {
			t.Fatalf("expected %q in service unit:\n%s", expected, unit)
		}
	}
}

func TestSystemdQuoteArg(t *testing.T) {
	if got := systemdQuoteArg("plain"); got != "plain" {
		t.Fatalf("unexpected plain quote: %q", got)
	}
	if got := systemdQuoteArg(`name "with" spaces`); got != `"name \"with\" spaces"` {
		t.Fatalf("unexpected escaped quote: %q", got)
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
