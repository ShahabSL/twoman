package main

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// defaultUserAgents is the pool rotated when no user_agent is configured.
var defaultUserAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
}

// PickUserAgent returns cfg.UserAgent if set, otherwise picks a random entry
// from the built-in pool using a crypto-random index so each session differs.
func PickUserAgent(cfg *Config) string {
	if cfg.UserAgent != "" {
		return cfg.UserAgent
	}
	var b [2]byte
	rand.Read(b[:]) //nolint:errcheck
	idx := int(binary.BigEndian.Uint16(b[:])) % len(defaultUserAgents)
	return defaultUserAgents[idx]
}

// browserHeaders derives the Sec-CH-UA / Sec-Fetch-* / Origin / Referer /
// Cache-Control headers that a real browser sends on every XHR/fetch.
// Values are derived from the chosen User-Agent and broker origin so they are
// internally consistent — a mismatch is a common DPI tell.
func browserHeaders(userAgent, brokerBaseURL string) map[string]string {
	h := make(map[string]string)

	// Derive broker origin (scheme + host) for Origin and Referer.
	origin := ""
	referer := ""
	if u, err := url.Parse(brokerBaseURL); err == nil && u.Host != "" {
		origin = u.Scheme + "://" + u.Host
		referer = origin + "/"
	}

	isFirefox := strings.Contains(userAgent, "Firefox")
	isEdge := strings.Contains(userAgent, "Edg/")

	if isFirefox {
		// Firefox does not send Sec-CH-UA at all; Sec-Fetch-* differ slightly.
		h["Sec-Fetch-Dest"] = "empty"
		h["Sec-Fetch-Mode"] = "cors"
		h["Sec-Fetch-Site"] = "same-origin"
	} else {
		// Chromium / Edge: extract major version for Sec-CH-UA.
		chromeVer := extractChromeVersion(userAgent)

		var brand string
		if isEdge {
			edgeVer := extractVersion(userAgent, "Edg/")
			brand = fmt.Sprintf(`"Microsoft Edge";v="%s", "Chromium";v="%s", "Not-A.Brand";v="99"`, edgeVer, chromeVer)
		} else {
			brand = fmt.Sprintf(`"Chromium";v="%s", "Google Chrome";v="%s", "Not-A.Brand";v="99"`, chromeVer, chromeVer)
		}

		platform := `"Windows"`
		if strings.Contains(userAgent, "Macintosh") {
			platform = `"macOS"`
		} else if strings.Contains(userAgent, "Linux") && !strings.Contains(userAgent, "Android") {
			platform = `"Linux"`
		}

		h["Sec-CH-UA"]          = brand
		h["Sec-CH-UA-Mobile"]   = "?0"
		h["Sec-CH-UA-Platform"] = platform
		h["Sec-Fetch-Dest"]     = "empty"
		h["Sec-Fetch-Mode"]     = "cors"
		h["Sec-Fetch-Site"]     = "same-origin"
	}

	h["Cache-Control"] = "no-cache"
	h["Pragma"]        = "no-cache"

	if origin != "" {
		h["Origin"]  = origin
		h["Referer"] = referer
	}

	return h
}

// extractChromeVersion returns the major version string from a Chrome UA, e.g. "124".
func extractChromeVersion(ua string) string {
	return extractVersion(ua, "Chrome/")
}

func extractVersion(ua, prefix string) string {
	idx := strings.Index(ua, prefix)
	if idx < 0 {
		return "99"
	}
	rest := ua[idx+len(prefix):]
	end := strings.IndexAny(rest, ". ")
	if end < 0 {
		return rest
	}
	return rest[:end]
}

var templateFieldRe = regexp.MustCompile(`\{([a-zA-Z_][a-zA-Z0-9_]*)\}`)

// routeProvider builds lane URLs from a base URL + route template,
// matching the Python RouteProvider class.
type routeProvider struct {
	baseURL  string
	route    string // e.g. "/{lane}/{direction}"
	wsRoute  string // e.g. "/{lane}"
	health   string // e.g. "/health"
}

