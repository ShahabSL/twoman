import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path

from twoman_crypto import TransportCipher
from twoman_http import build_connection_headers, expected_binary_media_type
from twoman_protocol import FRAME_HEADER, FRAME_PING, Frame, FrameDecoder, encode_frame
from twoman_protocol import FRAME_OPEN, FRAME_OPEN_FAIL, make_open_payload, parse_error_payload

ROOT = Path(__file__).resolve().parents[1]


class NodeSelectorRuntimeTests(unittest.TestCase):
    def test_resident_intervals_remain_referenced(self) -> None:
        source = (ROOT / "host" / "node_selector" / "broker.js").read_text(encoding="utf-8")
        bundle = (ROOT / "host" / "node_selector" / "app.js").read_text(encoding="utf-8")

        for text in (source, bundle):
            self.assertNotIn("}, 10000).unref();", text)
            self.assertNotIn("}, HEARTBEAT_INTERVAL_MS).unref();", text)

    def test_source_has_broker_hardening_guards(self) -> None:
        source = (ROOT / "host" / "node_selector" / "broker.js").read_text(encoding="utf-8")

        self.assertIn("length > this.maxFramePayloadBytes", source)
        self.assertIn("peer.bufferedBytesTotal() + encoded.length", source)
        self.assertIn("targetQueue.bufferedBytes + encoded.length", source)
        self.assertIn("const queued = this.queueFrame(", source)
        self.assertIn("this.dropStream(stream, \"agent-queue-full\")", source)
        self.assertIn("if (!state.websocketPublicEnabled)", source)
        self.assertIn("cookies._cfauth", source)

    def test_node_broker_binds_cipher_to_authenticated_token(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["old-client-token", "new-client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "down_wait_ms": {"ctl": 50, "data": 50},
            }
        )
        with broker:
            frame = encode_frame(Frame(FRAME_PING))
            status, payload = broker.request(
                "POST",
                "/ctl/up",
                "new-client-token",
                "helper",
                _encrypt("new-client-token", frame),
            )

            self.assertEqual(status, 200, payload)
            self.assertEqual(json.loads(payload.decode("utf-8"))["frames"], 1)

            status, payload = broker.request(
                "GET",
                "/ctl/down",
                "new-client-token",
                "helper",
                b"",
            )
            self.assertEqual(status, 200, payload)
            frames = FrameDecoder().feed(_decrypt("new-client-token", payload))
            self.assertEqual(len(frames), 1)
            self.assertEqual(frames[0].type_id, FRAME_PING)

    def test_node_broker_supports_aes_cipher_for_go_dataplane(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "down_wait_ms": {"ctl": 50, "data": 50},
            }
        )
        with broker:
            frame = encode_frame(Frame(FRAME_PING))
            status, payload = broker.request(
                "POST",
                "/ctl/up",
                "client-token",
                "helper",
                _encrypt_aes("client-token", frame),
                extra_headers={"X-Twoman-Cipher": "aes-256-ctr-v2"},
            )

            self.assertEqual(status, 200, payload)
            self.assertEqual(json.loads(payload.decode("utf-8"))["frames"], 1)

            status, payload = broker.request(
                "GET",
                "/ctl/down",
                "client-token",
                "helper",
                b"",
                extra_headers={"X-Twoman-Cipher": "aes-256-ctr-v2"},
            )
            self.assertEqual(status, 200, payload)
            frames = FrameDecoder().feed(_decrypt_aes("client-token", payload))
            self.assertEqual(len(frames), 1)
            self.assertEqual(frames[0].type_id, FRAME_PING)

    def test_node_broker_rejects_oversized_frames_before_buffering(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "max_frame_payload_bytes": 8,
            }
        )
        with broker:
            oversized_header = FRAME_HEADER.pack(FRAME_PING, 0, 0, 0, 0, 128)
            status, payload = broker.request(
                "POST",
                "/ctl/up",
                "client-token",
                "helper",
                _encrypt("client-token", oversized_header),
            )

            self.assertEqual(status, 413, payload)
            self.assertIn(b"frame payload too large", payload)

    def test_node_broker_rejects_websocket_upgrade_when_not_advertised(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "websocket_public_enabled": False,
            }
        )
        with broker:
            with socket.create_connection(("127.0.0.1", broker.port), timeout=2.0) as sock:
                sock.sendall(
                    (
                        "GET /ws-echo HTTP/1.1\r\n"
                        "Host: 127.0.0.1\r\n"
                        "Upgrade: websocket\r\n"
                        "Connection: Upgrade\r\n"
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                        "Sec-WebSocket-Version: 13\r\n"
                        "\r\n"
                    ).encode("ascii")
                )
                response = sock.recv(256)

            self.assertTrue(response.startswith(b"HTTP/1.1 404 Not Found"), response)

    def test_node_broker_prefers_configured_agent_peer_when_multiple_agents_poll(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "down_wait_ms": {"ctl": 50, "data": 50},
                "preferred_agent_peer_label": "agent-main",
            }
        )
        with broker:
            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="old-agent", session="old-session")
            self.assertEqual(broker.get_json("/health")["agent_peer_label"], "old-agent")

            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="agent-main", session="new-session")
            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="old-agent", session="old-session")

            health = broker.get_json("/health")
            self.assertEqual(health["agent_peer_label"], "agent-main")
            self.assertEqual(health["agent_session_id"], "new-session")

    def test_node_broker_routes_open_to_target_agent_peer_label(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "debug_stats_enabled": True,
                "down_wait_ms": {"ctl": 50, "data": 50},
                "preferred_agent_peer_label": "agent-main",
            }
        )
        with broker:
            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="agent-main", session="main-session")
            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="agent-nima", session="nima-session")
            open_frame = encode_frame(
                Frame(
                    FRAME_OPEN,
                    stream_id=17,
                    payload=make_open_payload("example.com", 443, target_agent_peer_label="agent-nima"),
                )
            )

            status, payload = broker.request(
                "POST",
                "/ctl/up",
                "client-token",
                "helper",
                _encrypt("client-token", open_frame),
                peer="helper-bench",
                session="helper-session",
                extra_headers={"X-Twoman-Target-Agent": "agent-nima"},
            )

            self.assertEqual(status, 200, payload)
            streams = broker.get_json("/health")["stream_details"]
            self.assertEqual(streams[0]["agent_session_id"], "nima-session")

    def test_node_broker_fails_targeted_open_when_agent_unavailable(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "down_wait_ms": {"ctl": 50, "data": 50},
            }
        )
        with broker:
            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="agent-main", session="main-session")
            open_frame = encode_frame(
                Frame(
                    FRAME_OPEN,
                    stream_id=17,
                    payload=make_open_payload("example.com", 443, target_agent_peer_label="agent-missing"),
                )
            )
            status, payload = broker.request(
                "POST",
                "/ctl/up",
                "client-token",
                "helper",
                _encrypt("client-token", open_frame),
                peer="helper-bench",
                session="helper-session",
                extra_headers={"X-Twoman-Target-Agent": "agent-missing"},
            )
            self.assertEqual(status, 200, payload)

            status, payload = broker.request(
                "GET",
                "/ctl/down",
                "client-token",
                "helper",
                b"",
                peer="helper-bench",
                session="helper-session",
                extra_headers={"X-Twoman-Target-Agent": "agent-missing"},
            )
            self.assertEqual(status, 200, payload)
            frames = FrameDecoder().feed(_decrypt("client-token", payload))
            self.assertEqual(frames[0].type_id, FRAME_OPEN_FAIL)
            self.assertIn("target agent unavailable", parse_error_payload(frames[0].payload))

    def test_node_broker_drops_same_label_stale_helper_session(self) -> None:
        broker = _NodeBrokerFixture(
            {
                "client_tokens": ["client-token"],
                "agent_tokens": ["agent-token"],
                "binary_media_type": "image/webp",
                "health_public": True,
                "down_wait_ms": {"ctl": 50, "data": 50},
                "preferred_agent_peer_label": "agent-main",
            }
        )
        with broker:
            broker.request("GET", "/data/down", "agent-token", "agent", b"", peer="agent-main", session="agent-session")
            open_frame = encode_frame(
                Frame(FRAME_OPEN, stream_id=17, payload=make_open_payload("example.com", 443))
            )
            status, payload = broker.request(
                "POST",
                "/ctl/up",
                "client-token",
                "helper",
                _encrypt("client-token", open_frame),
                peer="helper-bench",
                session="old-helper-session",
            )
            self.assertEqual(status, 200, payload)
            self.assertEqual(broker.get_json("/health")["streams"], 1)

            broker.request("GET", "/data/down", "client-token", "helper", b"", peer="helper-bench", session="new-helper-session")

            self.assertEqual(broker.get_json("/health")["streams"], 0)


