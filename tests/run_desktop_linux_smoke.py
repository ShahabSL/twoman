#!/usr/bin/env python3
"""Exercise the real Tauri webview, Rust IPC and bundled client runtimes.

Run under Xvfb with WebKitWebDriver installed. All relay traffic stays on
loopback and application state is isolated from the user's saved profiles.
"""

import argparse
import base64
import contextlib
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import urllib.request


def main():
    repo = Path(__file__).resolve().parents[1]
    version = (repo / 'VERSION').read_text().strip()
    parser = argparse.ArgumentParser(description='Test a packaged Linux desktop client against a local relay.')
    parser.add_argument('--app', type=Path, default=repo / f'dist/desktop-linux/twoman-desktop-linux-amd64-v{version}/Twoman')
    parser.add_argument('--sidecars', type=Path, help='Directory containing the packaged helper and gateway')
    parser.add_argument('--output', type=Path, default=repo / 'desktop_app/build/linux-smoke')
    args = parser.parse_args()
    qa = args.output.resolve()
    qa.mkdir(parents=True, exist_ok=True)
    app = args.app.resolve()
    sidecars = args.sidecars.resolve() if args.sidecars else app.parent / 'sidecars/linux'
    helper = sidecars / 'twoman-helper'
    assert f' {version} ' in subprocess.check_output([str(helper), '--version'], text=True)
    processes = []
    session = None
    connected = False

    def port():
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            return sock.getsockname()[1]

    def launch(args, name, env=None):
        stream = (qa / f'{name}.log').open('w')
        process = subprocess.Popen(args, stdout=stream, stderr=subprocess.STDOUT, env=env, cwd=qa, start_new_session=True)
        stream.close()
        processes.append(process)
        return process

    def wait_port(number):
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1', number), timeout=.2):
                    return
            except OSError:
                time.sleep(.1)
        raise RuntimeError(f'Port {number} never opened')

    marker = b'twoman-linux-packaged-client-ok'
    class Origin(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Length', str(len(marker)))
            self.end_headers()
            self.wfile.write(marker)
        def log_message(self, *args):
            pass

    origin = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Origin)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    broker_port, driver_port = port(), port()
    base_url = f'http://127.0.0.1:{broker_port}/api/v1/telemetry'
    (qa / 'broker.json').write_text(json.dumps({
        'client_tokens': ['linux-smoke-client'], 'agent_tokens': ['linux-smoke-agent'],
        'binary_media_type': 'image/webp', 'peer_ttl_seconds': 90, 'stream_ttl_seconds': 300,
        'max_lane_bytes': 16777216, 'max_peer_buffered_bytes': 33554432, 'max_frame_payload_bytes': 2097152,
        'down_wait_ms': {'ctl': 75, 'data': 75}, 'helper_down_combined_data_lane': True,
        'agent_down_combined_data_lane': True, 'streaming_data_down_helper': False,
        'streaming_data_down_agent': False, 'base_uri': '/api/v1/telemetry'}))
    (qa / 'bind-localhost.cjs').write_text('const net = require("node:net"); const listen = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[1] === "function") args.splice(1,0,"127.0.0.1"); return listen.apply(this,args); };\n')
    (qa / 'agent.json').write_text(json.dumps({
        'broker_base_url': base_url, 'agent_token': 'linux-smoke-agent', 'auth_mode': 'bearer',
        'binary_media_type': 'image/webp', 'route_template': '/{lane}/{direction}',
        'health_template': '/health', 'peer_id': 'linux-smoke-agent', 'http_timeout_seconds': 10,
        'flush_delay_seconds': .01, 'max_batch_bytes': 131072, 'verify_tls': True,
        'http2_enabled': {'ctl': False, 'data': False}}))

    def wd(method, endpoint, value=None):
        body = json.dumps(value).encode() if value is not None else None
        request = urllib.request.Request(f'http://127.0.0.1:{driver_port}{endpoint}', data=body,
            method=method, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.load(response)['value']
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        return result

    def execute(script):
        return wd('POST', f'/session/{session}/execute/sync', {'script': script, 'args': []})

    def invoke(command, args=None):
        result = wd('POST', f'/session/{session}/execute/async', {
            'script': 'const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));',
            'args': [command, args or {}]})
        if not result['ok']:
            raise RuntimeError(f'{command}: {result["error"]}')
        return result.get('value')

    def screenshot(name):
        (qa / name).write_bytes(base64.b64decode(wd('GET', f'/session/{session}/screenshot')))

    try:
        env = os.environ.copy()
        env.update(PORT=str(broker_port), TWOMAN_CONFIG_PATH=str(qa / 'broker.json'))
        launch(['node', '--require', str(qa / 'bind-localhost.cjs'), str(repo / 'host/node_selector/broker.js')], 'broker', env)
        wait_port(broker_port)
        launch([str(helper), '--mode', 'agent', '--config', str(qa / 'agent.json')], 'agent')
        env = os.environ.copy()
        state = qa / f'state-{time.time_ns()}'
        env.update(TAURI_WEBVIEW_AUTOMATION='true', GDK_BACKEND='x11',
                   XDG_CONFIG_HOME=str(state / 'config'), XDG_DATA_HOME=str(state / 'data'),
                   XDG_CACHE_HOME=str(state / 'cache'))
        env.pop('WAYLAND_DISPLAY', None)
        for name in ('TWOMAN_PORTABLE', 'TWOMAN_HELPER_BIN', 'TWOMAN_GATEWAY_BIN'):
            env.pop(name, None)
        launch(['WebKitWebDriver', f'--port={driver_port}', '--host=127.0.0.1'], 'webdriver', env)
        wait_port(driver_port)
        result = wd('POST', '/session', {'capabilities': {'alwaysMatch': {
            'webkitgtk:browserOptions': {'binary': str(app), 'args': []}}}})
        session = result['sessionId']
        wd('POST', f'/session/{session}/timeouts', {'script': 60000})
        for _ in range(100):
            if execute('return !!window.__TAURI_INTERNALS__ && document.body.innerText.includes("Twoman")'):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Native interface did not load')
        initial = invoke('load_snapshot')
        assert initial['platform'] == {'os': 'linux', 'systemModeSupported': False, 'tunnelModeSupported': False}, initial['platform']
        assert not initial['profiles'], 'Test configuration is not isolated'
        for _ in range(100):
            if execute('return Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)'):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Brand image did not load')
        screenshot('01-empty.png')
        http_port, socks_port = port(), port()
        profile = dict(id='linux-smoke', helperPeerId='twoman-desktop-linux-smoke', name='Linux build verification',
            brokerBaseUrl=base_url, clientToken='linux-smoke-client', targetAgentPeerLabel='linux-smoke-agent',
            verifyTls=True, http2Ctl=False, http2Data=False, httpPort=http_port, socksPort=socks_port,
            httpTimeoutSeconds=10, flushDelaySeconds=.01, maxBatchBytes=0, dataUploadMaxBatchBytes=0,
            dataUploadFlushDelaySeconds=0., idleRepollCtlSeconds=.05, idleRepollDataSeconds=.1, traceEnabled=False)
        invoke('save_profile', {'profile': profile})
        invoke('set_selected_profile', {'profileId': profile['id']})
        snapshot = invoke('connect')
        connected = True
        assert snapshot['connection']['phase'] == 'connected', snapshot['connection']
        assert Path(f'/proc/{snapshot["connection"]["helperPid"]}/exe').resolve() == helper.resolve(), 'Helper did not come from the package'
        target = f'http://127.0.0.1:{origin.server_port}/smoke'
        checks = []
        def probe(proxy, label):
            result = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--max-time', '30', '--noproxy', '', '--proxy', proxy, target], timeout=35)
            assert result == marker, (label, result)
            checks.append(label)
            print(f'PASS: {label}', flush=True)
        probe(f'http://127.0.0.1:{http_port}', 'packaged helper HTTP proxy')
        probe(f'socks5h://127.0.0.1:{socks_port}', 'packaged helper SOCKS proxy')
        for protocol in ('socks', 'http'):
            share_port = port()
            share = dict(id=f'linux-{protocol}', name=f'Linux {protocol}', protocol=protocol,
                         listenHost='127.0.0.1', listenPort=share_port, username='test-user', password='test-password')
            invoke('save_share', {'share': share})
            shared = invoke('start_share', {'shareId': share['id']})
            status = next(item for item in shared['shareStatuses'] if item['shareId'] == share['id'])
            assert status['running'], status
            assert Path(f'/proc/{status["pid"]}/exe').resolve() == (helper.parent / 'twoman-gateway').resolve(), 'Gateway did not come from the package'
            scheme = 'socks5h' if protocol == 'socks' else 'http'
            probe(f'{scheme}://test-user:test-password@127.0.0.1:{share_port}', f'packaged authenticated {protocol} share')
            rejected = subprocess.run(['curl', '--fail', '--silent', '--max-time', '10', '--noproxy', '', '--proxy', f'{scheme}://wrong:wrong@127.0.0.1:{share_port}', target], capture_output=True, timeout=15)
            assert rejected.returncode != 0, f'{protocol} share accepted invalid credentials'
            checks.append(f'{protocol} share rejects invalid credentials')
            invoke('stop_share', {'shareId': share['id']})
        time.sleep(1.5)
        screenshot('02-connected.png')
        snapshot = invoke('disconnect')
        connected = False
        assert snapshot['connection']['phase'] == 'disconnected'
        for number in (http_port, socks_port):
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', number))
        checks.append('disconnect releases both proxy ports')
        snapshot = invoke('connect')
        connected = True
        assert snapshot['connection']['phase'] == 'connected'
        invoke('disconnect')
        connected = False
        checks.append('reconnect and disconnect')
        body = execute('return document.body.innerText')
        (qa / 'ui-text.txt').write_text(body)
        (qa / 'report.json').write_text(json.dumps({'platform': initial['platform'], 'checks': checks,
            'packagedSidecarsVerified': True}, indent=2) + '\n')
        print('PASS: native Linux interface, Rust IPC, both bundled sidecars, disconnect and reconnect', flush=True)
    finally:
        if session:
            if connected:
                with contextlib.suppress(Exception):
                    invoke('disconnect')
            with contextlib.suppress(Exception):
                wd('DELETE', f'/session/{session}')
        for process in reversed(processes):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
        for process in reversed(processes):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        origin.shutdown()
        origin.server_close()


if __name__ == "__main__":
    main()