func newRouteProvider(baseURL, routeTemplate, wsTemplate, healthTemplate string) *routeProvider {
	norm := func(s, def string) string {
		s = strings.TrimSpace(s)
		if s == "" {
			s = def
		}
		if !strings.HasPrefix(s, "/") {
			s = "/" + s
		}
		return s
	}
	p, _ := url.Parse(strings.TrimRight(baseURL, "/"))
	_ = p
	return &routeProvider{
		baseURL: strings.TrimRight(baseURL, "/"),
		route:   norm(routeTemplate, "/{lane}/{direction}"),
		wsRoute: norm(wsTemplate, "/{lane}"),
		health:  norm(healthTemplate, "/health"),
	}
}

func (r *routeProvider) laneURL(lane, direction string) string {
	path := renderTemplate(r.route, map[string]string{
		"lane":      lane,
		"direction": direction,
	})
	return r.joinPath(path)
}

func (r *routeProvider) wsLaneURL(lane string) string {
	path := renderTemplate(r.wsRoute, map[string]string{"lane": lane})
	raw := r.joinPath(path)
	// Upgrade scheme to ws/wss
	if strings.HasPrefix(raw, "https://") {
		return "wss://" + raw[8:]
	}
	if strings.HasPrefix(raw, "http://") {
		return "ws://" + raw[7:]
	}
	return raw
}

func (r *routeProvider) healthURL() string {
	return r.joinPath(r.health)
}

func (r *routeProvider) joinPath(extra string) string {
	parsed, err := url.Parse(r.baseURL)
	if err != nil {
		return r.baseURL + extra
	}
	base := strings.TrimRight(parsed.Path, "/")
	parsed.Path = base + extra
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func renderTemplate(tmpl string, ctx map[string]string) string {
	return templateFieldRe.ReplaceAllStringFunc(tmpl, func(m string) string {
		name := m[1 : len(m)-1]
		if v, ok := ctx[name]; ok {
			return v
		}
		return m
	})
}

// --- Connection headers (mirrors twoman_http.build_connection_headers) ---

// Default identity cookie names, matching Python DEFAULT_IDENTITY_COOKIE_NAMES
var defaultCookieNames = map[string]string{
	"role":    "_cf_role",
	"peer":    "_cf_lspa",
	"session": "_wp_syncId",
	"auth":    "_cfauth",
}

func cookieNames(cfg *Config) map[string]string {
	names := make(map[string]string)
	for k, v := range defaultCookieNames {
		names[k] = v
	}
	if cfg.IdentityCookieNames != nil {
		for _, k := range []string{"role", "peer", "session", "auth"} {
			if v := strings.TrimSpace(cfg.IdentityCookieNames[k]); v != "" {
				names[k] = v
			}
		}
	}
	return names
}

func buildConnectionHeaders(token, role, peerLabel, peerSessionID, userAgent string, cfg *Config) map[string]string {
	cn := cookieNames(cfg)
	binaryType := cfg.BinaryMediaType
	if binaryType == "" {
		binaryType = "image/webp"
	}
	cookies := map[string]string{
		cn["role"]:    role,
		cn["peer"]:    peerLabel,
		cn["session"]: peerSessionID,
	}

	headers := map[string]string{
		"Accept":          fmt.Sprintf("application/json, %s, */*;q=0.8", binaryType),
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "identity",
		"User-Agent":      userAgent,
	}
	for k, v := range browserHeaders(userAgent, cfg.BrokerBaseURL) {
		headers[k] = v
	}

	authMode := strings.ToLower(strings.TrimSpace(cfg.AuthMode))
	if authMode == "" {
		authMode = "bearer"
	}
	if authMode == "cookie" {
		cookies[cn["auth"]] = token
	} else {
		headers["Authorization"] = "Bearer " + token
	}

	// Build cookie header
	parts := make([]string, 0, len(cookies))
	for name, value := range cookies {
		parts = append(parts, name+"="+url.PathEscape(value))
	}
	headers["Cookie"] = strings.Join(parts, "; ")

	if cfg.LegacyCustomHeadersEnabled {
		headers["X-Relay-Token"] = token
		headers["X-Twoman-Role"] = role
		headers["X-Twoman-Peer"] = peerLabel
		headers["X-Twoman-Session"] = peerSessionID
	}
	return headers
}
