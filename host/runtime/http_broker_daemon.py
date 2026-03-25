#!/usr/bin/env python3

import argparse
import asyncio
import contextlib
import json
import os
import sys
import time
import urllib.parse

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CURRENT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from twoman_protocol import (
    Frame,
    FrameDecoder,
    FRAME_DATA,
    FRAME_OPEN,
    FRAME_OPEN_FAIL,
    FRAME_PING,
    FRAME_RST,
    FLAG_DATA_BULK,
    LANES,
    LANE_CTL,
    LANE_DATA,
    encode_frame,
    make_error_payload,
)

TRACE_ENABLED = os.environ.get("TWOMAN_TRACE", "").strip().lower() in ("1", "true", "yes", "on", "debug", "verbose")


def now_ms():
    return int(time.time() * 1000)


def trace(message):
    if not TRACE_ENABLED:
        return
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    sys.stderr.write("[%s] [broker] %s\n" % (timestamp, message))
    sys.stderr.flush()


def padded_payload(payload, minimum_size=1024):
    if len(payload) >= minimum_size:
        return payload
    parts = [payload]
    total = len(payload)
    while total < minimum_size:
        filler = encode_frame(Frame(FRAME_PING, offset=now_ms()))
        parts.append(filler)
        total += len(filler)
    return b"".join(parts)


class LaneQueue(object):
    def __init__(self):
        self.queue = asyncio.Queue()
        self.buffered_bytes = 0

    async def put(self, payload):
        self.buffered_bytes += len(payload)
        await self.queue.put(payload)

    async def get(self):
        payload = await self.queue.get()
        self.buffered_bytes = max(0, self.buffered_bytes - len(payload))
        return payload


class PeerState(object):
    def __init__(self, role, peer_label, peer_session_id):
        self.role = role
        self.peer_label = peer_label
        self.peer_session_id = peer_session_id
        self.last_seen_ms = now_ms()
        self.queues = dict((lane, LaneQueue()) for lane in LANES)
        self.data_pri_streak = 0
        self.data_bulk_wait_since_ms = 0

    def touch(self):
        self.last_seen_ms = now_ms()


class StreamState(object):
    def __init__(self, helper_session_id, helper_peer_label, helper_stream_id, agent_session_id, agent_stream_id):
        self.helper_session_id = helper_session_id
        self.helper_peer_label = helper_peer_label
        self.helper_stream_id = int(helper_stream_id)
        self.agent_session_id = agent_session_id
        self.agent_stream_id = int(agent_stream_id)
        self.created_at_ms = now_ms()
        self.last_seen_ms = self.created_at_ms

    def touch(self):
        self.last_seen_ms = now_ms()


