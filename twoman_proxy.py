#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import contextlib
import urllib.parse

from python_socks.async_.asyncio import Proxy


def normalize_python_socks_proxy_url(proxy_url: str) -> str:
    normalized = str(proxy_url or "").strip()
    if not normalized:
        return ""
    parsed = urllib.parse.urlsplit(normalized)
    if parsed.scheme.lower() != "socks5h":
        return normalized
    return urllib.parse.urlunsplit(("socks5", parsed.netloc, parsed.path, parsed.query, parsed.fragment))


async def open_connection_via_proxy(
    proxy_url: str,
    dest_host: str,
    dest_port: int,
    timeout: float,
    **kwargs,
):
    proxy = Proxy.from_url(normalize_python_socks_proxy_url(proxy_url))
    sock = await proxy.connect(dest_host=dest_host, dest_port=dest_port, timeout=timeout)
    try:
        return await asyncio.wait_for(
            asyncio.open_connection(sock=sock, **kwargs),
            timeout=timeout,
        )
    except Exception:
        with contextlib.suppress(Exception):
            sock.close()
        raise
