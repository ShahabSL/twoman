#!/usr/bin/env python3

import argparse
import asyncio
import contextlib
import ipaddress
import json
import os
import random
import socket
import struct
import sys
import urllib.parse

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CURRENT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from twoman_protocol import (
    Frame,
    FLAG_DATA_BULK,
    FRAME_DATA,
    FRAME_FIN,
    FRAME_OPEN,
    FRAME_OPEN_FAIL,
    FRAME_OPEN_OK,
    FRAME_RST,
    FRAME_WINDOW,
    LANE_BULK,
    LANE_CTL,
    LANE_PRI,
    MODE_TCP,
    make_error_payload,
    make_open_payload,
    parse_error_payload,
    random_peer_id,
)
from twoman_transport import LaneTransport


INITIAL_WINDOW = 256 * 1024
PRI_LIMIT = 64 * 1024
READ_CHUNK = 16 * 1024
WINDOW_FLUSH_BYTES = 16 * 1024
WINDOW_FLUSH_DELAY = 0.005
SMALL_WRITE_BYTES = 8 * 1024

TRACE_ENABLED = os.environ.get("TWOMAN_TRACE", "").strip().lower() in ("1", "true", "yes", "on", "debug", "verbose")


def trace(message):
    if not TRACE_ENABLED:
        return
    sys.stderr.write("[helper] %s\n" % message)
    sys.stderr.flush()


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if "broker_base_url" not in config and "broker_v2_base_url" in config:
        config["broker_base_url"] = config["broker_v2_base_url"]
    return config


def recv_until_headers(data):
    return b"\r\n\r\n" in data


def parse_request_headers(data):
    head, _, rest = data.partition(b"\r\n\r\n")
    lines = head.decode("iso-8859-1").split("\r\n")
    request_line = lines[0]
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip()] = value.strip()
    return request_line, headers, rest


def target_from_request(request_line, headers):
    method, target, _version = request_line.split(" ", 2)
    if method.upper() == "CONNECT":
        host, port = target.rsplit(":", 1)
        return host, int(port), ""

    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme and parsed.hostname:
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        rebuilt = "%s %s HTTP/1.1\r\n" % (method, path)
        return host, port, rebuilt

    host_header = headers.get("Host", "")
    if ":" in host_header:
        host, port_text = host_header.rsplit(":", 1)
        port = int(port_text)
    else:
        host = host_header
        port = 80
    rebuilt = "%s %s HTTP/1.1\r\n" % (method, target)
    return host, port, rebuilt


def rebuild_http_request(request_line, headers, rest):
    host, port, rebuilt_request_line = target_from_request(request_line, headers)
    outgoing_headers = []
    for name, value in headers.items():
        lower_name = name.lower()
        if lower_name in {"proxy-connection", "connection"}:
            continue
        outgoing_headers.append("%s: %s\r\n" % (name, value))
    outgoing_headers.append("Connection: close\r\n")
    payload = rebuilt_request_line + "".join(outgoing_headers) + "\r\n"
    return host, port, payload.encode("iso-8859-1") + rest


