<?php

return [
    'storage_path' => __DIR__ . '/../storage',
    'public_base_path' => '/twoman',
    'offload_relative_path' => 'offload',
    'offload_ttl_seconds' => 3600,
    'client_tokens' => [
        'replace-with-client-token',
    ],
    'agent_tokens' => [
        'replace-with-agent-token',
    ],
    'reverse_keys' => [
        'replace-with-reverse-key',
    ],
    'max_request_body_bytes' => 8 * 1024 * 1024,
    'poll_wait_ms' => 20000,
    'reverse_wait_ms' => 45000,
    'poll_sleep_us' => 200000,
    'job_lease_seconds' => 30,
    'bridge_local_port' => 18093,
    'bridge_session_ttl_seconds' => 300,
    'bridge_max_agent_idle_seconds' => 90,
];
