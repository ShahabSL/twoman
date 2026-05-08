package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	commandName        = "twoman"
	profileSharePrefix = "twoman://profile?data="
	defaultHTTPPort    = 18092
	defaultSOCKSPort   = 11092
	clientServiceName  = "twoman-client.service"
)

type profile struct {
	ID                          string  `json:"id,omitempty"`
	Name                        string  `json:"name"`
	BrokerBaseURL               string  `json:"brokerBaseUrl"`
	ClientToken                 string  `json:"clientToken"`
	TargetAgentPeerLabel        string  `json:"targetAgentPeerLabel,omitempty"`
	VerifyTLS                   bool    `json:"verifyTls"`
	HTTP2Ctl                    bool    `json:"http2Ctl"`
	HTTP2Data                   bool    `json:"http2Data"`
	ShareLANSocks               bool    `json:"shareLanSocks"`
	HTTPPort                    int     `json:"httpPort"`
	SOCKSPort                   int     `json:"socksPort"`
	HTTPTimeoutSeconds          int     `json:"httpTimeoutSeconds"`
	FlushDelaySeconds           float64 `json:"flushDelaySeconds"`
	MaxBatchBytes               int     `json:"maxBatchBytes"`
	DataUploadMaxBatchBytes     int     `json:"dataUploadMaxBatchBytes"`
	DataUploadFlushDelaySeconds float64 `json:"dataUploadFlushDelaySeconds"`
	IdleRepollCtlSeconds        float64 `json:"idleRepollCtlSeconds"`
	IdleRepollDataSeconds       float64 `json:"idleRepollDataSeconds"`
	TraceEnabled                bool    `json:"traceEnabled"`
}

type profileStore struct {
	Default  string    `json:"default"`
	Profiles []profile `json:"profiles"`
}

type runtimeState struct {
	PID             int    `json:"pid"`
	ProfileName     string `json:"profileName"`
	HelperBin       string `json:"helperBin"`
	ConfigPath      string `json:"configPath"`
	ListenStatePath string `json:"listenStatePath"`
	LogPath         string `json:"logPath"`
	ServiceName     string `json:"serviceName,omitempty"`
	StartedAt       string `json:"startedAt"`
}

type listenState struct {
	HTTPHost  string `json:"http_host"`
	SOCKSHost string `json:"socks_host"`
	HTTPPort  int    `json:"http_port"`
	SOCKSPort int    `json:"socks_port"`
}

type paths struct {
	home             string
	profilesPath     string
	currentPath      string
	runtimeDir       string
	runtimeStatePath string
	runtimeConfig    string
	listenStatePath  string
	logPath          string
	systemdUserDir   string
	serviceUnitPath  string
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	global := flag.NewFlagSet(commandName, flag.ContinueOnError)
	global.SetOutput(stderr)
	helpPrinted := false
	global.Usage = func() {
		helpPrinted = true
		printUsage(stdout)
	}
	homeFlag := global.String("home", "", "state directory; defaults to TWOMAN_CLIENT_HOME or ~/.local/state/twoman/client")
	if err := global.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			if !helpPrinted {
				printUsage(stdout)
			}
			return nil
		}
		return err
	}
	remaining := global.Args()
	if len(remaining) == 0 {
		printUsage(stdout)
		return nil
	}
	command := remaining[0]
	p, err := resolvePaths(*homeFlag)
	if err != nil {
		return err
	}
	switch command {
	case "import":
		return cmdImport(p, remaining[1:], stdout, stderr)
	case "profiles":
		return cmdProfiles(p, stdout)
	case "connect":
		return cmdConnect(p, remaining[1:], stdout, stderr)
	case "service":
		return cmdService(p, remaining[1:], stdout, stderr)
	case "status":
		return cmdStatus(p, remaining[1:], stdout, stderr)
	case "logs":
		return cmdLogs(p, remaining[1:], stdout, stderr)
	case "stop", "disconnect":
		return cmdStop(p, stdout)
	case "config", "show-config":
		return cmdConfig(p, remaining[1:], stdout, stderr)
	case "help", "-h", "--help":
		printUsage(stdout)
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, `Twoman headless client

Usage:
  twoman [--home DIR] import [--name NAME] [--file FILE|PROFILE_TEXT]
  twoman [--home DIR] connect [--profile NAME]
  twoman [--home DIR] service install [--profile NAME]
  twoman [--home DIR] service start|stop|restart|status|logs|uninstall
  twoman [--home DIR] status [--json]
  twoman [--home DIR] logs [-n LINES]
  twoman [--home DIR] disconnect
  twoman [--home DIR] profiles
  twoman [--home DIR] config

The CLI stores profiles locally, starts the Go helper in headless mode, and
prints the local SOCKS5 and HTTP proxy endpoints.`)
}

