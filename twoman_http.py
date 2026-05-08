#!/usr/bin/env python3

import http.cookies
import inspect
import random
import re
import urllib.parse


JSON_MEDIA_TYPE = "application/json"
DEFAULT_BINARY_MEDIA_TYPE = "image/webp"
LEGACY_BINARY_MEDIA_TYPE = "application/octet-stream"
DEFAULT_ROUTE_TEMPLATE = "/{lane}/{direction}"
DEFAULT_WS_ROUTE_TEMPLATE = "/{lane}"
DEFAULT_HEALTH_TEMPLATE = "/health"
DEFAULT_AUTH_MODE = "bearer"
DEFAULT_IDENTITY_COOKIE_NAMES = {
    "role": "_cf_role",
    "peer": "_cf_lspa",
    "session": "_wp_syncId",
    "auth": "_cfauth",
}
_TEMPLATE_FIELD_PATTERN = re.compile(r"{([a-zA-Z_][a-zA-Z0-9_]*)}")


def _normalize_media_type(value):
    return str(value or "").split(";", 1)[0].strip().lower()


def parse_cookie_header(value):
    cookie = http.cookies.SimpleCookie()
    if value:
        cookie.load(str(value))
    parsed = {}
    for key, morsel in cookie.items():
        parsed[str(key)] = urllib.parse.unquote(morsel.value)
    return parsed


def normalize_cookie_names(config):
    names = dict(DEFAULT_IDENTITY_COOKIE_NAMES)
    configured = config.get("identity_cookie_names", {})
    if isinstance(configured, dict):
        for key in ("role", "peer", "session", "auth"):
            value = str(configured.get(key, "")).strip()
            if value:
                names[key] = value
    return names


def standard_binary_media_types(config):
    configured = config.get("binary_media_types")
    if isinstance(configured, (list, tuple, set)):
        values = [_normalize_media_type(item) for item in configured if str(item).strip()]
    else:
        configured_value = _normalize_media_type(config.get("binary_media_type", DEFAULT_BINARY_MEDIA_TYPE))
        values = [configured_value]
    normalized = []
    for value in values + [DEFAULT_BINARY_MEDIA_TYPE, LEGACY_BINARY_MEDIA_TYPE]:
        if value and value not in normalized:
            normalized.append(value)
    return tuple(normalized)


def expected_binary_media_type(config):
    return standard_binary_media_types(config)[0]


def is_json_media_type(value):
    return _normalize_media_type(value) == JSON_MEDIA_TYPE


def is_binary_media_type(value, config):
    return _normalize_media_type(value) in set(standard_binary_media_types(config))


def validate_json_media_type(value):
    if not is_json_media_type(value):
        raise ValueError("expected application/json response")


def validate_binary_media_type(value, config):
    if not is_binary_media_type(value, config):
        raise ValueError(
            "expected binary media type in %s"
            % ", ".join(standard_binary_media_types(config))
        )


def normalize_route_context(config):
    context = {}
    configured = config.get("route_context", {})
    if isinstance(configured, dict):
        for key, value in configured.items():
            text = str(value).strip()
            if text:
                context[str(key)] = text
    aliases = {
        "version": ("version", "api_version"),
        "tenant": ("tenant", "tenant_id"),
        "endpoint": ("endpoint", "endpoint_id"),
    }
    for target, keys in aliases.items():
        if target in context:
            continue
        for key in keys:
            text = str(config.get(key, "")).strip()
            if text:
                context[target] = text
                break
    return context


def normalize_request_path(path, base_path=None):
    normalized = "/" + str(path or "").lstrip("/")
    prefix = str(base_path or "").strip()
    if not prefix or prefix == "/":
        return normalized
    if not prefix.startswith("/"):
        prefix = "/" + prefix
    prefix = prefix.rstrip("/")
    if normalized == prefix:
        return "/"
    if normalized.startswith(prefix + "/"):
        return normalized[len(prefix) :] or "/"
    return normalized


def httpx_proxy_kwargs(proxy_url, *, async_client=False):
    import httpx

    normalized = str(proxy_url or "").strip()
    if not normalized:
        return {}
    client_ctor = httpx.AsyncClient if async_client else httpx.Client
    try:
        parameters = inspect.signature(client_ctor.__init__).parameters
    except (TypeError, ValueError):
        parameters = {}
    if "proxy" in parameters:
        return {"proxy": normalized}
    if "proxies" in parameters:
        return {"proxies": normalized}
    # Fall back to the current API if the runtime hides its signature.
    return {"proxy": normalized}


def httpx_request(method, url, *, proxy_url=None, **kwargs):
    import httpx

    return httpx.request(method, url, **httpx_proxy_kwargs(proxy_url, async_client=False), **kwargs)


