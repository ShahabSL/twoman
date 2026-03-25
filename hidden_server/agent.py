#!/usr/bin/env python3

import argparse
import asyncio
import contextlib
import json
import os
import socket
import sys

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CURRENT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)
VENDOR_DIR = os.path.join(CURRENT_DIR, "vendor")
if os.path.isdir(VENDOR_DIR) and VENDOR_DIR not in sys.path:
    sys.path.insert(0, VENDOR_DIR)

from twoman_protocol import (
    Frame,
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
    parse_open_payload,
)
from twoman_transport import LaneTransport


INITIAL_WINDOW = 256 * 1024
READ_CHUNK = 16 * 1024
PRI_LIMIT = 64 * 1024
WINDOW_FLUSH_BYTES = 16 * 1024
WINDOW_FLUSH_DELAY = 0.005
SMALL_WRITE_BYTES = 8 * 1024

TRACE_ENABLED = os.environ.get("TWOMAN_TRACE", "").strip().lower() in ("1", "true", "yes", "on", "debug", "verbose")


def trace(message):
    if not TRACE_ENABLED:
        return
    sys.stderr.write("[agent] %s\n" % message)
    sys.stderr.flush()


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if "broker_base_url" not in config and "broker_v2_base_url" in config:
        config["broker_base_url"] = config["broker_v2_base_url"]
    return config


class RemoteStream(object):
    def __init__(self, agent, stream_id):
        self.agent = agent
        self.stream_id = int(stream_id)
        self.reader = None
        self.writer = None
        self.remote_task = None
        self.send_credit = INITIAL_WINDOW
        self.send_credit_event = asyncio.Event()
        self.send_credit_event.set()
        self.send_offset = 0
        self.recv_offset = 0
        self.fin_offset = None
        self.closed = False
        self.remote_eof_sent = False
        self.pending_window = 0
        self.window_flush_task = None

    async def open(self, host, port, mode):
        if mode != MODE_TCP:
            raise RuntimeError("unsupported open mode")
        trace("open stream=%s target=%s:%s" % (self.stream_id, host, port))
        self.reader, self.writer = await asyncio.open_connection(host, port)
        transport = self.writer.transport
        if transport is not None:
            sock = transport.get_extra_info("socket")
            if sock is not None:
                with contextlib.suppress(OSError):
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        await self.agent.transport.send_frame(LANE_CTL, Frame(FRAME_OPEN_OK, stream_id=self.stream_id))
        trace("open ok stream=%s" % self.stream_id)
        self.remote_task = asyncio.create_task(self.remote_to_helper())

    async def on_frame(self, frame):
        if frame.type_id == FRAME_WINDOW:
            self.send_credit += int(frame.offset)
            self.send_credit_event.set()
            trace("recv WINDOW stream=%s bytes=%s credit=%s" % (self.stream_id, int(frame.offset), self.send_credit))
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
            trace("recv DATA stream=%s offset=%s bytes=%s" % (self.stream_id, frame.offset, len(payload)))
            self.writer.write(payload)
            await self.writer.drain()
            await self.grant_window(len(payload))
            if self.fin_offset is not None and self.recv_offset >= self.fin_offset:
                await self._finish_remote_write()
            return
        if frame.type_id == FRAME_FIN:
            self.fin_offset = int(frame.offset)
            trace("recv FIN stream=%s fin_offset=%s recv_offset=%s" % (self.stream_id, self.fin_offset, self.recv_offset))
            if self.recv_offset >= self.fin_offset:
                await self._finish_remote_write()
            return
        if frame.type_id == FRAME_RST:
            trace("recv RST stream=%s" % self.stream_id)
            await self.close()

    async def remote_to_helper(self):
        try:
            while not self.closed:
                if self.send_credit <= 0:
                    self.send_credit_event.clear()
                    await self.send_credit_event.wait()
                data = await self.reader.read(min(READ_CHUNK, self.send_credit))
                if not data:
                    trace("remote EOF stream=%s send_offset=%s" % (self.stream_id, self.send_offset))
                    await self.flush_window()
                    await self.agent.transport.send_frame(
                        LANE_CTL,
                        Frame(FRAME_FIN, stream_id=self.stream_id, offset=self.send_offset),
                    )
                    trace("send FIN stream=%s offset=%s" % (self.stream_id, self.send_offset))
                    return
                lane = self._data_lane(len(data))
                trace("send DATA stream=%s lane=%s offset=%s bytes=%s" % (self.stream_id, lane, self.send_offset, len(data)))
                await self.agent.transport.send_frame(
                    lane,
                    Frame(FRAME_DATA, stream_id=self.stream_id, offset=self.send_offset, payload=data),
                )
                self.send_offset += len(data)
                self.send_credit -= len(data)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self.reset(str(error))

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
        await self.agent.transport.send_frame(
            LANE_CTL,
            Frame(FRAME_WINDOW, stream_id=self.stream_id, offset=value),
        )

    async def _flush_window_later(self):
        await asyncio.sleep(WINDOW_FLUSH_DELAY)
        await self.flush_window()

    async def reset(self, message):
        if self.closed:
            return
        if self.window_flush_task is not None and not self.window_flush_task.done():
            self.window_flush_task.cancel()
        await self.agent.transport.send_frame(
            LANE_CTL,
            Frame(FRAME_RST, stream_id=self.stream_id, payload=make_error_payload(message)),
        )
        await self.close()

    async def _finish_remote_write(self):
        if self.writer is None or self.remote_eof_sent:
            return
        if self.writer.can_write_eof():
            self.writer.write_eof()
            await self.writer.drain()
        self.remote_eof_sent = True

    async def close(self):
        current_task = asyncio.current_task()
        already_closed = self.closed
        self.closed = True
        if self.remote_task is not None and self.remote_task is not current_task and not self.remote_task.done():
            self.remote_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.remote_task
        self.remote_task = None
        if self.writer is not None:
            self.writer.close()
            with contextlib.suppress(Exception):
                await self.writer.wait_closed()
        self.writer = None
        self.reader = None
        if self.window_flush_task is not None and not self.window_flush_task.done():
            self.window_flush_task.cancel()
        self.window_flush_task = None
        if not already_closed:
            self.agent.release_stream(self.stream_id, self)

    def _data_lane(self, chunk_len):
        if self.send_offset < PRI_LIMIT:
            return LANE_PRI
        if chunk_len <= SMALL_WRITE_BYTES:
            return LANE_PRI
        return LANE_BULK