func resolvePaths(homeOverride string) (paths, error) {
	home := strings.TrimSpace(homeOverride)
	if home == "" {
		home = strings.TrimSpace(os.Getenv("TWOMAN_CLIENT_HOME"))
	}
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return paths{}, err
		}
		home = filepath.Join(userHome, ".local", "state", "twoman", "client")
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return paths{}, err
	}
	systemdDir, err := resolveSystemdUserDir()
	if err != nil {
		return paths{}, err
	}
	return paths{
		home:             home,
		profilesPath:     filepath.Join(home, "profiles.json"),
		currentPath:      filepath.Join(home, "current-profile"),
		runtimeDir:       filepath.Join(home, "runtime"),
		runtimeStatePath: filepath.Join(home, "runtime", "helper-state.json"),
		runtimeConfig:    filepath.Join(home, "runtime", "helper-config.json"),
		listenStatePath:  filepath.Join(home, "runtime", "listen-state.json"),
		logPath:          filepath.Join(home, "logs", "helper.log"),
		systemdUserDir:   systemdDir,
		serviceUnitPath:  filepath.Join(systemdDir, clientServiceName),
	}, nil
}

func resolveSystemdUserDir() (string, error) {
	configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if configHome == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		configHome = filepath.Join(userHome, ".config")
	}
	return filepath.Abs(filepath.Join(configHome, "systemd", "user"))
}

func ensureDirs(p paths) error {
	for _, dir := range []string{p.home, p.runtimeDir, filepath.Dir(p.logPath)} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	return nil
}

func cmdImport(p paths, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("import", flag.ContinueOnError)
	fs.SetOutput(stderr)
	nameOverride := fs.String("name", "", "profile name override")
	filePath := fs.String("file", "", "read profile text from file; use - for stdin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var raw string
	if *filePath != "" {
		data, err := readInputFile(*filePath)
		if err != nil {
			return err
		}
		raw = string(data)
	} else if fs.NArg() > 0 {
		raw = strings.Join(fs.Args(), " ")
	} else {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		raw = string(data)
	}
	prof, err := parseProfileShare(raw)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*nameOverride) != "" {
		prof.Name = strings.TrimSpace(*nameOverride)
	}
	if err := prof.validate(); err != nil {
		return err
	}
	store, err := loadProfiles(p)
	if err != nil {
		return err
	}
	store.upsert(prof)
	store.Default = prof.Name
	if err := saveProfiles(p, store); err != nil {
		return err
	}
	if err := os.WriteFile(p.currentPath, []byte(prof.Name+"\n"), 0600); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Imported profile: %s\n", prof.Name)
	return nil
}

func cmdProfiles(p paths, stdout io.Writer) error {
	store, err := loadProfiles(p)
	if err != nil {
		return err
	}
	if len(store.Profiles) == 0 {
		fmt.Fprintln(stdout, "No profiles imported.")
		return nil
	}
	for _, prof := range store.Profiles {
		marker := " "
		if prof.Name == store.Default {
			marker = "*"
		}
		fmt.Fprintf(stdout, "%s %s\t%s\tSOCKS:%d\tHTTP:%d\n", marker, prof.Name, prof.BrokerBaseURL, prof.SOCKSPort, prof.HTTPPort)
	}
	return nil
}

func cmdConnect(p paths, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("connect", flag.ContinueOnError)
	fs.SetOutput(stderr)
	profileName := fs.String("profile", "", "profile name; defaults to imported default")
	helperBin := fs.String("helper-bin", "", "advanced: path to twoman-helper-agent binary")
	foreground := fs.Bool("foreground", false, "run helper in the foreground")
	listenHost := fs.String("listen-host", "", "override local listen host")
	httpPort := fs.Int("http-port", -1, "override HTTP proxy port; use 0 for an ephemeral port")
	socksPort := fs.Int("socks-port", -1, "override SOCKS5 proxy port; use 0 for an ephemeral port")
	if err := fs.Parse(args); err != nil {
		return err
	}
	store, err := loadProfiles(p)
	if err != nil {
		return err
	}
	prof, err := store.selectProfile(*profileName)
	if err != nil {
		return err
	}
	if *httpPort >= 0 {
		prof.HTTPPort = *httpPort
	}
	if *socksPort >= 0 {
		prof.SOCKSPort = *socksPort
	}
	host := strings.TrimSpace(*listenHost)
	if host == "" {
		if prof.ShareLANSocks {
			host = "0.0.0.0"
		} else {
			host = "127.0.0.1"
		}
	}
	if prof.HTTPPort == 0 {
		port, err := reserveFreePort(host)
		if err != nil {
			return fmt.Errorf("reserve HTTP port: %w", err)
		}
		prof.HTTPPort = port
	}
	if prof.SOCKSPort == 0 {
		port, err := reserveFreePort(host)
		if err != nil {
			return fmt.Errorf("reserve SOCKS port: %w", err)
		}
		prof.SOCKSPort = port
	}
	bin, err := resolveHelperBin(*helperBin)
	if err != nil {
		return err
	}
	if *foreground {
		return runForegroundHelper(p, prof, bin, host, stdout)
	}
	if status, ok := currentStatus(p); ok && status.Running {
		if status.ProfileName != "" && status.ProfileName != prof.Name {
			return fmt.Errorf(
				"already connected with profile %q; run `twoman disconnect` before connecting profile %q",
				status.ProfileName,
				prof.Name,
			)
		}
		printStatusText(stdout, status)
		return nil
	}
	return startBackgroundHelper(p, prof, bin, host, stdout)
}

