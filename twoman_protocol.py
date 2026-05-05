#!/usr/bin/env python3

import os
import struct


LANE_CTL = "ctl"
LANE_PRI = "pri"
LANE_BULK = "bulk"
LANE_DATA = "data"
LANES = (LANE_CTL, LANE_PRI, LANE_BULK)

FRAME_HELLO = 1
FRAME_HELLO_OK = 2
FRAME_OPEN = 3
FRAME_OPEN_OK = 4
FRAME_OPEN_FAIL = 5
FRAME_DATA = 6
FRAME_WINDOW = 7
FRAME_FIN = 8
FRAME_RST = 9
FRAME_PING = 10
FRAME_GOAWAY = 11
FRAME_DNS_QUERY = 12
FRAME_DNS_RESPONSE = 13
FRAME_DNS_FAIL = 14

MODE_TCP = 1

FRAME_HEADER = struct.Struct("!BBH I Q I")
FLAG_NONE = 0
FLAG_DATA_BULK = 1


class Frame(object):
    __slots__ = ("type_id", "flags", "stream_id", "offset", "payload")

    def __init__(self, type_id, stream_id=0, offset=0, payload=b"", flags=FLAG_NONE):
        self.type_id = int(type_id)
        self.flags = int(flags)
        self.stream_id = int(stream_id)
        self.offset = int(offset)
        self.payload = payload or b""


class FrameDecoder(object):
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        frames = []
        while True:
            if len(self.buffer) < FRAME_HEADER.size:
                return frames
            type_id, flags, _reserved, stream_id, offset, length = FRAME_HEADER.unpack(
                self.buffer[: FRAME_HEADER.size]
            )
            total = FRAME_HEADER.size + length
            if len(self.buffer) < total:
                return frames
            payload = bytes(self.buffer[FRAME_HEADER.size:total])
            del self.buffer[:total]
            frames.append(Frame(type_id=type_id, flags=flags, stream_id=stream_id, offset=offset, payload=payload))


def encode_frame(frame):
    payload = frame.payload or b""
    return FRAME_HEADER.pack(
        int(frame.type_id),
        int(frame.flags),
        0,
        int(frame.stream_id),
        int(frame.offset),
        len(payload),
    ) + payload


def make_open_payload(host, port, mode=MODE_TCP):
    host_bytes = host.encode("utf-8")
    if len(host_bytes) > 65535:
        raise ValueError("host is too long")
    return struct.pack("!BH", int(mode), int(port)) + struct.pack("!H", len(host_bytes)) + host_bytes


def parse_open_payload(payload):
    if len(payload) < 5:
        raise ValueError("open payload is too short")
    mode, port = struct.unpack("!BH", payload[:3])
    host_length = struct.unpack("!H", payload[3:5])[0]
    if len(payload) < (5 + host_length):
        raise ValueError("open payload host is truncated")
    host = payload[5:5 + host_length].decode("utf-8")
    return {
        "mode": mode,
        "port": int(port),
        "host": host,
    }


def make_error_payload(message):
    return (message or "").encode("utf-8")


def parse_error_payload(payload):
    return payload.decode("utf-8", errors="replace")


def random_peer_id():
    return os.urandom(8).hex()