class ProxyStream(object):
    def __init__(self, helper, stream_id, target_host, target_port):
        self.helper = helper
        self.stream_id = int(stream_id)
        self.target_host = target_host
        self.target_port = int(target_port)
        self.open_event = asyncio.Event()
        self.recv_queue = asyncio.Queue()
        self.open_failed = ""
        self.send_credit = INITIAL_WINDOW
        self.send_credit_event = asyncio.Event()
        self.send_credit_event.set()
        self.send_offset = 0
        self.recv_offset = 0
        self.fin_offset = None
        self.closed = False
        self.pending_window = 0
        self.window_flush_task = None

    async def open(self):
        trace("open stream=%s target=%s:%s" % (self.stream_id, self.target_host, self.target_port))
        frame = Frame(
            FRAME_OPEN,
            stream_id=self.stream_id,
            payload=make_open_payload(self.target_host, self.target_port, MODE_TCP),
        )
        await self.helper.transport.send_frame(LANE_CTL, frame)
        await asyncio.wait_for(self.open_event.wait(), timeout=30)
        if self.open_failed:
            trace("open failed stream=%s error=%s" % (self.stream_id, self.open_failed))
            raise RuntimeError(self.open_failed)
        trace("open ok stream=%s" % self.stream_id)

    async def on_frame(self, frame):
        if frame.type_id == FRAME_OPEN_OK:
            trace("recv OPEN_OK stream=%s" % self.stream_id)
            self.open_event.set()
            return
        if frame.type_id == FRAME_OPEN_FAIL:
            self.open_failed = parse_error_payload(frame.payload)
            trace("recv OPEN_FAIL stream=%s error=%s" % (self.stream_id, self.open_failed))
            self.open_event.set()
            await self.recv_queue.put(None)
            return
        if frame.type_id == FRAME_WINDOW:
            self.send_credit += int(frame.offset)
            self.send_credit_event.set()
            return
        if frame.type_id == FRAME_DATA:
            payload = frame.payload
            if frame.offset < self.recv_offset:
                delta = self.recv_offset - frame.offset
                if delta >= len(payload):
                    return
                payload = payload[delta:]
            elif frame.offset > self.recv_offset:
                await self.reset("out of order data")
                return
            self.recv_offset += len(payload)
            await self.recv_queue.put(payload)
            if self.fin_offset is not None and self.recv_offset >= self.fin_offset:
                await self.recv_queue.put(None)
            return
        if frame.type_id in (FRAME_FIN, FRAME_RST):
            if frame.type_id == FRAME_RST and frame.payload:
                self.open_failed = parse_error_payload(frame.payload)
                trace("recv RST stream=%s error=%s" % (self.stream_id, self.open_failed))
                await self.recv_queue.put(None)
                return
            self.fin_offset = int(frame.offset)
            trace("recv FIN stream=%s fin_offset=%s recv_offset=%s" % (self.stream_id, self.fin_offset, self.recv_offset))
            if self.recv_offset >= self.fin_offset:
                await self.recv_queue.put(None)

    async def send_data(self, payload):
        view = memoryview(payload)
        while view and not self.closed:
            if self.send_credit <= 0:
                self.send_credit_event.clear()
                await self.send_credit_event.wait()
            chunk_len = min(len(view), READ_CHUNK, self.send_credit)
            chunk = bytes(view[:chunk_len])
            lane = self._data_lane(len(chunk))
            trace("send DATA stream=%s lane=%s offset=%s bytes=%s" % (self.stream_id, lane, self.send_offset, len(chunk)))
            flags = FLAG_DATA_BULK if lane == LANE_BULK else 0
            frame = Frame(FRAME_DATA, stream_id=self.stream_id, offset=self.send_offset, payload=chunk, flags=flags)
            await self.helper.transport.send_frame(lane, frame)
            self.send_offset += len(chunk)
            self.send_credit -= len(chunk)
            view = view[chunk_len:]

    async def grant_window(self, length):
        if length <= 0 or self.closed:
            return
        self.pending_window += int(length)
        if self.pending_window >= WINDOW_FLUSH_BYTES:
            await self.flush_window()
            return
        if self.window_flush_task is None or self.window_flush_task.done():
            self.window_flush_task = asyncio.create_task(self._flush_window_later())

    async def flush_window(self):
        if self.pending_window <= 0 or self.closed:
            return
        value = self.pending_window
        self.pending_window = 0
        await self.helper.transport.send_frame(
            LANE_CTL,
            Frame(FRAME_WINDOW, stream_id=self.stream_id, offset=int(value)),
        )

    async def _flush_window_later(self):
        await asyncio.sleep(WINDOW_FLUSH_DELAY)
        await self.flush_window()

    async def finish(self):
        if self.closed:
            return
        await self.flush_window()
        await self.helper.transport.send_frame(LANE_CTL, Frame(FRAME_FIN, stream_id=self.stream_id, offset=self.send_offset))
        self.closed = True

    async def reset(self, message):
        if self.closed:
            return
        if self.window_flush_task is not None and not self.window_flush_task.done():
            self.window_flush_task.cancel()
        await self.helper.transport.send_frame(
            LANE_CTL,
            Frame(FRAME_RST, stream_id=self.stream_id, payload=make_error_payload(message)),
        )
        self.closed = True

    def _data_lane(self, chunk_len):
        if self.send_offset < PRI_LIMIT:
            return LANE_PRI
        if chunk_len <= SMALL_WRITE_BYTES:
            return LANE_PRI
        return LANE_BULK


class HelperRuntime(object):
    def __init__(self, config):
        self.config = config
        self.streams = {}
        seed = int.from_bytes(os.urandom(4), "big") & 0x7FFFFFFF
        self.next_stream_id = max(1, seed | 1)
        self.peer_id = config.get("peer_id") or random_peer_id()
        self.transport = LaneTransport(
            base_url=config["broker_base_url"],
            token=config["client_token"],
            role="helper",
            peer_id=self.peer_id,
            on_frame=self.on_frame,
            http_timeout_seconds=config.get("http_timeout_seconds", 60),
            max_batch_bytes=config.get("max_batch_bytes", 65536),
            flush_delay_seconds=config.get("flush_delay_seconds", 0.01),
            http2_enabled=config.get("http2_enabled", True),
            collapse_data_lanes=True,
        )

    async def start(self):
        await self.transport.start()

    async def stop(self):
        await self.transport.stop()

    async def on_frame(self, frame, _lane):
        stream = self.streams.get(frame.stream_id)
        if stream is None:
            return
        await stream.on_frame(frame)

    def new_stream(self, target_host, target_port):
        stream_id = self.next_stream_id
        self.next_stream_id += 2
        stream = ProxyStream(self, stream_id, target_host, target_port)
        self.streams[stream_id] = stream
        return stream

    async def release_stream(self, stream_id):
        self.streams.pop(stream_id, None)