func cmdService(p paths, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		printServiceUsage(stdout)
		return nil
	}
	switch args[0] {
	case "install":
		return cmdServiceInstall(p, args[1:], stdout, stderr)
	case "uninstall", "remove":
		return cmdServiceUninstall(p, stdout)
	case "start", "stop", "restart":
		if err := runSystemctlUser(stdout, stderr, args[0], clientServiceName); err != nil {
			return err
		}
		if args[0] == "stop" {
			_ = os.Remove(p.runtimeStatePath)
			_ = os.Remove(p.listenStatePath)
		}
		return nil
	case "status":
		return runSystemctlUser(stdout, stderr, "status", "--no-pager", clientServiceName)
	case "logs":
		fs := flag.NewFlagSet("service logs", flag.ContinueOnError)
		fs.SetOutput(stderr)
		lines := fs.Int("n", 120, "number of journal lines")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return runJournalctlUser(stdout, stderr, "-u", clientServiceName, "-n", strconv.Itoa(*lines), "--no-pager")
	case "help", "-h", "--help":
		printServiceUsage(stdout)
		return nil
	default:
		return fmt.Errorf("unknown service command %q", args[0])
	}
}

func printServiceUsage(w io.Writer) {
	fmt.Fprintln(w, `Twoman client service

Usage:
  twoman service install [--profile NAME]
  twoman service start|stop|restart|status
  twoman service logs [-n LINES]
  twoman service uninstall

The service uses systemd --user and runs the selected profile after login.
Run sudo loginctl enable-linger "$USER" if it must start before login.`)
}

func cmdServiceInstall(p paths, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("service install", flag.ContinueOnError)
	fs.SetOutput(stderr)
	profileName := fs.String("profile", "", "profile name; defaults to imported default")
	helperBin := fs.String("helper-bin", "", "advanced: path to twoman-helper-agent binary")
	listenHost := fs.String("listen-host", "", "override local listen host")
	httpPort := fs.Int("http-port", -1, "override HTTP proxy port; use 0 for an ephemeral port")
	socksPort := fs.Int("socks-port", -1, "override SOCKS5 proxy port; use 0 for an ephemeral port")
	noEnable := fs.Bool("no-enable", false, "write the service but do not enable it")
	noStart := fs.Bool("no-start", false, "write the service but do not start it")
	now := fs.Bool("now", true, "enable and start immediately")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !*now {
		*noStart = true
	}
	store, err := loadProfiles(p)
	if err != nil {
		return err
	}
	prof, err := store.selectProfile(*profileName)
	if err != nil {
		return err
	}
	bin, err := resolveHelperBin(*helperBin)
	if err != nil {
		return err
	}
	twomanBin, err := os.Executable()
	if err != nil {
		return err
	}
	twomanBin, err = filepath.Abs(twomanBin)
	if err != nil {
		return err
	}
	unit, err := buildServiceUnit(p, twomanBin, serviceInstallOptions{
		ProfileName: prof.Name,
		HelperBin:   bin,
		ListenHost:  strings.TrimSpace(*listenHost),
		HTTPPort:    *httpPort,
		SOCKSPort:   *socksPort,
	})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(p.systemdUserDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(p.serviceUnitPath, []byte(unit), 0600); err != nil {
		return err
	}
	if err := runSystemctlUser(stdout, stderr, "daemon-reload"); err != nil {
		return err
	}
	if !*noEnable {
		if err := runSystemctlUser(stdout, stderr, "enable", clientServiceName); err != nil {
			return err
		}
	}
	if !*noStart {
		if err := runSystemctlUser(stdout, stderr, "restart", clientServiceName); err != nil {
			return err
		}
	}
	fmt.Fprintf(stdout, "Installed %s\n", clientServiceName)
	fmt.Fprintf(stdout, "Unit: %s\n", p.serviceUnitPath)
	if !*noStart {
		fmt.Fprintln(stdout, "Twoman service started.")
	}
	if !*noEnable {
		fmt.Fprintln(stdout, "Twoman service enabled for this user.")
		fmt.Fprintln(stdout, "For boot without login, run: sudo loginctl enable-linger \"$USER\"")
	}
	return nil
}

func cmdServiceUninstall(p paths, stdout io.Writer) error {
	_ = runSystemctlUser(io.Discard, io.Discard, "disable", "--now", clientServiceName)
	if err := os.Remove(p.serviceUnitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = runSystemctlUser(io.Discard, io.Discard, "daemon-reload")
	_ = os.Remove(p.runtimeStatePath)
	_ = os.Remove(p.listenStatePath)
	fmt.Fprintf(stdout, "Uninstalled %s\n", clientServiceName)
	return nil
}

type serviceInstallOptions struct {
	ProfileName string
	HelperBin   string
	ListenHost  string
	HTTPPort    int
	SOCKSPort   int
}

func buildServiceUnit(p paths, twomanBin string, opts serviceInstallOptions) (string, error) {
	if strings.TrimSpace(twomanBin) == "" {
		return "", errors.New("twoman binary path is required")
	}
	args := []string{twomanBin, "--home", p.home, "connect", "--foreground"}
	if strings.TrimSpace(opts.ProfileName) != "" {
		args = append(args, "--profile", opts.ProfileName)
	}
	if strings.TrimSpace(opts.HelperBin) != "" {
		args = append(args, "--helper-bin", opts.HelperBin)
	}
	if strings.TrimSpace(opts.ListenHost) != "" {
		args = append(args, "--listen-host", opts.ListenHost)
	}
	if opts.HTTPPort >= 0 {
		args = append(args, "--http-port", strconv.Itoa(opts.HTTPPort))
	}
	if opts.SOCKSPort >= 0 {
		args = append(args, "--socks-port", strconv.Itoa(opts.SOCKSPort))
	}
	var b strings.Builder
	b.WriteString("[Unit]\n")
	b.WriteString("Description=Twoman client\n")
	b.WriteString("After=network-online.target\n")
	b.WriteString("Wants=network-online.target\n\n")
	b.WriteString("[Service]\n")
	b.WriteString("Type=simple\n")
	b.WriteString("ExecStart=")
	b.WriteString(systemdExecStart(args))
	b.WriteString("\n")
	b.WriteString("Restart=always\n")
	b.WriteString("RestartSec=3\n")
	b.WriteString("KillMode=control-group\n")
	b.WriteString("StandardOutput=journal\n")
	b.WriteString("StandardError=journal\n\n")
	b.WriteString("[Install]\n")
	b.WriteString("WantedBy=default.target\n")
	return b.String(), nil
}

func systemdExecStart(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, systemdQuoteArg(arg))
	}
	return strings.Join(quoted, " ")
}

