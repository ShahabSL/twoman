#!/usr/bin/env python3

import asyncio
import contextlib
import os
import sys
import urllib.parse

import httpx

from twoman_protocol import (
    FLAG_DATA_BULK,
    FRAME_DATA,
    FRAME_PING,
    Frame,
    FrameDecoder,
    LANES,
    LANE_CTL,
    LANE_DATA,
    LANE_PRI,
    encode_frame,
)

TRACE_ENABLED = os.environ.get("TWOMAN_TRACE", "").strip().lower() in ("1", "true", "yes", "on", "debug", "verbose")


def trace(message):
    if not TRACE_ENABLED:
        return
    sys.stderr.write("[transport] %s\n" % message)
    sys.stderr.flush()


class LaneTransport(object):
    def __init__(
        self,
        base_url,
        token,
        role,
        peer_id,
        on_frame,
        http_timeout_seconds=60,
        flush_delay_seconds=0.01,
        max_batch_bytes=65536,
        verify_tls=True,
        http2_enabled=True,
        collapse_data_lanes=False,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.role = role
        self.peer_label = peer_id
        self.peer_session_id = os.urandom(8).hex()
        self.on_frame = on_frame
        self.http_timeout_seconds = float(http_timeout_seconds)
        self.flush_delay_seconds = float(flush_delay_seconds)
        self.max_batch_bytes = int(max_batch_bytes)
        self.verify_tls = verify_tls
        self.collapse_data_lanes = bool(collapse_data_lanes)
        self.http2_enabled_default = False if isinstance(http2_enabled, dict) else bool(http2_enabled)
        self.http2_enabled_lanes = self._normalize_http2_enabled(http2_enabled)
        self.upload_profiles = {
            "ctl": {"max_batch_bytes": 4096, "flush_delay_seconds": 0.0},
            "pri": {"max_batch_bytes": 4096, "flush_delay_seconds": min(self.flush_delay_seconds, 0.001)},
            "bulk": {"max_batch_bytes": min(self.max_batch_bytes, 32768), "flush_delay_seconds": max(self.flush_delay_seconds, 0.008)},
        }
        self.queues = dict((lane, asyncio.Queue()) for lane in LANES)
        self.data_queue = asyncio.Queue() if self.collapse_data_lanes else None
        self.stop_event = asyncio.Event()
        self.clients = {}
        self.tasks = []
        self.failure_counts = {}

    async def start(self):
        if self.clients:
            return
        for lane in self._external_lanes():
            self.clients[lane] = self._build_client(lane)
        for lane in self._external_lanes():
            self.tasks.append(asyncio.create_task(self._up_loop(lane)))
            self.tasks.append(asyncio.create_task(self._down_loop(lane)))
        self.tasks.append(asyncio.create_task(self._ping_loop()))

    async def stop(self):
        self.stop_event.set()
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self.tasks = []
        for client in self.clients.values():
            with contextlib.suppress(Exception):
                await client.aclose()
        self.clients = {}

    async def send_frame(self, lane, frame):
        if self.collapse_data_lanes and lane in ("pri", "bulk"):
            if frame.type_id == FRAME_DATA:
                flags = int(frame.flags)
                if lane == "bulk":
                    flags |= FLAG_DATA_BULK
                else:
                    flags &= ~FLAG_DATA_BULK
                frame = Frame(
                    frame.type_id,
                    stream_id=frame.stream_id,
                    offset=frame.offset,
                    payload=frame.payload,
                    flags=flags,
                )
            await self.data_queue.put(frame)
            return
        if lane not in self.queues:
            raise ValueError("unknown lane")
        await self.queues[lane].put(frame)

    async def _up_loop(self, lane):
        while not self.stop_event.is_set():
            try:
                first = await self._next_outbound_frame(lane)
                logical_lane = lane if lane != LANE_DATA else LANE_PRI
                profile = self.upload_profiles.get(
                    logical_lane,
                    {"max_batch_bytes": self.max_batch_bytes, "flush_delay_seconds": self.flush_delay_seconds},
                )
                batch = [encode_frame(first)]
                total = len(batch[0])
                max_batch_bytes = int(profile["max_batch_bytes"])
                flush_delay_seconds = float(profile["flush_delay_seconds"])
                deadline = asyncio.get_running_loop().time() + flush_delay_seconds
                while total < max_batch_bytes:
                    if flush_delay_seconds <= 0:
                        try:
                            frame = self._next_outbound_frame_nowait(lane)
                        except asyncio.QueueEmpty:
                            break
                        encoded = encode_frame(frame)
                        if total + len(encoded) > max_batch_bytes:
                            await self._requeue_frame(lane, frame)
                            break
                        batch.append(encoded)
                        total += len(encoded)
                        continue
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        break
                    try:
                        frame = await asyncio.wait_for(self._next_outbound_frame(lane), timeout=remaining)
                    except asyncio.TimeoutError:
                        break
                    encoded = encode_frame(frame)
                    if total + len(encoded) > max_batch_bytes:
                        await self._requeue_frame(lane, frame)
                        break
                    batch.append(encoded)
                    total += len(encoded)
                response = await self.clients[lane].post(
                    self._lane_url(lane, "up"),
                    headers=self._headers(),
                    content=b"".join(batch),
                )
                response.raise_for_status()
                self._mark_success("up", lane)
                trace("%s/%s@%s up ok lane=%s batch_bytes=%s status=%s" % (self.role, self.peer_label, self.peer_session_id, lane, total, response.status_code))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                delay = self._backoff_after_error("up", lane)
                trace("%s/%s@%s up error lane=%s delay=%0.3f error=%r" % (self.role, self.peer_label, self.peer_session_id, lane, delay, error))
                if delay > 0:
                    await asyncio.sleep(delay)

    async def _down_loop(self, lane):
        while not self.stop_event.is_set():
            decoder = FrameDecoder()
            try:
                async with self.clients[lane].stream("GET", self._lane_url(lane, "down"), headers=self._headers()) as response:
                    response.raise_for_status()
                    self._mark_success("down", lane)
                    trace("%s/%s@%s down open lane=%s status=%s" % (self.role, self.peer_label, self.peer_session_id, lane, response.status_code))
                    async for chunk in response.aiter_bytes():
                        if not chunk:
                            continue
                        trace("%s/%s@%s down chunk lane=%s bytes=%s" % (self.role, self.peer_label, self.peer_session_id, lane, len(chunk)))
                        for frame in decoder.feed(chunk):
                            if frame.type_id != FRAME_PING:
                                trace("%s/%s@%s down frame lane=%s type=%s stream=%s payload=%s" % (self.role, self.peer_label, self.peer_session_id, lane, frame.type_id, frame.stream_id, len(frame.payload)))
                            await self.on_frame(frame, lane)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                delay = self._backoff_after_error("down", lane)
                trace("%s/%s@%s down error lane=%s delay=%0.3f error=%r" % (self.role, self.peer_label, self.peer_session_id, lane, delay, error))
                if delay > 0:
                    await asyncio.sleep(delay)

    async def _ping_loop(self):
        while not self.stop_event.is_set():
            await asyncio.sleep(15.0)
            await self.send_frame(LANE_CTL, Frame(FRAME_PING, offset=int(asyncio.get_running_loop().time() * 1000)))

    def _headers(self):
        return {
            "X-Relay-Token": self.token,
            "X-Twoman-Role": self.role,
            "X-Twoman-Peer": self.peer_label,
            "X-Twoman-Session": self.peer_session_id,
        }

    def _lane_url(self, lane, direction):
        parsed = urllib.parse.urlsplit(self.base_url)
        path = parsed.path.rstrip("/")
        url = "%s://%s" % (parsed.scheme, parsed.netloc)
        if path:
            url += path
        return "%s/%s/%s" % (url, lane, direction)

    def _external_lanes(self):
        if self.collapse_data_lanes:
            return (LANE_CTL, LANE_DATA)
        return LANES

    def _normalize_http2_enabled(self, http2_enabled):
        external_lanes = self._external_lanes()
        if isinstance(http2_enabled, dict):
            values = dict((str(key), bool(value)) for key, value in http2_enabled.items())
            lanes = dict((lane, False) for lane in external_lanes)
            for lane in external_lanes:
                if lane in values:
                    lanes[lane] = values[lane]
            if self.collapse_data_lanes and LANE_DATA not in values:
                lanes[LANE_DATA] = bool(values.get("pri", False) or values.get("bulk", False))
            return lanes
        default_value = bool(http2_enabled)
        return dict((lane, default_value) for lane in external_lanes)

    def _mark_success(self, direction, lane):
        self.failure_counts[(direction, lane)] = 0

    def _backoff_after_error(self, direction, lane):
        key = (direction, lane)
        failures = self.failure_counts.get(key, 0) + 1
        self.failure_counts[key] = failures
        if failures <= 1:
            return 0.0
        if failures == 2:
            return 0.1
        if failures == 3:
            return 0.25
        if failures == 4:
            return 0.5
        return min(2.0, 0.5 * (2 ** max(0, failures - 4)))

    async def _next_outbound_frame(self, lane):
        if lane != LANE_DATA:
            return await self.queues[lane].get()
        return await self.data_queue.get()

    def _next_outbound_frame_nowait(self, lane):
        if lane != LANE_DATA:
            return self.queues[lane].get_nowait()
        return self.data_queue.get_nowait()

    async def _requeue_frame(self, lane, frame):
        if lane != LANE_DATA:
            await self.queues[lane].put(frame)
            return
        await self.data_queue.put(frame)

    def _build_client(self, lane):
        limits = httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=120)
        timeout = httpx.Timeout(
            None,
            connect=self.http_timeout_seconds,
            read=None,
            write=self.http_timeout_seconds,
            pool=self.http_timeout_seconds,
        )
        return httpx.AsyncClient(
            http2=self.http2_enabled_lanes.get(lane, self.http2_enabled_default),
            timeout=timeout,
            limits=limits,
            verify=self.verify_tls,
        )
