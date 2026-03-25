<?php

function relay_config()
{
    static $config = null;

    if ($config !== null) {
        return $config;
    }

    $configFile = __DIR__ . '/config.php';
    if (!file_exists($configFile)) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Missing host/app/config.php']);
        exit;
    }

    $config = require $configFile;
    $config += [
        'public_base_path' => '',
        'offload_relative_path' => 'offload',
        'offload_ttl_seconds' => 3600,
    ];

    if (empty($config['storage_path'])) {
        relay_fail(500, 'storage_path is required');
    }

    relay_ensure_dir($config['storage_path']);
    relay_ensure_dir(relay_path('sessions'));
    relay_ensure_dir(relay_path('jobs'));
    relay_ensure_dir(relay_path('jobs/pending'));
    relay_ensure_dir(relay_path('jobs/inflight'));
    relay_ensure_dir(relay_path('jobs/results'));
    relay_ensure_dir(relay_path('jobs/payloads'));
    relay_ensure_dir(relay_offload_dir());

    return $config;
}

function relay_path($suffix)
{
    $config = relay_config();
    return rtrim($config['storage_path'], '/') . '/' . ltrim($suffix, '/');
}

function relay_public_base_path()
{
    $config = relay_config();
    $basePath = trim((string) $config['public_base_path']);
    if ($basePath === '' || $basePath === '/') {
        return '';
    }

    return '/' . trim($basePath, '/');
}

function relay_current_origin()
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : '';
    if ($host === '') {
        relay_fail(500, 'Unable to determine current host');
    }

    return $scheme . '://' . $host;
}

function relay_fetch_url($jobId, $fetchToken)
{
    $query = http_build_query([
        'job_id' => $jobId,
        'token' => $fetchToken,
    ]);

    return relay_current_origin() . relay_public_base_path() . '/fetch.php?' . $query;
}

function relay_offload_dir()
{
    $config = relay_config();
    return dirname(__DIR__) . '/' . trim($config['offload_relative_path'], '/');
}

function relay_offload_web_path($fileName)
{
    return relay_public_base_path() . '/' . trim(relay_config()['offload_relative_path'], '/') . '/' . ltrim($fileName, '/');
}

function relay_ensure_dir($path)
{
    if (!is_dir($path) && !mkdir($path, 0775, true) && !is_dir($path)) {
        relay_fail(500, 'Unable to create directory: ' . $path);
    }
}

function relay_fail($status, $message)
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(['error' => $message]);
    exit;
}

function relay_json($status, $payload)
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function relay_request_body()
{
    $config = relay_config();
    $body = file_get_contents('php://input');
    if ($body === false) {
        relay_fail(400, 'Unable to read request body');
    }

    if (strlen($body) > (int) $config['max_request_body_bytes']) {
        relay_fail(413, 'Request body too large');
    }

    return $body;
}

function relay_header($name)
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$key])) {
        return $_SERVER[$key];
    }

    if ($name === 'Content-Type' && isset($_SERVER['CONTENT_TYPE'])) {
        return $_SERVER['CONTENT_TYPE'];
    }

    return '';
}

function relay_auth($tokenType)
{
    $config = relay_config();
    $token = trim(relay_header('X-Relay-Token'));
    if ($token === '') {
        relay_fail(401, 'Missing X-Relay-Token header');
    }

    $allowed = isset($config[$tokenType]) ? $config[$tokenType] : [];
    if (!in_array($token, $allowed, true)) {
        relay_fail(403, 'Invalid token');
    }

    return $token;
}

function relay_auth_reverse()
{
    $config = relay_config();
    $key = trim(relay_header('X-Relay-Key'));

    if ($key === '' && isset($_GET['key'])) {
        $key = trim((string) $_GET['key']);
    }

    if ($key === '') {
        relay_fail(401, 'Missing reverse access key');
    }

    if (!in_array($key, $config['reverse_keys'], true)) {
        relay_fail(403, 'Invalid reverse access key');
    }

    return $key;
}

function relay_random_id($bytes = 16)
{
    return bin2hex(random_bytes($bytes));
}

function relay_read_json_file($path, $default = null)
{
    if (!file_exists($path)) {
        return $default;
    }

    $content = file_get_contents($path);
    if ($content === false || $content === '') {
        return $default;
    }

    $data = json_decode($content, true);
    return is_array($data) ? $data : $default;
}