class AgentRuntime(object):
    def __init__(self, config):
        self.config = config
        self.transport = LaneTransport(
            base_url=config["broker_base_url"],
            token=config["agent_token"],
            role="agent",
            peer_id=config.get("peer_id", "agent"),
            on_frame=self.on_frame,
            http_timeout_seconds=config.get("http_timeout_seconds", 60),
            max_batch_bytes=config.get("max_batch_bytes", 65536),
            flush_delay_seconds=config.get("flush_delay_seconds", 0.01),
            http2_enabled=config.get("http2_enabled", True),
            collapse_data_lanes=True,
        )
        self.streams = {}

    async def start(self):
        await self.transport.start()
        await asyncio.Event().wait()

    async def on_frame(self, frame, _lane):
        if frame.type_id == FRAME_OPEN:
            details = parse_open_payload(frame.payload)
            trace("recv OPEN stream=%s host=%s port=%s" % (frame.stream_id, details['host'], details['port']))
            stream = RemoteStream(self, frame.stream_id)
            self.streams[frame.stream_id] = stream
            try:
                await stream.open(details["host"], details["port"], details["mode"])
            except Exception as error:
                trace("open fail stream=%s error=%s" % (frame.stream_id, error))
                await self.transport.send_frame(
                    LANE_CTL,
                    Frame(FRAME_OPEN_FAIL, stream_id=frame.stream_id, payload=make_error_payload(str(error))),
                )
                self.streams.pop(frame.stream_id, None)
            return

        stream = self.streams.get(frame.stream_id)
        if stream is None:
            return
        await stream.on_frame(frame)
        if frame.type_id == FRAME_RST:
            self.streams.pop(frame.stream_id, None)

    def release_stream(self, stream_id, stream):
        if self.streams.get(stream_id) is stream:
            self.streams.pop(stream_id, None)


def main():
    parser = argparse.ArgumentParser(description="Twoman hidden agent")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = load_config(args.config)
    asyncio.run(AgentRuntime(config).start())


if __name__ == "__main__":
    main()
