#!/usr/bin/env python3

import asyncio
import contextlib
import socket
import struct

from twoman_proxy import open_connection_via_proxy


DEFAULT_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"]
DNS_TYPE_AAAA = 28
DNS_TYPE_HTTPS = 65


def config_flag(config, key, default=False):
    value = config.get(key, default)
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return bool(default)


def vpn_filter_aaaa(config):
    if "vpn_filter_aaaa" in config:
        return config_flag(config, "vpn_filter_aaaa", False)
    return config_flag(config, "vpn_prefer_ipv4", False)


def dns_question_type(payload):
    data = bytes(payload)
    if len(data) < 12:
        return None
    question_count = struct.unpack("!H", data[4:6])[0]
    if question_count != 1:
        return None
    index = 12
    while True:
        if index >= len(data):
            return None
        label_length = data[index]
        index += 1
        if label_length == 0:
            break
        if label_length & 0xC0:
            return None
        index += label_length
        if index > len(data):
            return None
    if index + 4 > len(data):
        return None
    return struct.unpack("!H", data[index:index + 2])[0]


def synthesize_empty_dns_response(payload):
    data = bytes(payload)
    if len(data) < 12:
        return data
    flags = struct.unpack("!H", data[2:4])[0]
    response_flags = 0x8000 | (flags & 0x7910) | 0x0080
    return data[:2] + struct.pack("!H", response_flags) + data[4:6] + b"\x00\x00\x00\x00" + data[10:]


def vpn_dns_servers(config):
    for key in ("dns_upstream_servers", "vpn_dns_servers"):
        configured = config.get(key)
        if isinstance(configured, list):
            values = [str(item).strip() for item in configured if str(item).strip()]
            if values:
                return values
    return list(DEFAULT_DNS_SERVERS)


def vpn_dns_proxy_ip(config):
    for key in ("dns_proxy_ip", "vpn_dns_proxy_ip"):
        value = str(config.get(key, "")).strip()
        if value:
            return value
    return ""


def dns_query_cache_key(payload):
    data = bytes(payload)
    if len(data) < 2:
        return data
    return data[2:]


def dns_transaction_id(payload):
    data = bytes(payload)
    if len(data) >= 2:
        return data[:2]
    return b"\x00\x00"


def with_dns_transaction_id(payload, transaction_id):
    data = bytes(payload)
    if len(data) < 2 or len(transaction_id) != 2:
        return data
    return bytes(transaction_id) + data[2:]


def format_error_summary(error):
    if error is None:
        return ""
    text = str(error).strip()
    if text:
        return text
    return error.__class__.__name__


def expire_dns_cache(cache, now_monotonic, max_entries):
    expired_keys = [key for key, entry in cache.items() if entry["expires_at"] <= now_monotonic]
    for key in expired_keys:
        cache.pop(key, None)
    while len(cache) > max_entries:
        cache.pop(next(iter(cache)))


def make_dns_query_frame_payload(target_host, payload):
    host_bytes = str(target_host or "").encode("utf-8")
    if len(host_bytes) > 65535:
        raise ValueError("dns query target host is too long")
    return struct.pack("!H", len(host_bytes)) + host_bytes + bytes(payload or b"")


def parse_dns_query_frame_payload(payload):
    data = bytes(payload or b"")
    if len(data) < 2:
        raise ValueError("dns query payload is too short")
    host_length = struct.unpack("!H", data[:2])[0]
    if len(data) < 2 + host_length:
        raise ValueError("dns query host is truncated")
    host = data[2:2 + host_length].decode("utf-8")
    return {
        "target_host": host,
        "dns_payload": data[2 + host_length:],
    }


def dns_response_truncated(payload):
    data = bytes(payload)
    if len(data) < 4:
        return False
    flags = struct.unpack("!H", data[2:4])[0]
    return bool(flags & 0x0200)


async def udp_dns_query(host, port, payload, timeout):
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
    last_error = None
    for family, socktype, proto, _canonname, sockaddr in infos:
        sock = socket.socket(family, socktype, proto)
        sock.setblocking(False)
        try:
            await asyncio.wait_for(loop.sock_connect(sock, sockaddr), timeout=timeout)
            await asyncio.wait_for(loop.sock_sendall(sock, payload), timeout=timeout)
            return await asyncio.wait_for(loop.sock_recv(sock, 65535), timeout=timeout)
        except Exception as error:
            last_error = error
        finally:
            with contextlib.suppress(Exception):
                sock.close()
    raise last_error or RuntimeError("dns udp query failed")


async def tcp_dns_query(host, port, payload, timeout, *, proxy_url=""):
    reader = None
    writer = None
    try:
        if proxy_url:
            reader, writer = await open_connection_via_proxy(proxy_url, host, port, timeout)
        else:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        writer.write(struct.pack("!H", len(payload)) + payload)
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        response_length = struct.unpack("!H", await asyncio.wait_for(reader.readexactly(2), timeout=timeout))[0]
        return await asyncio.wait_for(reader.readexactly(response_length), timeout=timeout)
    finally:
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


async def query_dns_upstream(host, port, payload, timeout, *, proxy_url=""):
    if proxy_url:
        return await tcp_dns_query(host, port, payload, timeout, proxy_url=proxy_url)
    udp_error = None
    try:
        response = await udp_dns_query(host, port, payload, timeout)
        if dns_response_truncated(response):
            return await tcp_dns_query(host, port, payload, timeout)
        return response
    except asyncio.CancelledError:
        raise
    except Exception as error:
        udp_error = error
    try:
        return await tcp_dns_query(host, port, payload, timeout)
    except asyncio.CancelledError:
        raise
    except Exception:
        raise udp_error


async def resolve_dns_via_upstreams(upstream_hosts, payload, timeout, *, proxy_url=""):
    hosts = [str(host).strip() for host in (upstream_hosts or []) if str(host).strip()]
    if not hosts:
        raise RuntimeError("no dns upstreams configured")
    last_error = None
    tasks = []
    try:
        async def query_upstream(upstream_host):
            response = await query_dns_upstream(
                upstream_host,
                53,
                payload,
                timeout,
                proxy_url=proxy_url,
            )
            return upstream_host, response

        tasks = [asyncio.create_task(query_upstream(upstream_host)) for upstream_host in hosts]
        while tasks:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            tasks = list(pending)
            for completed in done:
                try:
                    return completed.result()
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    last_error = error
                    continue
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
    raise last_error or RuntimeError("dns query failed")