function relay_write_json_file($path, $data)
{
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        relay_fail(500, 'Unable to encode JSON data');
    }

    if (file_put_contents($path, $json, LOCK_EX) === false) {
        relay_fail(500, 'Unable to write file: ' . $path);
    }
}

function relay_session_dir($sessionId)
{
    return relay_path('sessions/' . $sessionId);
}

function relay_session_meta_path($sessionId)
{
    return relay_session_dir($sessionId) . '/meta.json';
}

function relay_load_session_meta($sessionId)
{
    $meta = relay_read_json_file(relay_session_meta_path($sessionId));
    if (!is_array($meta)) {
        relay_fail(404, 'Unknown session');
    }

    return $meta;
}

function relay_save_session_meta($sessionId, $meta)
{
    relay_write_json_file(relay_session_meta_path($sessionId), $meta);
}

function relay_create_session($sessionId, $targetHost, $targetPort, $clientToken)
{
    $dir = relay_session_dir($sessionId);
    relay_ensure_dir($dir);
    relay_ensure_dir($dir . '/c2a');
    relay_ensure_dir($dir . '/a2c');

    $meta = [
        'session_id' => $sessionId,
        'target_host' => $targetHost,
        'target_port' => $targetPort,
        'client_token' => $clientToken,
        'created_at' => time(),
        'updated_at' => time(),
        'client_closed' => false,
        'agent_closed' => false,
        'error' => '',
    ];

    relay_save_session_meta($sessionId, $meta);
}

function relay_chunk_dir($sessionId, $senderRole)
{
    if ($senderRole === 'client') {
        return relay_session_dir($sessionId) . '/c2a';
    }

    if ($senderRole === 'agent') {
        return relay_session_dir($sessionId) . '/a2c';
    }

    relay_fail(400, 'Invalid role');
}

function relay_peer_closed_key($receiverRole)
{
    if ($receiverRole === 'client') {
        return 'agent_closed';
    }

    if ($receiverRole === 'agent') {
        return 'client_closed';
    }

    relay_fail(400, 'Invalid role');
}

function relay_store_chunk($sessionId, $senderRole, $seq, $body)
{
    $seq = (int) $seq;
    if ($seq < 1) {
        relay_fail(400, 'seq must be >= 1');
    }

    $meta = relay_load_session_meta($sessionId);
    $meta['updated_at'] = time();
    relay_save_session_meta($sessionId, $meta);

    $path = relay_chunk_dir($sessionId, $senderRole) . '/' . sprintf('%012d.bin', $seq);
    if (file_put_contents($path, $body, LOCK_EX) === false) {
        relay_fail(500, 'Unable to store chunk');
    }
}

function relay_get_chunk($sessionId, $receiverRole, $nextSeq)
{
    $nextSeq = (int) $nextSeq;
    if ($nextSeq < 1) {
        relay_fail(400, 'next_seq must be >= 1');
    }

    $dir = $receiverRole === 'client' ? relay_session_dir($sessionId) . '/a2c' : relay_session_dir($sessionId) . '/c2a';
    $path = $dir . '/' . sprintf('%012d.bin', $nextSeq);
    if (!file_exists($path)) {
        return null;
    }

    $body = file_get_contents($path);
    if ($body === false) {
        relay_fail(500, 'Unable to read chunk');
    }

    return [
        'path' => $path,
        'body' => $body,
        'seq' => $nextSeq,
    ];
}

function relay_ack_chunk($sessionId, $receiverRole, $seq)
{
    $seq = (int) $seq;
    if ($seq < 1) {
        relay_fail(400, 'seq must be >= 1');
    }

    $dir = $receiverRole === 'client' ? relay_session_dir($sessionId) . '/a2c' : relay_session_dir($sessionId) . '/c2a';
    $path = $dir . '/' . sprintf('%012d.bin', $seq);
    if (file_exists($path)) {
        unlink($path);
    }
}

