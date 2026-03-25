<?php

$candidatePaths = [
    __DIR__ . '/../app/bridge_runtime.php',
    __DIR__ . '/app/bridge_runtime.php',
];

foreach ($candidatePaths as $candidatePath) {
    if (file_exists($candidatePath)) {
        require_once $candidatePath;
        break;
    }
}

if (!function_exists('bridge_runtime_ensure')) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Missing bridge runtime bootstrap']);
    exit;
}

$action = isset($_GET['action']) ? (string) $_GET['action'] : '';

if ($action === 'health') {
    $token = trim(relay_header('X-Relay-Token'));
    $config = relay_config();
    if (!in_array($token, $config['client_tokens'], true) && !in_array($token, $config['agent_tokens'], true)) {
        relay_fail(403, 'Invalid token');
    }
    bridge_runtime_bootstrap_files();
    bridge_runtime_write_config();

    $body = bridge_runtime_http_get('/health', 5.0);
    $decoded = json_decode((string) $body, true);

    if (!is_array($decoded) || empty($decoded['ok'])) {
        bridge_runtime_start();
        $deadline = microtime(true) + 8.0;
        $decoded = null;
        while (microtime(true) < $deadline) {
            usleep(200000);
            $body = bridge_runtime_http_get('/health', 5.0);
            $decoded = json_decode((string) $body, true);
            if (is_array($decoded) && !empty($decoded['ok'])) {
                break;
            }
        }
        if (!is_array($decoded) || empty($decoded['ok'])) {
            relay_fail(502, 'Host bridge daemon did not start');
        }
    }

    relay_json(200, [
        'ok' => !empty($decoded['ok']),
        'bridge_base_url' => bridge_runtime_bridge_base_url(),
        'bridge_host' => bridge_runtime_local_host(),
        'bridge_port' => bridge_runtime_local_port(),
        'stats' => isset($decoded['stats']) && is_array($decoded['stats']) ? $decoded['stats'] : [],
    ]);
}

relay_fail(404, 'Unknown action');