class _NodeBrokerFixture:
    def __init__(self, config):
        self.config = dict(config)
        self.tmpdir = None
        self.proc = None
        self.port = _free_port()

    def __enter__(self):
        if not shutil.which("node"):
            raise unittest.SkipTest("node is not installed")
        if not (ROOT / "host" / "node_selector" / "node_modules" / "ws").exists():
            raise unittest.SkipTest("host/node_selector/node_modules/ws is not installed")
        self.tmpdir = tempfile.TemporaryDirectory()
        config_path = Path(self.tmpdir.name) / "broker-config.json"
        config_path.write_text(json.dumps(self.config), encoding="utf-8")
        env = {
            **dict(os.environ),
            "PORT": str(self.port),
            "TWOMAN_CONFIG_PATH": str(config_path),
            "TWOMAN_TRACE": "0",
            "TWOMAN_DEBUG_STATS": "0",
        }
        self.proc = subprocess.Popen(
            ["node", str(ROOT / "host" / "node_selector" / "broker.js")],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._wait_until_ready()
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        if self.tmpdir:
            self.tmpdir.cleanup()

    def _wait_until_ready(self):
        deadline = time.time() + 5.0
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                stdout, stderr = self.proc.communicate(timeout=1)
                raise AssertionError(
                    "node broker exited early\nstdout=%s\nstderr=%s"
                    % (stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace"))
                )
            try:
                conn = HTTPConnection("127.0.0.1", self.port, timeout=0.2)
                conn.request("GET", "/health")
                response = conn.getresponse()
                response.read()
                conn.close()
                if response.status == 200:
                    return
            except OSError:
                time.sleep(0.05)
        raise AssertionError("node broker did not become ready")

    def request(self, method, path, token, role, body, peer=None, session=None, extra_headers=None):
        config = {
            "auth_mode": "bearer",
            "legacy_custom_headers_enabled": False,
            "binary_media_type": self.config.get("binary_media_type", "image/webp"),
        }
        headers = build_connection_headers(
            token,
            role,
            peer or "%s-peer" % role,
            session or "%s-session" % role,
            config,
        )
        if method == "POST":
            headers["Content-Type"] = expected_binary_media_type(config)
        if extra_headers:
            headers.update(extra_headers)
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5.0)
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        return response.status, payload

    def get_json(self, path):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5.0)
        conn.request("GET", path)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        self.assert_status_ok(response.status, payload)
        return json.loads(payload.decode("utf-8"))

    @staticmethod
    def assert_status_ok(status, payload):
        if status != 200:
            raise AssertionError("HTTP %s: %r" % (status, payload))


