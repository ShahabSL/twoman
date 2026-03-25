<?php

require_once __DIR__ . '/bootstrap.php';

function bridge_runtime_dir()
{
    return dirname(__DIR__) . '/runtime';
}

function bridge_runtime_logs_dir()
{
    return bridge_runtime_dir() . '/logs';
}

function bridge_runtime_local_host()
{
    return '127.0.0.1';
}

function bridge_runtime_local_port()
{
    $config = relay_config();
    return isset($config['bridge_local_port']) ? (int) $config['bridge_local_port'] : 18093;
}

function bridge_runtime_daemon_script()
{
    return bridge_runtime_dir() . '/http_broker_daemon.py';
}

function bridge_runtime_daemon_pid_path()
{
    return bridge_runtime_dir() . '/bridge.pid';
}

function bridge_runtime_daemon_config_path()
{
    return bridge_runtime_dir() . '/bridge-config.json';
}

function bridge_runtime_max_lane_bytes()
{
    $config = relay_config();
    return isset($config['bridge_max_lane_bytes']) ? max(65536, (int) $config['bridge_max_lane_bytes']) : (16 * 1024 * 1024);
}

function bridge_runtime_is_process_alive($pid)
{
    $pid = (int) $pid;
    if ($pid < 2) {
        return false;
    }

    return function_exists('posix_kill') ? @posix_kill($pid, 0) : file_exists('/proc/' . $pid);
}

function bridge_runtime_read_pid($path)
{
    if (!file_exists($path)) {
        return 0;
    }

    $content = trim((string) @file_get_contents($path));
    return preg_match('/^[0-9]+$/', $content) ? (int) $content : 0;
}

function bridge_runtime_write_pid($path, $pid)
{
    @file_put_contents($path, (string) (int) $pid, LOCK_EX);
}

function bridge_runtime_kill_matching_processes()
{
    $script = bridge_runtime_daemon_script();
    $port = bridge_runtime_local_port();
    $command = "ps -eo pid=,args= | grep " . escapeshellarg($script)
        . " | grep -- '--listen-port " . (int) $port
        . "' | grep -v grep | awk '{print \$1}'";
    $output = trim((string) @shell_exec($command));
    if ($output === '') {
        return;
    }

    foreach (preg_split('/\s+/', $output) as $candidate) {
        if ($candidate === '' || !preg_match('/^[0-9]+$/', $candidate)) {
            continue;
        }
        bridge_runtime_stop_pid((int) $candidate);
    }
}

function bridge_runtime_stop_pid($pid)
{
    $pid = (int) $pid;
    if ($pid < 2) {
        return;
    }

    if (function_exists('posix_kill')) {
        @posix_kill($pid, 15);
        usleep(300000);
        if (bridge_runtime_is_process_alive($pid)) {
            @posix_kill($pid, 9);
        }
    } else {
        @shell_exec('kill ' . $pid . ' >/dev/null 2>&1 || true');
    }
}

function bridge_runtime_bootstrap_files()
{
    relay_ensure_dir(bridge_runtime_dir());
    relay_ensure_dir(bridge_runtime_logs_dir());
}

function bridge_runtime_write_config()
{
    $config = relay_config();
    $payload = [
        'client_tokens' => isset($config['client_tokens']) ? array_values($config['client_tokens']) : [],
        'agent_tokens' => isset($config['agent_tokens']) ? array_values($config['agent_tokens']) : [],
        'session_ttl_seconds' => isset($config['bridge_session_ttl_seconds']) ? (int) $config['bridge_session_ttl_seconds'] : 300,
        'peer_ttl_seconds' => isset($config['bridge_max_agent_idle_seconds']) ? (int) $config['bridge_max_agent_idle_seconds'] : 90,
        'stream_ttl_seconds' => isset($config['bridge_session_ttl_seconds']) ? (int) $config['bridge_session_ttl_seconds'] : 300,
        'max_lane_bytes' => bridge_runtime_max_lane_bytes(),
    ];

    $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        relay_fail(500, 'Unable to encode bridge config');
    }

    if (@file_put_contents(bridge_runtime_daemon_config_path(), $json, LOCK_EX) === false) {
        relay_fail(500, 'Unable to write bridge config');
    }
}