class RouteProvider(object):
    def __init__(
        self,
        base_url,
        *,
        route_template=DEFAULT_ROUTE_TEMPLATE,
        ws_route_template=DEFAULT_WS_ROUTE_TEMPLATE,
        health_template=DEFAULT_HEALTH_TEMPLATE,
        route_context=None,
    ):
        self.base_url = str(base_url).rstrip("/")
        self.route_template = self._normalize_template(route_template, DEFAULT_ROUTE_TEMPLATE)
        self.ws_route_template = self._normalize_template(ws_route_template, DEFAULT_WS_ROUTE_TEMPLATE)
        self.health_template = self._normalize_template(health_template, DEFAULT_HEALTH_TEMPLATE)
        self.route_context = dict(route_context or {})

    @classmethod
    def from_config(cls, base_url, config):
        return cls(
            base_url,
            route_template=config.get("route_template", DEFAULT_ROUTE_TEMPLATE),
            ws_route_template=config.get("ws_route_template", DEFAULT_WS_ROUTE_TEMPLATE),
            health_template=config.get("health_template", DEFAULT_HEALTH_TEMPLATE),
            route_context=normalize_route_context(config),
        )

    def lane_url(self, lane, direction):
        return self._join_path(self._render(self.route_template, lane=lane, direction=direction))

    def ws_lane_url(self, lane):
        url = self._join_path(self._render(self.ws_route_template, lane=lane))
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme == "https":
            scheme = "wss"
        elif parsed.scheme == "http":
            scheme = "ws"
        else:
            scheme = parsed.scheme
        return urllib.parse.urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))

    def health_url(self):
        return self._join_path(self._render(self.health_template))

    def _render(self, template, **values):
        context = dict(self.route_context)
        context.update((key, str(value)) for key, value in values.items())
        missing = [name for name in _TEMPLATE_FIELD_PATTERN.findall(template) if name not in context]
        if missing:
            raise ValueError("missing route template values: %s" % ", ".join(sorted(set(missing))))
        rendered = template.format(**context)
        return self._normalize_template(rendered, template)

    def _join_path(self, extra_path):
        parsed = urllib.parse.urlsplit(self.base_url)
        path = parsed.path.rstrip("/")
        joined_path = (path + extra_path) or "/"
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, joined_path, "", ""))

    @staticmethod
    def _normalize_template(value, default_value):
        text = str(value or default_value).strip() or default_value
        if not text.startswith("/"):
            text = "/" + text
        return text


def parse_lane_path(path, route_template=None):
    normalized = "/" + str(path or "").lstrip("/")
    template = str(route_template or "").strip()
    if template:
        match = _compile_template(template).match(normalized)
        if not match:
            return None
        route = match.groupdict()
        if route.get("lane") and route.get("direction"):
            return route
        return None
    parts = [part for part in normalized.split("/") if part]
    if len(parts) < 2:
        return None
    lane = parts[-2]
    direction = parts[-1]
    return {"lane": lane, "direction": direction, "path": normalized}


def is_health_path(path, health_template=None):
    normalized = "/" + str(path or "").lstrip("/")
    template = str(health_template or "").strip()
    if template:
        return bool(_compile_template(template).match(normalized))
    return normalized == "/health" or normalized.endswith("/health")


def _compile_template(template):
    normalized = template if str(template).startswith("/") else "/" + str(template)
    pattern = ""
    index = 0
    for match in _TEMPLATE_FIELD_PATTERN.finditer(normalized):
        pattern += re.escape(normalized[index:match.start()])
        name = match.group(1)
        pattern += "(?P<%s>[^/]+)" % name
        index = match.end()
    pattern += re.escape(normalized[index:])
    return re.compile("^%s$" % pattern)


def build_connection_headers(token, role, peer_label, peer_session_id, config):
    auth_mode = str(config.get("auth_mode", DEFAULT_AUTH_MODE)).strip().lower() or DEFAULT_AUTH_MODE
    cookie_names = normalize_cookie_names(config)
    cookies = {
        cookie_names["role"]: str(role),
        cookie_names["peer"]: str(peer_label),
        cookie_names["session"]: str(peer_session_id),
    }
    headers = {
        "Accept": "%s, %s" % (JSON_MEDIA_TYPE, expected_binary_media_type(config)),
    }
    if auth_mode == "cookie":
        cookies[cookie_names["auth"]] = str(token)
    else:
        headers["Authorization"] = "Bearer %s" % str(token)
    headers["Cookie"] = "; ".join(
        "%s=%s" % (name, urllib.parse.quote(value, safe="-._~"))
        for name, value in cookies.items()
    )
    return headers


def extract_connection_identity(headers, config):
    lowered = dict((str(key).lower(), value) for key, value in (headers or {}).items())
    cookie_names = normalize_cookie_names(config)
    cookies = parse_cookie_header(lowered.get("cookie", ""))
    authorization = str(lowered.get("authorization", "")).strip()
    token = ""
    if authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        token = str(cookies.get(cookie_names["auth"], "")).strip()
    role = str(cookies.get(cookie_names["role"], "")).strip()
    peer = str(cookies.get(cookie_names["peer"], "")).strip()
    session = str(cookies.get(cookie_names["session"], "")).strip()
    return {
        "token": token,
        "role": role,
        "peer_label": peer,
        "peer_session_id": session,
    }


def jittered_backoff_seconds(
    failures,
    *,
    initial_delay=0.1,
    maximum_delay=5.0,
    multiplier=2.0,
    free_failures=1,
    rng=None,
):
    failures = int(failures)
    if failures <= int(free_failures):
        return 0.0
    exponent = failures - int(free_failures) - 1
    ceiling = min(float(maximum_delay), float(initial_delay) * (float(multiplier) ** max(0, exponent)))
    generator = rng or random
    return generator.uniform(0.0, max(0.0, ceiling))


def jittered_interval_seconds(base_delay, *, jitter_ratio=0.2, rng=None):
    base_delay = max(0.0, float(base_delay))
    if base_delay <= 0:
        return 0.0
    jitter_ratio = max(0.0, float(jitter_ratio))
    generator = rng or random
    delta = base_delay * jitter_ratio
    return max(0.0, generator.uniform(base_delay - delta, base_delay + delta))
