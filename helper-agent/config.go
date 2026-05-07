package main

import (
	"encoding/json"
	"os"
)

// Config is shared by the Go helper and hidden agent dataplane.
// All fields are optional; SetDefaults fills sensible values.
type Config struct {
	BrokerBaseURL   string            `json:"broker_base_url"`
	ClientToken     string            `json:"client_token"`
	AgentToken      string            `json:"agent_token"`
	AuthMode        string            `json:"auth_mode"`
	BinaryMediaType string            `json:"binary_media_type"`
	UploadBodyMode  string            `json:"upload_body_mode"`
	RouteTemplate   string            `json:"route_template"`
	HSRouteTemplate string            `json:"ws_route_template"`
	HealthTemplate  string            `json:"health_template"`
	LaneRoutes      map[string]string `json:"lane_routes"`

	ListenHost           string `json:"listen_host"`
	HTTPListenPort       int    `json:"http_listen_port"`
	SOCKSListenPort      int    `json:"socks_listen_port"`
	ListenStatePath      string `json:"listen_state_path"`
	PeerID               string `json:"peer_id"`
	TargetAgentPeerLabel string `json:"target_agent_peer_label"`

	HTTPTimeoutSeconds          float64 `json:"http_timeout_seconds"`
	TLSHandshakeTimeoutSeconds  float64 `json:"tls_handshake_timeout_seconds"`
	HeartbeatIntervalSeconds    float64 `json:"heartbeat_interval_seconds"`
	DownReadTimeoutSeconds      float64 `json:"down_read_timeout_seconds"`
	DownStreamMaxSessionSeconds float64 `json:"down_stream_max_session_seconds"`
	IntervalJitterRatio         float64 `json:"interval_jitter_ratio"`
	BackoffInitialDelaySeconds  float64 `json:"backoff_initial_delay_seconds"`
	BackoffMaxDelaySeconds      float64 `json:"backoff_max_delay_seconds"`
	FlushDelaySeconds           float64 `json:"flush_delay_seconds"`
	MaxBatchBytes               int     `json:"max_batch_bytes"`
	MaxFramePayloadBytes        int     `json:"max_frame_payload_bytes"`
	SendQueueTimeoutSeconds     float64 `json:"send_queue_timeout_seconds"`

	VPNPreferIPv4     bool `json:"vpn_prefer_ipv4"`
	VPNFilterAAAA     bool `json:"vpn_filter_aaaa"`
	EnforceConnectSNI bool `json:"enforce_connect_sni"`

	// {"ctl": false, "data": false} or just a bool
	HTTP2Enabled interface{} `json:"http2_enabled"`

	UpstreamProxyURL string                           `json:"upstream_proxy_url"`
	OutboundProxyURL string                           `json:"outbound_proxy_url"`
	Transport        string                           `json:"transport"`
	TransportProfile string                           `json:"transport_profile"`
	UploadProfiles   map[string]UploadProfileOverride `json:"upload_profiles"`
	UpWorkers        map[string]int                   `json:"up_workers"`
	DownParallelism  map[string]int                   `json:"down_parallelism"`
	DownLanes        []string                         `json:"down_lanes"`
	AdaptiveUpload   AdaptiveUploadConfig             `json:"adaptive_upload"`

	// Identity cookie names (optional overrides)
	IdentityCookieNames map[string]string `json:"identity_cookie_names"`

	// UserAgent overrides the browser User-Agent sent to the broker.
	// Leave empty to rotate through a built-in pool each session.
	UserAgent string `json:"user_agent"`

	LegacyCustomHeadersEnabled bool `json:"legacy_custom_headers_enabled"`
	VerifyTLS                  bool `json:"verify_tls"`

	// Internal: populated after parsing
	http2CtlEnabled      bool
	http2DataEnabled     bool
	httpListenPortSet    bool
	socksListenPortSet   bool
	enforceConnectSNISet bool
	verifyTLSSet         bool
}

type UploadProfileOverride struct {
	MaxBatchBytes     int      `json:"max_batch_bytes"`
	FlushDelaySeconds *float64 `json:"flush_delay_seconds"`
}