func systemdQuoteArg(arg string) string {
	if arg == "" {
		return `""`
	}
	if !strings.ContainsAny(arg, " \t\n\"\\'") {
		return arg
	}
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\t", `\t`,
	)
	return `"` + replacer.Replace(arg) + `"`
}

func runSystemctlUser(stdout, stderr io.Writer, args ...string) error {
	fullArgs := append([]string{"--user"}, args...)
	cmd := exec.Command("systemctl", fullArgs...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func runJournalctlUser(stdout, stderr io.Writer, args ...string) error {
	fullArgs := append([]string{"--user"}, args...)
	cmd := exec.Command("journalctl", fullArgs...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func userServiceIsActive(serviceName string) bool {
	cmd := exec.Command("systemctl", "--user", "is-active", "--quiet", serviceName)
	return cmd.Run() == nil
}

func cmdStatus(p paths, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOutput := fs.Bool("json", false, "print JSON status")
	if err := fs.Parse(args); err != nil {
		return err
	}
	status, _ := currentStatus(p)
	if *jsonOutput {
		data, err := json.MarshalIndent(status, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(stdout, string(data))
		return nil
	}
	printStatusText(stdout, status)
	if !status.Running {
		return errors.New("not connected")
	}
	return nil
}

func cmdLogs(p paths, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(stderr)
	lines := fs.Int("n", 80, "number of log lines")
	if err := fs.Parse(args); err != nil {
		return err
	}
	text, err := tailFile(p.logPath, *lines)
	if err != nil {
		return err
	}
	fmt.Fprint(stdout, text)
	if !strings.HasSuffix(text, "\n") {
		fmt.Fprintln(stdout)
	}
	return nil
}

func cmdStop(p paths, stdout io.Writer) error {
	if userServiceIsActive(clientServiceName) {
		if err := runSystemctlUser(stdout, os.Stderr, "stop", clientServiceName); err != nil {
			return err
		}
	}
	state, err := readRuntimeState(p.runtimeStatePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(stdout, "Twoman is not running.")
			return nil
		}
		return err
	}
	if state.PID > 0 && processMatchesState(state) && processRunning(state.PID) {
		if err := terminatePID(state.PID, 8*time.Second); err != nil {
			return err
		}
	}
	_ = os.Remove(p.runtimeStatePath)
	_ = os.Remove(p.listenStatePath)
	fmt.Fprintln(stdout, "Twoman stopped.")
	return nil
}

func cmdConfig(p paths, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("config", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showSecrets := fs.Bool("show-secrets", false, "include client token in output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	data, err := os.ReadFile(p.runtimeConfig)
	if err != nil {
		return err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}
	if !*showSecrets {
		if _, ok := payload["client_token"]; ok {
			payload["client_token"] = "<redacted>"
		}
	}
	out, err := marshalIndentNoEscape(payload)
	if err != nil {
		return err
	}
	fmt.Fprintln(stdout, string(out))
	return nil
}

func readInputFile(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

func parseProfileShare(raw string) (profile, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return profile{}, errors.New("empty profile text")
	}
	var payload []byte
	if strings.HasPrefix(text, profileSharePrefix) {
		encoded := strings.TrimPrefix(text, profileSharePrefix)
		decoded, err := decodeBase64URL(encoded)
		if err != nil {
			return profile{}, err
		}
		payload = decoded
	} else if strings.HasPrefix(text, "{") {
		payload = []byte(text)
	} else {
		decoded, err := decodeBase64URL(text)
		if err != nil {
			return profile{}, err
		}
		payload = decoded
	}
	var rawMap map[string]interface{}
	if err := json.Unmarshal(payload, &rawMap); err != nil {
		return profile{}, err
	}
	prof := profileFromMap(rawMap)
	if prof.ID == "" {
		prof.ID = fmt.Sprintf("profile-%d", time.Now().UnixNano())
	}
	return prof, nil
}

func decodeBase64URL(text string) ([]byte, error) {
	padded := text + strings.Repeat("=", (4-len(text)%4)%4)
	return base64.URLEncoding.DecodeString(padded)
}

func marshalIndentNoEscape(value interface{}) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func profileFromMap(payload map[string]interface{}) profile {
	return profile{
		ID:                          stringField(payload, "id"),
		Name:                        defaultString(stringField(payload, "name"), "Imported profile"),
		BrokerBaseURL:               stringField(payload, "brokerBaseUrl", "broker_base_url"),
		ClientToken:                 stringField(payload, "clientToken", "client_token"),
		TargetAgentPeerLabel:        stringField(payload, "targetAgentPeerLabel", "target_agent_peer_label"),
		VerifyTLS:                   boolField(payload, false, "verifyTls", "verify_tls"),
		HTTP2Ctl:                    boolField(payload, true, "http2Ctl", "http2_ctl"),
		HTTP2Data:                   boolField(payload, false, "http2Data", "http2_data"),
		ShareLANSocks:               boolField(payload, false, "shareLanSocks", "share_lan_socks"),
		HTTPPort:                    stableLocalPortField(payload, defaultHTTPPort, "httpPort", "http_port"),
		SOCKSPort:                   stableLocalPortField(payload, defaultSOCKSPort, "socksPort", "socks_port"),
		HTTPTimeoutSeconds:          intField(payload, 30, "httpTimeoutSeconds", "http_timeout_seconds"),
		FlushDelaySeconds:           floatField(payload, 0.01, "flushDelaySeconds", "flush_delay_seconds"),
		MaxBatchBytes:               legacyAutoBatch(intField(payload, 0, "maxBatchBytes", "max_batch_bytes")),
		DataUploadMaxBatchBytes:     legacyAutoBatch(intField(payload, 0, "dataUploadMaxBatchBytes", "data_upload_max_batch_bytes")),
		DataUploadFlushDelaySeconds: floatField(payload, 0, "dataUploadFlushDelaySeconds", "data_upload_flush_delay_seconds"),
		IdleRepollCtlSeconds:        floatField(payload, 0.05, "idleRepollCtlSeconds", "idle_repoll_ctl_seconds"),
		IdleRepollDataSeconds:       floatField(payload, 0.1, "idleRepollDataSeconds", "idle_repoll_data_seconds"),
		TraceEnabled:                boolField(payload, false, "traceEnabled", "trace_enabled"),
	}
}

func stableLocalPortField(payload map[string]interface{}, fallback int, keys ...string) int {
	value := intField(payload, fallback, keys...)
	if value == 0 {
		return fallback
	}
	return value
}

func legacyAutoBatch(value int) int {
	if value == 65536 {
		return 0
	}
	return value
}

func (p profile) validate() error {
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("profile name is required")
	}
	if strings.TrimSpace(p.BrokerBaseURL) == "" {
		return errors.New("broker URL is required")
	}
	if strings.TrimSpace(p.ClientToken) == "" {
		return errors.New("client token is required")
	}
	if p.HTTPPort < 0 || p.HTTPPort > 65535 || p.SOCKSPort < 0 || p.SOCKSPort > 65535 {
		return errors.New("proxy ports must be between 0 and 65535")
	}
	return nil
}

func loadProfiles(p paths) (profileStore, error) {
	if err := ensureDirs(p); err != nil {
		return profileStore{}, err
	}
	data, err := os.ReadFile(p.profilesPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return profileStore{}, nil
		}
		return profileStore{}, err
	}
	var store profileStore
	if err := json.Unmarshal(data, &store); err != nil {
		return profileStore{}, err
	}
	for index := range store.Profiles {
		store.Profiles[index].MaxBatchBytes = legacyAutoBatch(store.Profiles[index].MaxBatchBytes)
		store.Profiles[index].DataUploadMaxBatchBytes = legacyAutoBatch(store.Profiles[index].DataUploadMaxBatchBytes)
		if store.Profiles[index].HTTPPort == 0 {
			store.Profiles[index].HTTPPort = defaultHTTPPort
		}
		if store.Profiles[index].SOCKSPort == 0 {
			store.Profiles[index].SOCKSPort = defaultSOCKSPort
		}
	}
	return store, nil
}

func saveProfiles(p paths, store profileStore) error {
	if err := ensureDirs(p); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(p.profilesPath, data, 0600)
}

func (s *profileStore) upsert(prof profile) {
	for index, existing := range s.Profiles {
		if existing.Name == prof.Name {
			s.Profiles[index] = prof
			return
		}
	}
	s.Profiles = append(s.Profiles, prof)
}

func (s profileStore) selectProfile(name string) (profile, error) {
	selected := strings.TrimSpace(name)
	if selected == "" {
		selected = strings.TrimSpace(s.Default)
	}
	if selected == "" && len(s.Profiles) == 1 {
		selected = s.Profiles[0].Name
	}
	if selected == "" {
		return profile{}, errors.New("no default profile; import one first")
	}
	for _, prof := range s.Profiles {
		if prof.Name == selected {
			return prof, nil
		}
	}
	return profile{}, fmt.Errorf("profile %q not found", selected)
}

func runForegroundHelper(p paths, prof profile, helperBin, listenHost string, stdout io.Writer) error {
	if err := writeRuntimeConfig(p, prof, listenHost); err != nil {
		return err
	}
	cmd := exec.Command(helperBin, "--mode", "helper", "--config", p.runtimeConfig)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Dir = p.runtimeDir
	cmd.Env = helperEnv(prof)
	if err := cmd.Start(); err != nil {
		return err
	}
	state := runtimeState{
		PID:             cmd.Process.Pid,
		ProfileName:     prof.Name,
		HelperBin:       helperBin,
		ConfigPath:      p.runtimeConfig,
		ListenStatePath: p.listenStatePath,
		LogPath:         p.logPath,
		ServiceName:     clientServiceName,
		StartedAt:       time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeRuntimeState(p.runtimeStatePath, state); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	if ls, err := waitForListenState(p.listenStatePath, 20*time.Second); err == nil {
		printConnected(stdout, state.PID, ls)
	} else {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
		removeRuntimeStateForPID(p, state.PID)
		return err
	}
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	go func() {
		<-sigCh
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}()
	err := cmd.Wait()
	removeRuntimeStateForPID(p, state.PID)
	return err
}

func startBackgroundHelper(p paths, prof profile, helperBin, listenHost string, stdout io.Writer) error {
	if err := writeRuntimeConfig(p, prof, listenHost); err != nil {
		return err
	}
	logFile, err := os.OpenFile(p.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(helperBin, "--mode", "helper", "--config", p.runtimeConfig)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Dir = p.runtimeDir
	cmd.Env = helperEnv(prof)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	state := runtimeState{
		PID:             cmd.Process.Pid,
		ProfileName:     prof.Name,
		HelperBin:       helperBin,
		ConfigPath:      p.runtimeConfig,
		ListenStatePath: p.listenStatePath,
		LogPath:         p.logPath,
		StartedAt:       time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeRuntimeState(p.runtimeStatePath, state); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	ls, err := waitForListenState(p.listenStatePath, 20*time.Second)
	if err != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
		return fmt.Errorf("%w\n%s", err, mustTailFile(p.logPath, 80))
	}
	_ = cmd.Process.Release()
	printConnected(stdout, state.PID, ls)
	return nil
}

func writeRuntimeConfig(p paths, prof profile, listenHost string) error {
	if err := ensureDirs(p); err != nil {
		return err
	}
	_ = os.Remove(p.listenStatePath)
	config := map[string]interface{}{
		"transport":                     "http",
		"transport_profile":             "auto",
		"broker_base_url":               prof.BrokerBaseURL,
		"client_token":                  prof.ClientToken,
		"target_agent_peer_label":       prof.TargetAgentPeerLabel,
		"auth_mode":                     "bearer",
		"legacy_custom_headers_enabled": false,
		"binary_media_type":             "image/webp",
		"route_template":                "/{lane}/{direction}",
		"health_template":               "/health",
		"peer_id":                       "twoman-cli-" + sanitizeName(prof.Name),
		"listen_host":                   listenHost,
		"http_listen_port":              prof.HTTPPort,
		"socks_listen_port":             prof.SOCKSPort,
		"listen_state_path":             p.listenStatePath,
		"http_timeout_seconds":          prof.HTTPTimeoutSeconds,
		"heartbeat_interval_seconds":    15,
		"interval_jitter_ratio":         0.2,
		"backoff_initial_delay_seconds": 0.1,
		"backoff_max_delay_seconds":     5,
		"flush_delay_seconds":           prof.FlushDelaySeconds,
		"verify_tls":                    prof.VerifyTLS,
		"streaming_up_lanes":            []string{},
		"idle_repoll_delay_seconds": map[string]float64{
			"ctl":  prof.IdleRepollCtlSeconds,
			"data": prof.IdleRepollDataSeconds,
		},
		"http2_enabled": map[string]bool{
			"ctl":  prof.HTTP2Ctl,
			"data": prof.HTTP2Data,
		},
		"up_workers": map[string]int{
			"data": 16,
		},
		"adaptive_upload": map[string]interface{}{
			"enabled":                   true,
			"lanes":                     []string{"data"},
			"min_workers":               2,
			"initial_workers":           6,
			"max_workers":               16,
			"min_batch_bytes":           65536,
			"max_batch_bytes":           524288,
			"increase_after_successes":  2,
			"decrease_after_errors":     1,
			"backlog_threshold_frames":  32,
			"decision_interval_seconds": 0.25,
		},
	}
	if prof.MaxBatchBytes > 0 {
		config["max_batch_bytes"] = prof.MaxBatchBytes
	}
	dataProfile := map[string]interface{}{}
	if prof.DataUploadMaxBatchBytes > 0 {
		dataProfile["max_batch_bytes"] = prof.DataUploadMaxBatchBytes
	}
	if prof.DataUploadFlushDelaySeconds > 0 {
		dataProfile["flush_delay_seconds"] = prof.DataUploadFlushDelaySeconds
	}
	if len(dataProfile) > 0 {
		config["upload_profiles"] = map[string]interface{}{"data": dataProfile}
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(p.runtimeConfig, data, 0600)
}

func helperEnv(prof profile) []string {
	value := "0"
	if prof.TraceEnabled {
		value = "1"
	}
	return append(os.Environ(), "TWOMAN_TRACE="+value)
}

func waitForListenState(path string, timeout time.Duration) (listenState, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		ls, err := readListenState(path)
		if err == nil && ls.HTTPPort > 0 && ls.SOCKSPort > 0 {
			return ls, nil
		}
		lastErr = err
		time.Sleep(200 * time.Millisecond)
	}
	if lastErr != nil {
		return listenState{}, fmt.Errorf("timed out waiting for helper listen state: %w", lastErr)
	}
	return listenState{}, errors.New("timed out waiting for helper listen state")
}

func readListenState(path string) (listenState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return listenState{}, err
	}
	var state listenState
	if err := json.Unmarshal(data, &state); err != nil {
		return listenState{}, err
	}
	return state, nil
}

func readRuntimeState(path string) (runtimeState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return runtimeState{}, err
	}
	var state runtimeState
	if err := json.Unmarshal(data, &state); err != nil {
		return runtimeState{}, err
	}
	return state, nil
}

func writeRuntimeState(path string, state runtimeState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0600)
}

func removeRuntimeStateForPID(p paths, pid int) {
	state, err := readRuntimeState(p.runtimeStatePath)
	if err != nil {
		return
	}
	if state.PID == pid {
		_ = os.Remove(p.runtimeStatePath)
		_ = os.Remove(p.listenStatePath)
	}
}

type statusPayload struct {
	Running     bool   `json:"running"`
	ProfileName string `json:"profileName,omitempty"`
	PID         int    `json:"pid,omitempty"`
	HTTPHost    string `json:"httpHost,omitempty"`
	HTTPPort    int    `json:"httpPort,omitempty"`
	SOCKSHost   string `json:"socksHost,omitempty"`
	SOCKSPort   int    `json:"socksPort,omitempty"`
	ConfigPath  string `json:"configPath,omitempty"`
	LogPath     string `json:"logPath,omitempty"`
	Message     string `json:"message"`
}

func currentStatus(p paths) (statusPayload, bool) {
	state, err := readRuntimeState(p.runtimeStatePath)
	if err != nil {
		return statusPayload{Running: false, Message: "disconnected"}, false
	}
	status := statusPayload{
		ProfileName: state.ProfileName,
		PID:         state.PID,
		ConfigPath:  state.ConfigPath,
		LogPath:     state.LogPath,
	}
	if state.PID <= 0 || !processMatchesState(state) || !processRunning(state.PID) {
		status.Running = false
		status.Message = "stale state; helper is not running"
		return status, false
	}
	status.Running = true
	status.Message = "connected"
	if ls, err := readListenState(state.ListenStatePath); err == nil {
		status.HTTPHost = ls.HTTPHost
		status.HTTPPort = ls.HTTPPort
		status.SOCKSHost = ls.SOCKSHost
		status.SOCKSPort = ls.SOCKSPort
	}
	return status, true
}

func printConnected(w io.Writer, pid int, ls listenState) {
	fmt.Fprintln(w, "Twoman connected")
	fmt.Fprintf(w, "SOCKS5: %s:%d\n", ls.SOCKSHost, ls.SOCKSPort)
	fmt.Fprintf(w, "HTTP:   %s:%d\n", ls.HTTPHost, ls.HTTPPort)
	fmt.Fprintf(w, "PID:    %d\n", pid)
	fmt.Fprintln(w, "Use either proxy endpoint in apps that support HTTP or SOCKS5 proxies.")
}

func printStatusText(w io.Writer, status statusPayload) {
	if !status.Running {
		fmt.Fprintf(w, "Twoman disconnected: %s\n", status.Message)
		return
	}
	fmt.Fprintln(w, "Twoman connected")
	if status.ProfileName != "" {
		fmt.Fprintf(w, "Profile: %s\n", status.ProfileName)
	}
	if status.SOCKSPort > 0 {
		fmt.Fprintf(w, "SOCKS5:  %s:%d\n", defaultString(status.SOCKSHost, "127.0.0.1"), status.SOCKSPort)
	}
	if status.HTTPPort > 0 {
		fmt.Fprintf(w, "HTTP:    %s:%d\n", defaultString(status.HTTPHost, "127.0.0.1"), status.HTTPPort)
	}
	if status.PID > 0 {
		fmt.Fprintf(w, "PID:     %d\n", status.PID)
	}
}

func processRunning(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

func processMatchesState(state runtimeState) bool {
	if state.PID <= 0 {
		return false
	}
	cmdline, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(state.PID), "cmdline"))
	if err != nil {
		return processRunning(state.PID)
	}
	text := strings.ReplaceAll(string(cmdline), "\x00", " ")
	return strings.Contains(text, state.ConfigPath) || strings.Contains(text, filepath.Base(state.HelperBin))
}

func terminatePID(pid int, timeout time.Duration) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	_ = proc.Signal(syscall.SIGTERM)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processRunning(pid) {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	_ = proc.Signal(syscall.SIGKILL)
	return nil
}

func resolveHelperBin(value string) (string, error) {
	if strings.TrimSpace(value) != "" {
		return filepath.Abs(value)
	}
	if env := strings.TrimSpace(os.Getenv("TWOMAN_HELPER_BIN")); env != "" {
		return filepath.Abs(env)
	}
	if exe, err := os.Executable(); err == nil {
		for _, candidate := range helperSearchPaths(exe) {
			if isExecutable(candidate) {
				return candidate, nil
			}
		}
	}
	if path, err := exec.LookPath("twoman-helper-agent"); err == nil {
		return path, nil
	}
	return "", errors.New("twoman-helper-agent not found; install the Linux client bundle, place twoman-helper-agent next to twoman, or set TWOMAN_HELPER_BIN")
}

func helperSearchPaths(exePath string) []string {
	var candidates []string
	seen := map[string]bool{}
	add := func(path string) {
		if strings.TrimSpace(path) == "" {
			return
		}
		if !filepath.IsAbs(path) {
			absolute, err := filepath.Abs(path)
			if err == nil {
				path = absolute
			}
		}
		if seen[path] {
			return
		}
		seen[path] = true
		candidates = append(candidates, path)
	}
	if strings.TrimSpace(exePath) != "" {
		exeDir := filepath.Dir(exePath)
		add(filepath.Join(exeDir, "twoman-helper-agent"))
		add(filepath.Clean(filepath.Join(exeDir, "..", "lib", "twoman", "twoman-helper-agent")))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".local", "lib", "twoman", "twoman-helper-agent"))
	}
	add("/usr/local/lib/twoman/twoman-helper-agent")
	add("/usr/lib/twoman/twoman-helper-agent")
	add("/opt/twoman/client/twoman-helper-agent")
	return candidates
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0111 != 0
}