function bridge_runtime_tcp_is_open($host, $port)
{
    $errno = 0;
    $errstr = '';
    $socket = @fsockopen($host, (int) $port, $errno, $errstr, 1.0);
    if (!is_resource($socket)) {
        return false;
    }

    fclose($socket);
    return true;
}

function bridge_runtime_http_get($path, $timeoutSeconds)
{
    $errno = 0;
    $errstr = '';
    $socket = @fsockopen(
        bridge_runtime_local_host(),
        bridge_runtime_local_port(),
        $errno,
        $errstr,
        $timeoutSeconds
    );
    if (!is_resource($socket)) {
        return false;
    }

    stream_set_timeout($socket, (int) ceil($timeoutSeconds));
    $request = "GET " . $path . " HTTP/1.1\r\n"
        . "Host: " . bridge_runtime_local_host() . "\r\n"
        . "Connection: close\r\n\r\n";
    fwrite($socket, $request);

    $response = '';
    while (!feof($socket)) {
        $chunk = fread($socket, 8192);
        if ($chunk === false) {
            fclose($socket);
            return false;
        }
        $response .= $chunk;
    }
    fclose($socket);

    $parts = explode("\r\n\r\n", $response, 2);
    return count($parts) === 2 ? $parts[1] : false;
}

function bridge_runtime_ping()
{
    if (!bridge_runtime_tcp_is_open(bridge_runtime_local_host(), bridge_runtime_local_port())) {
        return false;
    }

    $body = bridge_runtime_http_get('/health', 2.0);
    if ($body === false || $body === '') {
        return false;
    }

    $decoded = json_decode($body, true);
    return is_array($decoded) && !empty($decoded['ok']);
}

function bridge_runtime_start()
{
    $script = bridge_runtime_daemon_script();
    if (!file_exists($script)) {
        relay_fail(500, 'Bridge runtime files are missing');
    }

    bridge_runtime_kill_matching_processes();
    bridge_runtime_write_config();
    $logPath = bridge_runtime_logs_dir() . '/bridge.log';
    $command = 'cd ' . escapeshellarg(bridge_runtime_dir())
        . ' && nohup /bin/python3 ' . escapeshellarg($script)
        . ' --listen-host ' . escapeshellarg(bridge_runtime_local_host())
        . ' --listen-port ' . (int) bridge_runtime_local_port()
        . ' --config ' . escapeshellarg(bridge_runtime_daemon_config_path())
        . ' >> ' . escapeshellarg($logPath) . ' 2>&1 < /dev/null & echo $!';
    $pid = trim((string) @shell_exec($command));
    if ($pid !== '' && preg_match('/^[0-9]+$/', $pid)) {
        bridge_runtime_write_pid(bridge_runtime_daemon_pid_path(), (int) $pid);
    }
}

function bridge_runtime_wait_until($callback, $timeoutMs)
{
    $deadline = microtime(true) + ($timeoutMs / 1000.0);
    while (microtime(true) < $deadline) {
        if ($callback()) {
            return true;
        }
        usleep(100000);
    }
    return false;
}

function bridge_runtime_ensure()
{
    bridge_runtime_bootstrap_files();
    bridge_runtime_write_config();
    if (bridge_runtime_ping()) {
        return;
    }

    $pid = bridge_runtime_read_pid(bridge_runtime_daemon_pid_path());
    if (bridge_runtime_is_process_alive($pid)) {
        bridge_runtime_stop_pid($pid);
    }
    bridge_runtime_kill_matching_processes();
    bridge_runtime_start();
    if (!bridge_runtime_wait_until(function () {
        return bridge_runtime_ping();
    }, 8000)) {
        relay_fail(502, 'Host bridge daemon did not start');
    }
}

function bridge_runtime_bridge_base_url()
{
    return relay_current_origin() . relay_public_base_path() . '/bridge/v2';
}