function relay_close_session($sessionId, $role, $errorMessage = '')
{
    $meta = relay_load_session_meta($sessionId);
    if ($role === 'client') {
        $meta['client_closed'] = true;
    } elseif ($role === 'agent') {
        $meta['agent_closed'] = true;
    } else {
        relay_fail(400, 'Invalid role');
    }

    if ($errorMessage !== '') {
        $meta['error'] = $errorMessage;
    }

    $meta['updated_at'] = time();
    relay_save_session_meta($sessionId, $meta);
}

function relay_queue_job($job)
{
    $jobId = $job['job_id'];
    $pendingPath = relay_path('jobs/pending/' . $jobId . '.json');
    relay_write_json_file($pendingPath, $job);
}

function relay_try_claim_job()
{
    $config = relay_config();
    $leaseSeconds = (int) $config['job_lease_seconds'];

    foreach (glob(relay_path('jobs/inflight/*.json')) as $stalePath) {
        $job = relay_read_json_file($stalePath, []);
        if (!isset($job['claimed_at'])) {
            continue;
        }

        if ((time() - (int) $job['claimed_at']) <= $leaseSeconds) {
            continue;
        }

        $job['claimed_at'] = null;
        $pendingPath = relay_path('jobs/pending/' . basename($stalePath));
        if (@rename($stalePath, $pendingPath)) {
            relay_write_json_file($pendingPath, $job);
        }
    }

    $pendingJobs = glob(relay_path('jobs/pending/*.json'));
    sort($pendingJobs, SORT_STRING);

    foreach ($pendingJobs as $pendingPath) {
        $job = relay_read_json_file($pendingPath, []);
        if (empty($job['job_id'])) {
            unlink($pendingPath);
            continue;
        }

        $job['claimed_at'] = time();
        $inflightPath = relay_path('jobs/inflight/' . basename($pendingPath));
        if (!@rename($pendingPath, $inflightPath)) {
            continue;
        }

        relay_write_json_file($inflightPath, $job);
        return $job;
    }

    return null;
}

function relay_result_meta_path($jobId)
{
    return relay_path('jobs/results/' . $jobId . '.json');
}

function relay_result_body_path($jobId)
{
    return relay_path('jobs/results/' . $jobId . '.body');
}

function relay_store_job_result($jobId, $resultMeta, $body)
{
    relay_write_json_file(relay_result_meta_path($jobId), $resultMeta);
    if (file_put_contents(relay_result_body_path($jobId), $body, LOCK_EX) === false) {
        relay_fail(500, 'Unable to store job result body');
    }

    $inflightPath = relay_path('jobs/inflight/' . $jobId . '.json');
    if (file_exists($inflightPath)) {
        unlink($inflightPath);
    }
}

function relay_emit_job_result($jobId, $resultMeta, $resultBody)
{
    $statusCode = isset($resultMeta['status_code']) ? (int) $resultMeta['status_code'] : 502;
    http_response_code($statusCode);

    if (!empty($resultMeta['headers']) && is_array($resultMeta['headers'])) {
        foreach ($resultMeta['headers'] as $name => $value) {
            $lowerName = strtolower($name);
            if (in_array($lowerName, ['content-length', 'transfer-encoding', 'connection'], true)) {
                continue;
            }
            header($name . ': ' . $value, false);
        }
    }

    if (!empty($resultMeta['error'])) {
        header('X-Relay-Error: ' . $resultMeta['error']);
    }

    if (!empty($resultMeta['offload_web_path']) && !empty($resultMeta['fetch_token'])) {
        header('X-Twoman-Offload: 1');
        header('X-Twoman-Fetch-Url: ' . relay_fetch_url($jobId, $resultMeta['fetch_token']));
        if (!empty($resultMeta['offload_length'])) {
            header('X-Twoman-Offload-Length: ' . (int) $resultMeta['offload_length']);
        }
        exit;
    }

    echo $resultBody;
    exit;
}

function relay_ack_job($jobId)
{
    $inflightPath = relay_path('jobs/inflight/' . $jobId . '.json');
    if (file_exists($inflightPath)) {
        unlink($inflightPath);
    }
}