func tailFile(path string, maxLines int) (string, error) {
	if maxLines <= 0 {
		maxLines = 80
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > maxLines {
			copy(lines, lines[len(lines)-maxLines:])
			lines = lines[:maxLines]
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return strings.Join(lines, "\n"), nil
}

func mustTailFile(path string, maxLines int) string {
	text, err := tailFile(path, maxLines)
	if err != nil {
		return ""
	}
	return text
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func stringField(payload map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key]; ok {
			return strings.TrimSpace(fmt.Sprint(value))
		}
	}
	return ""
}

func boolField(payload map[string]interface{}, fallback bool, keys ...string) bool {
	for _, key := range keys {
		value, ok := payload[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			return typed
		case string:
			parsed, err := strconv.ParseBool(typed)
			if err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func intField(payload map[string]interface{}, fallback int, keys ...string) int {
	for _, key := range keys {
		value, ok := payload[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return int(typed)
		case int:
			return typed
		case string:
			parsed, err := strconv.Atoi(strings.TrimSpace(typed))
			if err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func floatField(payload map[string]interface{}, fallback float64, keys ...string) float64 {
	for _, key := range keys {
		value, ok := payload[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return typed
		case int:
			return float64(typed)
		case string:
			parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
			if err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func sanitizeName(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(value) {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			builder.WriteRune(char)
		} else if builder.Len() > 0 && builder.String()[builder.Len()-1] != '-' {
			builder.WriteByte('-')
		}
		if builder.Len() >= 48 {
			break
		}
	}
	cleaned := strings.Trim(builder.String(), "-")
	if cleaned == "" {
		return "default"
	}
	return cleaned
}

func portReady(host string, port int) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 250*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func reserveFreePort(host string) (int, error) {
	probeHost := host
	if probeHost == "" || probeHost == "0.0.0.0" || probeHost == "::" {
		probeHost = "127.0.0.1"
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(probeHost, "0"))
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		return 0, errors.New("listener did not return a TCP port")
	}
	return addr.Port, nil
}