def _encrypt(token, plaintext):
    iv = bytes(range(16))
    cipher = TransportCipher(str(token).encode("utf-8"), iv)
    return iv + cipher.process(plaintext)


def _decrypt(token, ciphertext):
    iv = ciphertext[:16]
    cipher = TransportCipher(str(token).encode("utf-8"), iv)
    return cipher.process(ciphertext[16:])


def _encrypt_aes(token, plaintext):
    iv = bytes(range(16))
    return iv + _node_aes_process(token, iv, plaintext)


def _decrypt_aes(token, ciphertext):
    return _node_aes_process(token, ciphertext[:16], ciphertext[16:])


def _node_aes_process(token, iv, payload):
    script = """
const crypto = require('crypto');
const token = Buffer.from(process.argv[1], 'utf8');
const iv = Buffer.from(process.argv[2], 'hex');
const payload = Buffer.from(process.argv[3], 'hex');
const key = crypto.createHash('sha256').update(token.length ? token : Buffer.from('twoman-default-key')).digest();
const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
process.stdout.write(cipher.update(payload).toString('hex'));
"""
    out = subprocess.check_output(
        ["node", "-e", script, str(token), iv.hex(), payload.hex()],
        cwd=str(ROOT),
    )
    return bytes.fromhex(out.decode("ascii"))


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


if __name__ == "__main__":
    unittest.main()
