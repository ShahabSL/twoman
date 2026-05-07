from __future__ import annotations

import base64
import json
import secrets
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any


PROFILE_SHARE_PREFIX = "twoman://profile?data="


def _new_id() -> str:
    return str(uuid.uuid4())


def _legacy_auto_int(value: Any, default: int = 0) -> int:
    parsed = int(value if value is not None else default)
    return 0 if parsed == 65536 else parsed


def _positive_or_none(value: int) -> int | None:
    return value if value > 0 else None


@dataclass(slots=True)
class ClientProfile:
    """User-facing Twoman client profile persisted by the desktop manager."""

    name: str
    broker_base_url: str
    client_token: str
    id: str = field(default_factory=_new_id)
    target_agent_peer_label: str = ""
    verify_tls: bool = False
    http2_ctl: bool = True
    http2_data: bool = False
    http_port: int = 28167
    socks_port: int = 21167
    http_timeout_seconds: int = 30
    flush_delay_seconds: float = 0.01
    max_batch_bytes: int = 0
    data_upload_max_batch_bytes: int = 0
    data_upload_flush_delay_seconds: float = 0.0
    idle_repoll_ctl_seconds: float = 0.05
    idle_repoll_data_seconds: float = 0.1
    trace_enabled: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ClientProfile":
        return cls(
            id=payload.get("id") or _new_id(),
            name=str(payload.get("name", "")).strip(),
            broker_base_url=str(
                payload.get("broker_base_url")
                or payload.get("brokerBaseUrl")
                or ""
            ).strip(),
            client_token=str(
                payload.get("client_token")
                or payload.get("clientToken")
                or ""
            ).strip(),
            target_agent_peer_label=str(
                payload.get("target_agent_peer_label")
                or payload.get("targetAgentPeerLabel")
                or ""
            ).strip(),
            verify_tls=bool(payload.get("verify_tls", payload.get("verifyTls", False))),
            http2_ctl=bool(payload.get("http2_ctl", payload.get("http2Ctl", True))),
            http2_data=bool(payload.get("http2_data", payload.get("http2Data", False))),
            http_port=int(payload.get("http_port", payload.get("httpPort", 28167))),
            socks_port=int(payload.get("socks_port", payload.get("socksPort", 21167))),
            http_timeout_seconds=int(
                payload.get("http_timeout_seconds", payload.get("httpTimeoutSeconds", 30))
            ),
            flush_delay_seconds=float(
                payload.get("flush_delay_seconds", payload.get("flushDelaySeconds", 0.01))
            ),
            max_batch_bytes=_legacy_auto_int(payload.get("max_batch_bytes", payload.get("maxBatchBytes", 0))),
            data_upload_max_batch_bytes=_legacy_auto_int(
                payload.get(
                    "data_upload_max_batch_bytes",
                    payload.get("dataUploadMaxBatchBytes", 0),
                )
            ),
            data_upload_flush_delay_seconds=float(
                payload.get(
                    "data_upload_flush_delay_seconds",
                    payload.get("dataUploadFlushDelaySeconds", 0.0),
                )
            ),
            idle_repoll_ctl_seconds=float(
                payload.get("idle_repoll_ctl_seconds", payload.get("idleRepollCtlSeconds", 0.05))
            ),
            idle_repoll_data_seconds=float(
                payload.get("idle_repoll_data_seconds", payload.get("idleRepollDataSeconds", 0.1))
            ),
            trace_enabled=bool(payload.get("trace_enabled", payload.get("traceEnabled", False))),
        )

    def validate(self) -> None:
        if not self.name.strip():
            raise ValueError("Profile name is required")
        if not self.broker_base_url.strip():
            raise ValueError("Broker URL is required")
        if not self.client_token.strip():
            raise ValueError("Client token is required")
        if self.http_port <= 0 or self.socks_port <= 0:
            raise ValueError("Proxy ports must be positive")

    def to_runtime_config(self, log_path: str) -> dict[str, Any]:
        self.validate()
        config: dict[str, Any] = {
            "transport": "http",
            "transport_profile": "auto",
            "broker_base_url": self.broker_base_url,
            "client_token": self.client_token,
            "target_agent_peer_label": self.target_agent_peer_label,
            "listen_host": "127.0.0.1",
            "http_listen_port": self.http_port,
            "socks_listen_port": self.socks_port,
            "log_path": log_path,
            "http_timeout_seconds": self.http_timeout_seconds,
            "flush_delay_seconds": self.flush_delay_seconds,
            "verify_tls": self.verify_tls,
            "streaming_up_lanes": [],
            "idle_repoll_delay_seconds": {
                "ctl": self.idle_repoll_ctl_seconds,
                "data": self.idle_repoll_data_seconds,
            },
            "http2_enabled": {
                "ctl": self.http2_ctl,
                "data": self.http2_data,
            },
        }
        if max_batch_bytes := _positive_or_none(self.max_batch_bytes):
            config["max_batch_bytes"] = max_batch_bytes
        data_profile: dict[str, Any] = {}
        if data_batch := _positive_or_none(self.data_upload_max_batch_bytes):
            data_profile["max_batch_bytes"] = data_batch
        if self.data_upload_flush_delay_seconds > 0:
            data_profile["flush_delay_seconds"] = self.data_upload_flush_delay_seconds
        if data_profile:
            config["upload_profiles"] = {"data": data_profile}
        return config

    def to_share_text(self) -> str:
        export_payload = {
            "name": self.name,
            "brokerBaseUrl": self.broker_base_url,
            "clientToken": self.client_token,
            "targetAgentPeerLabel": self.target_agent_peer_label,
            "verifyTls": self.verify_tls,
            "http2Ctl": self.http2_ctl,
            "http2Data": self.http2_data,
            "httpPort": self.http_port,
            "socksPort": self.socks_port,
            "httpTimeoutSeconds": self.http_timeout_seconds,
            "idleRepollCtlSeconds": self.idle_repoll_ctl_seconds,
            "idleRepollDataSeconds": self.idle_repoll_data_seconds,
            "traceEnabled": self.trace_enabled,
        }
        if self.max_batch_bytes > 0:
            export_payload["maxBatchBytes"] = self.max_batch_bytes
        if self.data_upload_max_batch_bytes > 0:
            export_payload["dataUploadMaxBatchBytes"] = self.data_upload_max_batch_bytes
        if self.data_upload_flush_delay_seconds > 0:
            export_payload["dataUploadFlushDelaySeconds"] = self.data_upload_flush_delay_seconds
        encoded = base64.urlsafe_b64encode(
            json.dumps(export_payload, separators=(",", ":")).encode("utf-8")
        ).decode("ascii").rstrip("=")
        return f"{PROFILE_SHARE_PREFIX}{encoded}"

    @classmethod
    def from_share_text(cls, raw_text: str) -> "ClientProfile":
        text = raw_text.strip()
        if text.startswith(PROFILE_SHARE_PREFIX):
            text = text.removeprefix(PROFILE_SHARE_PREFIX)
        if text.startswith("{"):
            payload = json.loads(text)
        else:
            padded = text + "=" * (-len(text) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        profile = cls.from_dict(payload)
        profile.id = _new_id()
        return profile


@dataclass(slots=True)
class SharedSocksProxy:
    """Externally reachable SOCKS5 listener that forwards to a local Twoman SOCKS port."""

    name: str
    listen_port: int
    target_port: int
    id: str = field(default_factory=_new_id)
    listen_host: str = "0.0.0.0"
    target_host: str = "127.0.0.1"
    username: str = field(default_factory=lambda: f"user-{secrets.token_hex(3)}")
    password: str = field(default_factory=lambda: secrets.token_urlsafe(12))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SharedSocksProxy":
        return cls(
            id=payload.get("id") or _new_id(),
            name=str(payload.get("name", "")).strip(),
            listen_host=str(payload.get("listen_host", payload.get("listenHost", "0.0.0.0"))).strip(),
            listen_port=int(payload.get("listen_port", payload.get("listenPort", 31167))),
            target_host=str(payload.get("target_host", payload.get("targetHost", "127.0.0.1"))).strip(),
            target_port=int(payload.get("target_port", payload.get("targetPort", 21167))),
            username=str(payload.get("username", "")).strip(),
            password=str(payload.get("password", "")).strip(),
        )

    def validate(self) -> None:
        if not self.name.strip():
            raise ValueError("Share name is required")
        if not self.username.strip():
            raise ValueError("Share username is required")
        if not self.password.strip():
            raise ValueError("Share password is required")
        if self.listen_port <= 0 or self.target_port <= 0:
            raise ValueError("Share ports must be positive")

    def to_runtime_config(self, log_path: str) -> dict[str, Any]:
        self.validate()
        return {
            "name": self.name,
            "listen_host": self.listen_host,
            "listen_port": self.listen_port,
            "target_host": self.target_host,
            "target_port": self.target_port,
            "username": self.username,
            "password": self.password,
            "log_path": log_path,
        }