class BrokerState(object):
    def __init__(self, config):
        self.client_tokens = set(config.get("client_tokens", []))
        self.agent_tokens = set(config.get("agent_tokens", []))
        self.peer_ttl_ms = int(config.get("peer_ttl_seconds", 90)) * 1000
        self.stream_ttl_ms = int(config.get("stream_ttl_seconds", 300)) * 1000
        self.max_lane_bytes = int(config.get("max_lane_bytes", 16 * 1024 * 1024))
        self.peers = {}
        self.streams_by_helper = {}
        self.streams_by_agent = {}
        self.agent_session_id = ""
        self.agent_peer_label = ""
        self.next_agent_stream_id = 1
        self.metrics = {
            "down_responses": dict((lane, 0) for lane in LANES),
            "down_frames": dict((lane, 0) for lane in LANES),
            "down_bytes": dict((lane, 0) for lane in LANES),
            "down_hold_ms": dict((lane, 0) for lane in LANES),
            "down_pad_bytes": dict((lane, 0) for lane in LANES),
            "up_batches": dict((lane, 0) for lane in LANES),
            "up_frames": dict((lane, 0) for lane in LANES),
            "up_bytes": dict((lane, 0) for lane in LANES),
        }
        self.lock = asyncio.Lock()

    async def auth(self, role, token):
        if role == "helper":
            return token in self.client_tokens
        if role == "agent":
            return token in self.agent_tokens
        return False

    async def ensure_peer(self, role, peer_label, peer_session_id):
        async with self.lock:
            key = (role, peer_session_id)
            peer = self.peers.get(key)
            if peer is None:
                peer = PeerState(role, peer_label, peer_session_id)
                self.peers[key] = peer
                trace("peer online role=%s label=%s session=%s" % (role, peer_label, peer_session_id))
            peer.touch()
            peer.peer_label = peer_label
            if role == "agent":
                self.agent_session_id = peer_session_id
                self.agent_peer_label = peer_label
            return peer

    async def queue_frame(self, role, peer_session_id, lane, frame):
        payload = encode_frame(frame)
        async with self.lock:
            peer = self.peers.get((role, peer_session_id))
            if peer is None:
                trace("drop frame type=%s stream=%s target=%s/%s lane=%s reason=no-peer" % (frame.type_id, frame.stream_id, role, peer_session_id, lane))
                return False
            queue = peer.queues[lane]
            if queue.buffered_bytes >= self.max_lane_bytes:
                trace("drop frame type=%s stream=%s target=%s/%s lane=%s reason=queue-full buffered=%s" % (frame.type_id, frame.stream_id, role, peer_session_id, lane, queue.buffered_bytes))
                return False
        await peer.queues[lane].put(payload)
        if frame.type_id != FRAME_DATA:
            trace("queue frame type=%s stream=%s target=%s/%s lane=%s bytes=%s" % (frame.type_id, frame.stream_id, role, peer_session_id, lane, len(payload)))
        return True

    async def handle_frame(self, sender_role, sender_peer_session_id, lane, frame):
        if frame.type_id == FRAME_PING:
            return

        if frame.type_id == FRAME_OPEN and sender_role == "helper":
            await self._handle_open(sender_peer_session_id, frame)
            return

        async with self.lock:
            if sender_role == "helper":
                stream = self.streams_by_helper.get((sender_peer_session_id, frame.stream_id))
            else:
                stream = self.streams_by_agent.get(frame.stream_id)
            if stream is None:
                trace("drop frame type=%s stream=%s from=%s/%s lane=%s reason=unknown-stream" % (frame.type_id, frame.stream_id, sender_role, sender_peer_session_id, lane))
                return
            stream.touch()
            if sender_role == "helper":
                target_role = "agent"
                target_peer_session_id = stream.agent_session_id
                outbound_stream_id = stream.agent_stream_id
            else:
                target_role = "helper"
                target_peer_session_id = stream.helper_session_id
                outbound_stream_id = stream.helper_stream_id

        if not target_peer_session_id:
            return

        outbound_frame = Frame(
            frame.type_id,
            stream_id=outbound_stream_id,
            offset=frame.offset,
            payload=frame.payload,
            flags=frame.flags,
        )
        target_lane = lane if frame.type_id == FRAME_DATA else LANE_CTL
        queued = await self.queue_frame(target_role, target_peer_session_id, target_lane, outbound_frame)
        if not queued and sender_role == "helper":
            await self.queue_frame(
                "helper",
                sender_peer_session_id,
                LANE_CTL,
                Frame(FRAME_RST, stream_id=frame.stream_id, payload=make_error_payload("broker queue full")),
            )

        if frame.type_id == FRAME_RST:
            async with self.lock:
                self._drop_stream_locked(stream)

    async def _handle_open(self, helper_session_id, frame):
        async with self.lock:
            agent_session_id = self.agent_session_id
            helper_peer = self.peers.get(("helper", helper_session_id))
            helper_peer_label = helper_peer.peer_label if helper_peer is not None else helper_session_id
            if not agent_session_id or ("agent", agent_session_id) not in self.peers:
                agent_session_id = ""
            if agent_session_id:
                agent_stream_id = self.next_agent_stream_id
                self.next_agent_stream_id += 1
                stream = StreamState(helper_session_id, helper_peer_label, frame.stream_id, agent_session_id, agent_stream_id)
                self.streams_by_helper[(helper_session_id, frame.stream_id)] = stream
                self.streams_by_agent[agent_stream_id] = stream
                trace("open helper=%s/%s helper_stream=%s agent_session=%s agent_stream=%s" % (
                    helper_peer_label,
                    helper_session_id,
                    frame.stream_id,
                    agent_session_id,
                    agent_stream_id,
                ))
        if not agent_session_id:
            trace("open fail stream=%s helper=%s reason=no-agent" % (frame.stream_id, helper_session_id))
            await self.queue_frame(
                "helper",
                helper_session_id,
                LANE_CTL,
                Frame(FRAME_OPEN_FAIL, stream_id=frame.stream_id, payload=make_error_payload("hidden agent unavailable")),
            )
            return
        await self.queue_frame("agent", agent_session_id, LANE_CTL, Frame(FRAME_OPEN, stream_id=agent_stream_id, offset=frame.offset, payload=frame.payload, flags=frame.flags))

    def _drop_stream_locked(self, stream):
        self.streams_by_helper.pop((stream.helper_session_id, stream.helper_stream_id), None)
        self.streams_by_agent.pop(stream.agent_stream_id, None)

    async def cleanup(self):
        peer_cutoff = now_ms() - self.peer_ttl_ms
        stream_cutoff = now_ms() - self.stream_ttl_ms
        async with self.lock:
            stale_peers = [key for key, peer in self.peers.items() if peer.last_seen_ms < peer_cutoff]
            for key in stale_peers:
                role, peer_session_id = key
                del self.peers[key]
                if role == "agent" and self.agent_session_id == peer_session_id:
                    self.agent_session_id = ""
                    self.agent_peer_label = ""

            stale_streams = [stream for stream in self.streams_by_agent.values() if stream.last_seen_ms < stream_cutoff]
            for stream in stale_streams:
                self._drop_stream_locked(stream)

    async def stats(self):
        async with self.lock:
            buffered = {}
            for lane in LANES:
                buffered[lane] = sum(peer.queues[lane].buffered_bytes for peer in self.peers.values())
            return {
                "peers": len(self.peers),
                "streams": len(self.streams_by_agent),
                "agent_peer_label": self.agent_peer_label,
                "agent_session_id": self.agent_session_id,
                "buffered_ctl_bytes": buffered[LANE_CTL],
                "buffered_pri_bytes": buffered["pri"],
                "buffered_bulk_bytes": buffered["bulk"],
                "metrics": self.metrics,
            }

    def lane_profile(self, lane):
        if lane == LANE_CTL:
            return {"max_bytes": 4096, "max_frames": 8, "hold_ms": 1, "pad_min": 1024}
        if lane == "pri":
            return {"max_bytes": 16384, "max_frames": 8, "hold_ms": 3, "pad_min": 1024}
        return {"max_bytes": 65536, "max_frames": 16, "hold_ms": 8, "pad_min": 0}