function relay_wait_for_job_result($jobId, $waitMs)
{
    $config = relay_config();
    $deadline = microtime(true) + ($waitMs / 1000.0);

    while (microtime(true) < $deadline) {
        $metaPath = relay_result_meta_path($jobId);
        $bodyPath = relay_result_body_path($jobId);

        if (file_exists($metaPath) && file_exists($bodyPath)) {
            $meta = relay_read_json_file($metaPath, []);
            $body = file_get_contents($bodyPath);
            if ($body === false) {
                relay_fail(500, 'Unable to read response body');
            }

            return [$meta, $body];
        }

        usleep((int) $config['poll_sleep_us']);
    }

    return [null, null];
}

function relay_cleanup_expired_offloads()
{
    $config = relay_config();
    $ttlSeconds = (int) $config['offload_ttl_seconds'];
    if ($ttlSeconds < 1) {
        return;
    }

    foreach (glob(relay_result_meta_path('*')) as $metaPath) {
        $meta = relay_read_json_file($metaPath, []);
        if (empty($meta['offload_web_path'])) {
            continue;
        }

        $completedAt = isset($meta['completed_at']) ? (int) $meta['completed_at'] : 0;
        if ($completedAt > 0 && (time() - $completedAt) <= $ttlSeconds) {
            continue;
        }

        $offloadWebPath = (string) $meta['offload_web_path'];
        $fileName = basename($offloadWebPath);
        $offloadPath = relay_offload_dir() . '/' . $fileName;
        if (is_file($offloadPath)) {
            @unlink($offloadPath);
        }
    }
}

function relay_build_reverse_job($service, $targetPath)
{
    $jobId = relay_random_id();
    $body = relay_request_body();
    $headers = [];

    foreach ($_SERVER as $name => $value) {
        if (strpos($name, 'HTTP_') !== 0) {
            continue;
        }

        $headerName = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))));
        if (in_array(strtolower($headerName), ['x-relay-key', 'host', 'connection'], true)) {
            continue;
        }

        $headers[$headerName] = $value;
    }

    if (!empty($_SERVER['CONTENT_TYPE'])) {
        $headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    }

    if (!empty($_SERVER['HTTP_HOST'])) {
        $headers['X-Forwarded-Host'] = $_SERVER['HTTP_HOST'];
    }

    $job = [
        'job_id' => $jobId,
        'type' => 'reverse_http',
        'service' => $service,
        'method' => $_SERVER['REQUEST_METHOD'],
        'path' => $targetPath,
        'query_string' => isset($_SERVER['QUERY_STRING']) ? $_SERVER['QUERY_STRING'] : '',
        'headers' => $headers,
        'body_base64' => base64_encode($body),
        'created_at' => time(),
    ];

    return $job;
}

function relay_build_forward_job()
{
    $jobId = relay_random_id();
    $body = relay_request_body();
    $targetUrl = trim(relay_header('X-Relay-Url'));
    $targetMethod = trim(relay_header('X-Relay-Method'));

    if ($targetUrl === '') {
        relay_fail(400, 'Missing X-Relay-Url header');
    }

    if ($targetMethod === '') {
        relay_fail(400, 'Missing X-Relay-Method header');
    }

    $headers = [];
    foreach ($_SERVER as $name => $value) {
        if (strpos($name, 'HTTP_') !== 0) {
            continue;
        }

        $headerName = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))));
        $lowerName = strtolower($headerName);
        if (in_array($lowerName, [
            'x-relay-token',
            'x-relay-url',
            'x-relay-method',
            'host',
            'connection',
            'proxy-connection',
        ], true)) {
            continue;
        }
        $headers[$headerName] = $value;
    }

    if (!empty($_SERVER['CONTENT_TYPE'])) {
        $headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    }

    return [
        'job_id' => $jobId,
        'type' => 'forward_http',
        'url' => $targetUrl,
        'method' => $targetMethod,
        'headers' => $headers,
        'body_base64' => base64_encode($body),
        'created_at' => time(),
    ];
}

function relay_cleanup_session($sessionId)
{
    $meta = relay_load_session_meta($sessionId);
    if (!$meta['client_closed'] || !$meta['agent_closed']) {
        return;
    }

    $dirs = [
        relay_session_dir($sessionId) . '/c2a',
        relay_session_dir($sessionId) . '/a2c',
    ];

    foreach ($dirs as $dir) {
        foreach (glob($dir . '/*.bin') as $chunkPath) {
            unlink($chunkPath);
        }
    }
}