type AdaptiveUploadConfig struct {
	Enabled                 bool     `json:"enabled"`
	Lanes                   []string `json:"lanes"`
	MinWorkers              int      `json:"min_workers"`
	InitialWorkers          int      `json:"initial_workers"`
	MaxWorkers              int      `json:"max_workers"`
	MinBatchBytes           int      `json:"min_batch_bytes"`
	MaxBatchBytes           int      `json:"max_batch_bytes"`
	IncreaseAfterSuccesses  int      `json:"increase_after_successes"`
	DecreaseAfterErrors     int      `json:"decrease_after_errors"`
	BacklogThresholdFrames  int      `json:"backlog_threshold_frames"`
	DecisionIntervalSeconds float64  `json:"decision_interval_seconds"`
}

func (c *Config) UnmarshalJSON(data []byte) error {
	type alias Config
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	var decoded alias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*c = Config(decoded)
	_, c.httpListenPortSet = raw["http_listen_port"]
	_, c.socksListenPortSet = raw["socks_listen_port"]
	_, c.enforceConnectSNISet = raw["enforce_connect_sni"]
	_, c.verifyTLSSet = raw["verify_tls"]
	return nil
}

func (c *Config) SetDefaults() {
	if c.ListenHost == "" {
		c.ListenHost = "127.0.0.1"
	}
	if !c.httpListenPortSet && c.HTTPListenPort == 0 {
		c.HTTPListenPort = 8080
	}
	if !c.socksListenPortSet && c.SOCKSListenPort == 0 {
		c.SOCKSListenPort = 1080
	}
	if c.HTTPTimeoutSeconds == 0 {
		c.HTTPTimeoutSeconds = 30
	}
	if c.TLSHandshakeTimeoutSeconds == 0 {
		c.TLSHandshakeTimeoutSeconds = 15
	}
	if c.HeartbeatIntervalSeconds == 0 {
		c.HeartbeatIntervalSeconds = 15
	}
	if c.DownReadTimeoutSeconds == 0 {
		c.DownReadTimeoutSeconds = 10
	}
	if c.DownStreamMaxSessionSeconds == 0 {
		c.DownStreamMaxSessionSeconds = 60
	}
	if c.IntervalJitterRatio == 0 {
		c.IntervalJitterRatio = 0.2
	}
	if c.BackoffInitialDelaySeconds == 0 {
		c.BackoffInitialDelaySeconds = 0.1
	}
	if c.BackoffMaxDelaySeconds == 0 {
		c.BackoffMaxDelaySeconds = 5
	}
	if c.FlushDelaySeconds == 0 {
		c.FlushDelaySeconds = 0.01
	}
	if c.MaxBatchBytes == 0 {
		c.MaxBatchBytes = 65536
	}
	if c.MaxFramePayloadBytes == 0 {
		c.MaxFramePayloadBytes = defaultMaxFramePayloadBytes
	}
	if c.SendQueueTimeoutSeconds == 0 {
		c.SendQueueTimeoutSeconds = 5
	}
	if c.BinaryMediaType == "" {
		c.BinaryMediaType = "image/webp"
	}
	if c.UploadBodyMode == "" {
		c.UploadBodyMode = "multipart"
	}
	if c.RouteTemplate == "" {
		c.RouteTemplate = "/{lane}/{direction}"
	}
	if c.HSRouteTemplate == "" {
		c.HSRouteTemplate = "/{lane}"
	}
	if c.HealthTemplate == "" {
		c.HealthTemplate = "/health"
	}
	if c.AuthMode == "" {
		c.AuthMode = "bearer"
	}
	if !c.enforceConnectSNISet {
		c.EnforceConnectSNI = true
	}
	if !c.verifyTLSSet {
		c.VerifyTLS = true
	}

	// Parse http2_enabled
	switch v := c.HTTP2Enabled.(type) {
	case bool:
		c.http2CtlEnabled = v
		c.http2DataEnabled = v
	case map[string]interface{}:
		if b, ok := v["ctl"].(bool); ok {
			c.http2CtlEnabled = b
		}
		if b, ok := v["data"].(bool); ok {
			c.http2DataEnabled = b
		}
	default:
		// nil or unknown: both false (HTTP/1.1)
	}
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	cfg.SetDefaults()
	return &cfg, nil
}
