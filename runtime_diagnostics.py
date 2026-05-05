#!/usr/bin/env python3

import json
import logging
from logging.handlers import RotatingFileHandler
import os
import threading
import time


DEFAULT_RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_RUNTIME_LOG_BACKUP_COUNT = 3
DEFAULT_EVENT_LOG_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_EVENT_LOG_BACKUP_COUNT = 5
DEFAULT_RECENT_EVENT_LIMIT = 200


def _coerce_int(value, default_value, minimum=1):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return int(default_value)
    return max(int(minimum), parsed)


def default_log_dir(config_path):
    config_dir = os.path.dirname(os.path.abspath(config_path))
    return os.path.join(config_dir, "logs")


def resolve_component_path(config_path, config, *, config_key, env_key, default_filename):
    env_value = os.environ.get(env_key, "").strip()
    if env_value:
        return os.path.abspath(env_value)
    configured_value = str(config.get(config_key, "")).strip()
    if configured_value:
        if os.path.isabs(configured_value):
            return configured_value
        return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(config_path)), configured_value))
    log_dir = os.environ.get("TWOMAN_LOG_DIR", "").strip()
    if log_dir:
        base_dir = os.path.abspath(log_dir)
    else:
        base_dir = default_log_dir(config_path)
    return os.path.join(base_dir, default_filename)


def runtime_log_path(config_path, config, default_filename):
    return resolve_component_path(
        config_path,
        config,
        config_key="log_path",
        env_key="TWOMAN_LOG_PATH",
        default_filename=default_filename,
    )


def event_log_path(config_path, config, default_filename):
    return resolve_component_path(
        config_path,
        config,
        config_key="event_log_path",
        env_key="TWOMAN_EVENT_LOG_PATH",
        default_filename=default_filename,
    )


def runtime_log_settings(config):
    return {
        "max_bytes": _coerce_int(
            config.get("log_max_bytes", DEFAULT_RUNTIME_LOG_MAX_BYTES),
            DEFAULT_RUNTIME_LOG_MAX_BYTES,
        ),
        "backup_count": _coerce_int(
            config.get("log_backup_count", DEFAULT_RUNTIME_LOG_BACKUP_COUNT),
            DEFAULT_RUNTIME_LOG_BACKUP_COUNT,
        ),
    }


def event_log_settings(config):
    return {
        "max_bytes": _coerce_int(
            config.get("event_log_max_bytes", DEFAULT_EVENT_LOG_MAX_BYTES),
            DEFAULT_EVENT_LOG_MAX_BYTES,
        ),
        "backup_count": _coerce_int(
            config.get("event_log_backup_count", DEFAULT_EVENT_LOG_BACKUP_COUNT),
            DEFAULT_EVENT_LOG_BACKUP_COUNT,
        ),
        "recent_limit": _coerce_int(
            config.get("recent_event_limit", DEFAULT_RECENT_EVENT_LIMIT),
            DEFAULT_RECENT_EVENT_LIMIT,
        ),
    }


def configure_component_logger(
    logger,
    *,
    log_path,
    trace_enabled,
    runtime_log_max_bytes=DEFAULT_RUNTIME_LOG_MAX_BYTES,
    runtime_log_backup_count=DEFAULT_RUNTIME_LOG_BACKUP_COUNT,
    console_prefix="twoman",
):
    if logger.handlers:
        return
    log_dir = os.path.dirname(os.path.abspath(log_path))
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
    logger.setLevel(logging.DEBUG if trace_enabled else logging.INFO)
    logger.propagate = False

    file_handler = RotatingFileHandler(
        log_path,
        maxBytes=int(runtime_log_max_bytes),
        backupCount=int(runtime_log_backup_count),
        encoding="utf-8",
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(file_handler)

    if hasattr(logging, "StreamHandler"):
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.DEBUG if trace_enabled else logging.WARNING)
        console_handler.setFormatter(logging.Formatter(f"[{console_prefix}] %(levelname)s %(message)s"))
        logger.addHandler(console_handler)


def _json_safe(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return dict((str(key), _json_safe(item)) for key, item in value.items())
    return repr(value)


class DurableEventRecorder(object):
    def __init__(self, path, *, max_bytes, backup_count, recent_limit):
        self.path = os.path.abspath(path)
        self.max_bytes = int(max_bytes)
        self.backup_count = int(backup_count)
        self.recent_limit = int(recent_limit)
        self._lock = threading.Lock()
        self._recent = []
        log_dir = os.path.dirname(self.path)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)

    def record(self, kind, **fields):
        event = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "kind": str(kind),
        }
        for key, value in fields.items():
            event[str(key)] = _json_safe(value)
        encoded = json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n"
        with self._lock:
            self._rotate_if_needed(len(encoded.encode("utf-8")))
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(encoded)
            self._recent.append(event)
            if len(self._recent) > self.recent_limit:
                del self._recent[: len(self._recent) - self.recent_limit]
        return event

    def snapshot(self, limit=None):
        with self._lock:
            if limit is None or int(limit) >= len(self._recent):
                return list(self._recent)
            return list(self._recent[-int(limit):])

    def _rotate_if_needed(self, incoming_bytes):
        if self.max_bytes <= 0:
            return
        try:
            current_size = os.path.getsize(self.path)
        except OSError:
            current_size = 0
        if current_size + incoming_bytes <= self.max_bytes:
            return
        if self.backup_count > 0:
            oldest = f"{self.path}.{self.backup_count}"
            if os.path.exists(oldest):
                os.remove(oldest)
            for index in range(self.backup_count - 1, 0, -1):
                source = f"{self.path}.{index}"
                target = f"{self.path}.{index + 1}"
                if os.path.exists(source):
                    os.replace(source, target)
            if os.path.exists(self.path):
                os.replace(self.path, f"{self.path}.1")
        elif os.path.exists(self.path):
            os.remove(self.path)