async def relay_stream(runtime, stream, reader, writer, initial_payload=b"", connected_response=None, open_stream=True):
    failure = None
    try:
        if open_stream:
            await stream.open()
        if connected_response:
            writer.write(connected_response)
            await writer.drain()
        if initial_payload:
            await stream.send_data(initial_payload)

        async def local_to_remote():
            while True:
                data = await reader.read(READ_CHUNK)
                if not data:
                    trace("local EOF stream=%s send_offset=%s" % (stream.stream_id, stream.send_offset))
                    await stream.finish()
                    return
                trace("local read stream=%s bytes=%s" % (stream.stream_id, len(data)))
                await stream.send_data(data)

        async def remote_to_local():
            while True:
                payload = await stream.recv_queue.get()
                if payload is None:
                    if stream.open_failed and connected_response:
                        raise RuntimeError(stream.open_failed)
                    trace("remote EOF stream=%s recv_offset=%s" % (stream.stream_id, stream.recv_offset))
                    with contextlib.suppress(Exception):
                        writer.write_eof()
                    return
                trace("remote write stream=%s bytes=%s" % (stream.stream_id, len(payload)))
                writer.write(payload)
                await writer.drain()
                await stream.grant_window(len(payload))

        tasks = [asyncio.create_task(local_to_remote()), asyncio.create_task(remote_to_local())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            with contextlib.suppress(asyncio.CancelledError):
                error = task.exception()
                if error:
                    raise error
    except Exception as error:
        failure = error
        raise
    finally:
        if failure is not None:
            with contextlib.suppress(Exception):
                await stream.reset(str(failure))
        await runtime.release_stream(stream.stream_id)
        writer.close()
        await writer.wait_closed()


async def handle_http(runtime, reader, writer):
    try:
        buffer = b""
        while not recv_until_headers(buffer) and len(buffer) < 65536:
            chunk = await reader.read(4096)
            if not chunk:
                writer.close()
                await writer.wait_closed()
                return
            buffer += chunk
        request_line, headers, rest = parse_request_headers(buffer)
        method = request_line.split(" ", 1)[0].upper()
        if method == "CONNECT":
            host, port, _ = target_from_request(request_line, headers)
            initial_payload = b""
            connected_response = b"HTTP/1.1 200 Connection Established\r\n\r\n"
        else:
            host, port, initial_payload = rebuild_http_request(request_line, headers, rest)
            connected_response = None
        trace("http request method=%s host=%s port=%s connect=%s" % (method, host, port, method == "CONNECT"))
        stream = runtime.new_stream(host, port)
        await relay_stream(runtime, stream, reader, writer, initial_payload=initial_payload, connected_response=connected_response)
    except Exception as error:
        body = str(error).encode("utf-8", errors="replace")
        writer.write(
            b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: "
            + str(len(body)).encode("ascii")
            + b"\r\n\r\n"
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()


async def handle_socks(runtime, reader, writer):
    stream = None
    try:
        version, method_count = (await reader.readexactly(2))
        if version != 5:
            raise RuntimeError("unsupported socks version")
        methods = await reader.readexactly(method_count)
        if b"\x00" not in methods:
            writer.write(b"\x05\xff")
            await writer.drain()
            return
        writer.write(b"\x05\x00")
        await writer.drain()
        header = await reader.readexactly(4)
        version, command, _reserved, address_type = header
        if version != 5 or command != 1:
            raise RuntimeError("only socks connect is supported")
        if address_type == 1:
            host = socket.inet_ntoa(await reader.readexactly(4))
        elif address_type == 3:
            host_length = (await reader.readexactly(1))[0]
            host = (await reader.readexactly(host_length)).decode("utf-8")
        elif address_type == 4:
            host = str(ipaddress.IPv6Address(await reader.readexactly(16)))
        else:
            raise RuntimeError("unsupported socks address type")
        port = struct.unpack("!H", await reader.readexactly(2))[0]
        stream = runtime.new_stream(host, port)
        await stream.open()
        writer.write(b"\x05\x00\x00\x01" + socket.inet_aton("0.0.0.0") + struct.pack("!H", 0))
        await writer.drain()
        await relay_stream(runtime, stream, reader, writer, open_stream=False)
    except Exception:
        if stream is not None:
            with contextlib.suppress(Exception):
                await stream.reset("socks failure")
            await runtime.release_stream(stream.stream_id)
        with contextlib.suppress(Exception):
            writer.close()
            await writer.wait_closed()


async def main_async(config):
    runtime = HelperRuntime(config)
    await runtime.start()
    http_server = await asyncio.start_server(
        lambda r, w: handle_http(runtime, r, w),
        config.get("listen_host", "127.0.0.1"),
        int(config.get("http_listen_port", 8080)),
    )
    socks_server = await asyncio.start_server(
        lambda r, w: handle_socks(runtime, r, w),
        config.get("listen_host", "127.0.0.1"),
        int(config.get("socks_listen_port", 1080)),
    )
    async with http_server, socks_server:
        await asyncio.gather(http_server.serve_forever(), socks_server.serve_forever())


def main():
    parser = argparse.ArgumentParser(description="Twoman local helper")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = load_config(args.config)
    asyncio.run(main_async(config))


if __name__ == "__main__":
    main()