class AsyncBrokerServer(object):
    def __init__(self, host, port, config):
        self.host = host
        self.port = int(port)
        self.state = BrokerState(config)
        self.server = None
        self.cleanup_task = None

    async def start(self):
        self.server = await asyncio.start_server(self.handle_connection, self.host, self.port)
        loop = asyncio.get_event_loop()
        self.cleanup_task = loop.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(10.0)
            await self.state.cleanup()

    async def handle_connection(self, reader, writer):
        try:
            request_line, headers, body = await self._read_request(reader)
            method, raw_path, _version = request_line.split(" ", 2)
            parsed = urllib.parse.urlsplit(raw_path)
            if parsed.path == "/health":
                await self._send_json(writer, 200, {"ok": True, "stats": await self.state.stats()})
                return

            parts = parsed.path.strip("/").split("/")
            if len(parts) != 2 or parts[0] not in (list(LANES) + [LANE_DATA]) or parts[1] not in ("up", "down"):
                await self._send_json(writer, 404, {"error": "not found"})
                return

            lane = parts[0]
            direction = parts[1]
            role = headers.get("x-twoman-role", "")
            peer_label = headers.get("x-twoman-peer", "")
            peer_session_id = headers.get("x-twoman-session", "")
            token = headers.get("x-relay-token", "")
            if not role or not peer_label or not peer_session_id or not await self.state.auth(role, token):
                await self._send_json(writer, 403, {"error": "invalid role or token"})
                return
            peer = await self.state.ensure_peer(role, peer_label, peer_session_id)
            if method == "GET" and direction == "down":
                if lane == LANE_DATA:
                    if role == "helper":
                        await self._handle_streaming_data_down(writer, peer)
                    else:
                        await self._handle_data_down(writer, peer)
                elif lane == LANE_CTL and role == "helper":
                    await self._handle_helper_ctl_down(writer, peer)
                else:
                    await self._handle_down(writer, peer, lane)
                return
            if method == "POST" and direction == "up":
                await self._handle_up(writer, role, peer_session_id, lane, body)
                return
            await self._send_json(writer, 405, {"error": "method not allowed"})
        except asyncio.IncompleteReadError:
            pass
        except Exception as error:
            try:
                await self._send_json(writer, 500, {"error": str(error)})
            except Exception:
                pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    async def _handle_down(self, writer, peer, lane):
        trace("down open role=%s peer=%s session=%s lane=%s" % (peer.role, peer.peer_label, peer.peer_session_id, lane))
        queue = peer.queues[lane]
        profile = self.state.lane_profile(lane)
        hold_started = asyncio.get_event_loop().time()
        payloads = [await queue.get()]
        peer.touch()
        total = len(payloads[0])
        frames = 1
        deadline = asyncio.get_event_loop().time() + (float(profile["hold_ms"]) / 1000.0)
        while total < int(profile["max_bytes"]) and frames < int(profile["max_frames"]):
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            payloads.append(payload)
            total += len(payload)
            frames += 1
        body = b"".join(payloads)
        padded = padded_payload(body, minimum_size=int(profile["pad_min"])) if int(profile["pad_min"]) > 0 else body
        pad_bytes = max(0, len(padded) - len(body))
        if pad_bytes:
            trace("pad lane=%s role=%s peer=%s session=%s from=%s to=%s" % (lane, peer.role, peer.peer_label, peer.peer_session_id, len(body), len(padded)))
        body = padded
        hold_ms = max(0, int((asyncio.get_event_loop().time() - hold_started) * 1000))
        self.state.metrics["down_responses"][lane] += 1
        self.state.metrics["down_frames"][lane] += frames
        self.state.metrics["down_bytes"][lane] += len(body)
        self.state.metrics["down_hold_ms"][lane] += hold_ms
        self.state.metrics["down_pad_bytes"][lane] += pad_bytes
        trace("down send role=%s peer=%s session=%s lane=%s frames=%s bytes=%s hold_ms=%s" % (peer.role, peer.peer_label, peer.peer_session_id, lane, frames, len(body), hold_ms))
        try:
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/octet-stream\r\n"
                b"Cache-Control: no-store\r\n"
                b"Connection: close\r\n"
                + ("Content-Length: %d\r\n\r\n" % len(body)).encode("ascii")
            )
            writer.write(body)
            await writer.drain()
        except Exception as error:
            trace("down error role=%s peer=%s session=%s lane=%s error=%r" % (peer.role, peer.peer_label, peer.peer_session_id, lane, error))
            raise

    async def _handle_streaming_data_down(self, writer, peer):
        trace("down stream open role=%s peer=%s session=%s lane=data" % (peer.role, peer.peer_label, peer.peer_session_id))
        try:
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/octet-stream\r\n"
                b"Cache-Control: no-store\r\n"
                b"Transfer-Encoding: chunked\r\n"
                b"Connection: close\r\n\r\n"
            )
            await writer.drain()
            last_send = asyncio.get_event_loop().time()
            while True:
                payload, source_lane, frames, hold_ms, pad_bytes = await self._next_data_payload(peer)
                if payload is None:
                    heartbeat = encode_frame(Frame(FRAME_PING, offset=now_ms()))
                    await self._write_chunk(writer, heartbeat)
                    last_send = asyncio.get_event_loop().time()
                    continue
                self.state.metrics["down_responses"][source_lane] += 1
                self.state.metrics["down_frames"][source_lane] += frames
                self.state.metrics["down_bytes"][source_lane] += len(payload)
                self.state.metrics["down_hold_ms"][source_lane] += hold_ms
                self.state.metrics["down_pad_bytes"][source_lane] += pad_bytes
                trace("down stream send role=%s peer=%s session=%s source=%s frames=%s bytes=%s hold_ms=%s" % (
                    peer.role,
                    peer.peer_label,
                    peer.peer_session_id,
                    source_lane,
                    frames,
                    len(payload),
                    hold_ms,
                ))
                await self._write_chunk(writer, payload)
                last_send = asyncio.get_event_loop().time()
        except Exception as error:
            trace("down stream error role=%s peer=%s session=%s lane=data error=%r" % (peer.role, peer.peer_label, peer.peer_session_id, error))
            raise

    async def _handle_data_down(self, writer, peer):
        trace("down open role=%s peer=%s session=%s lane=data" % (peer.role, peer.peer_label, peer.peer_session_id))
        payload, source_lane, frames, hold_ms, pad_bytes = await self._next_data_payload(peer)
        if payload is None:
            payload = padded_payload(encode_frame(Frame(FRAME_PING, offset=now_ms())), minimum_size=1024)
            source_lane = "pri"
            frames = 1
            hold_ms = 0
            pad_bytes = max(0, len(payload) - len(encode_frame(Frame(FRAME_PING, offset=0))))
        self.state.metrics["down_responses"][source_lane] += 1
        self.state.metrics["down_frames"][source_lane] += frames
        self.state.metrics["down_bytes"][source_lane] += len(payload)
        self.state.metrics["down_hold_ms"][source_lane] += hold_ms
        self.state.metrics["down_pad_bytes"][source_lane] += pad_bytes
        trace("down send role=%s peer=%s session=%s lane=data source=%s frames=%s bytes=%s hold_ms=%s" % (
            peer.role,
            peer.peer_label,
            peer.peer_session_id,
            source_lane,
            frames,
            len(payload),
            hold_ms,
        ))
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/octet-stream\r\n"
            b"Cache-Control: no-store\r\n"
            + ("Content-Length: %d\r\n\r\n" % len(payload)).encode("ascii")
        )
        writer.write(payload)
        await writer.drain()

    async def _handle_helper_ctl_down(self, writer, peer):
        trace("down stream open role=%s peer=%s session=%s lane=ctl" % (peer.role, peer.peer_label, peer.peer_session_id))
        queue = peer.queues[LANE_CTL]
        try:
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/octet-stream\r\n"
                b"Cache-Control: no-store\r\n"
                b"Transfer-Encoding: chunked\r\n"
                b"Connection: close\r\n\r\n"
            )
            await writer.drain()
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=10.0)
                    peer.touch()
                    self.state.metrics["down_responses"][LANE_CTL] += 1
                    self.state.metrics["down_frames"][LANE_CTL] += 1
                    self.state.metrics["down_bytes"][LANE_CTL] += len(payload)
                    trace("down stream send role=%s peer=%s session=%s source=ctl frames=1 bytes=%s hold_ms=0" % (
                        peer.role,
                        peer.peer_label,
                        peer.peer_session_id,
                        len(payload),
                    ))
                    await self._write_chunk(writer, payload)
                except asyncio.TimeoutError:
                    heartbeat = encode_frame(Frame(FRAME_PING, offset=now_ms()))
                    await self._write_chunk(writer, heartbeat)
        except Exception as error:
            trace("down stream error role=%s peer=%s session=%s lane=ctl error=%r" % (peer.role, peer.peer_label, peer.peer_session_id, error))
            raise

    async def _next_data_payload(self, peer):
        pri_queue = peer.queues["pri"]
        bulk_queue = peer.queues["bulk"]
        profile = None
        source_lane = None
        try:
            first = pri_queue.queue.get_nowait()
            pri_queue.buffered_bytes = max(0, pri_queue.buffered_bytes - len(first))
            source_lane = "pri"
        except asyncio.QueueEmpty:
            try:
                first = bulk_queue.queue.get_nowait()
                bulk_queue.buffered_bytes = max(0, bulk_queue.buffered_bytes - len(first))
                source_lane = "bulk"
            except asyncio.QueueEmpty:
                loop = asyncio.get_event_loop()
                pri_task = loop.create_task(pri_queue.get())
                bulk_task = loop.create_task(bulk_queue.get())
                done, pending = await asyncio.wait([pri_task, bulk_task], timeout=10.0, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                if not done:
                    return None, None, 0, 0, 0
                completed = done.pop()
                first = completed.result()
                source_lane = "pri" if completed is pri_task else "bulk"
        peer.touch()
        profile = self.state.lane_profile(source_lane)
        payloads = [first]
        total = len(first)
        frames = 1
        hold_started = asyncio.get_event_loop().time()
        deadline = asyncio.get_event_loop().time() + (float(profile["hold_ms"]) / 1000.0)
        queue = peer.queues[source_lane]
        while total < int(profile["max_bytes"]) and frames < int(profile["max_frames"]):
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            payloads.append(payload)
            total += len(payload)
            frames += 1
        body = b"".join(payloads)
        padded = padded_payload(body, minimum_size=int(profile["pad_min"])) if int(profile["pad_min"]) > 0 else body
        pad_bytes = max(0, len(padded) - len(body))
        hold_ms = max(0, int((asyncio.get_event_loop().time() - hold_started) * 1000))
        return padded, source_lane, frames, hold_ms, pad_bytes

    async def _write_chunk(self, writer, body):
        if not body:
            return
        writer.write(("%x\r\n" % len(body)).encode("ascii"))
        writer.write(body)
        writer.write(b"\r\n")
        await writer.drain()

    async def _handle_up(self, writer, role, peer_session_id, lane, body):
        decoder = FrameDecoder()
        frame_count = 0
        batch_lane = lane if lane != LANE_DATA else "pri"
        for frame in decoder.feed(body):
            frame_count += 1
            frame_lane = lane
            if lane == LANE_DATA and frame.type_id == FRAME_DATA:
                frame_lane = "bulk" if (frame.flags & FLAG_DATA_BULK) else "pri"
                if frame_lane == "bulk":
                    batch_lane = "bulk"
            elif lane == LANE_DATA:
                frame_lane = LANE_CTL
            if frame.type_id != FRAME_DATA:
                trace("up recv role=%s session=%s lane=%s type=%s stream=%s bytes=%s" % (role, peer_session_id, frame_lane, frame.type_id, frame.stream_id, len(frame.payload)))
            await self.state.handle_frame(role, peer_session_id, frame_lane, frame)
            self.state.metrics["up_frames"][frame_lane] += 1
            self.state.metrics["up_bytes"][frame_lane] += len(encode_frame(frame))
        self.state.metrics["up_batches"][batch_lane] += 1
        await self._send_json(writer, 200, {"ok": True})

    async def _send_json(self, writer, status, payload):
        body = json.dumps(payload).encode("utf-8")
        writer.write(
            ("HTTP/1.1 %d OK\r\n" % int(status)).encode("ascii")
            + b"Content-Type: application/json\r\n"
            + ("Content-Length: %d\r\n" % len(body)).encode("ascii")
            + b"Connection: close\r\n\r\n"
            + body
        )
        await writer.drain()

    async def _read_request(self, reader):
        head = await reader.readuntil(b"\r\n\r\n")
        header_blob = head.decode("iso-8859-1")
        lines = header_blob.split("\r\n")
        request_line = lines[0]
        headers = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
        length = int(headers.get("content-length", "0") or "0")
        body = b""
        if length > 0:
            body = await reader.readexactly(length)
        return request_line, headers, body


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main():
    parser = argparse.ArgumentParser(description="Twoman localhost broker")
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", required=True, type=int)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = load_config(args.config)
    server = AsyncBrokerServer(args.listen_host, args.listen_port, config)
    loop = asyncio.get_event_loop()
    loop.run_until_complete(server.start())
    loop.run_forever()


if __name__ == "__main__":
    main()
