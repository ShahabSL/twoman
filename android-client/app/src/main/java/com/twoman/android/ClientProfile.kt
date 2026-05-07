package com.twoman.android

import android.util.Base64
import org.json.JSONObject
import java.util.UUID

data class ClientProfile(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val brokerBaseUrl: String,
    val clientToken: String,
    val targetAgentPeerLabel: String = "",
    val verifyTls: Boolean = false,
    val http2Ctl: Boolean = true,
    val http2Data: Boolean = false,
    val shareLanSocks: Boolean = false,
    val httpPort: Int = 0,
    val socksPort: Int = 0,
    val httpTimeoutSeconds: Int = 30,
    val tlsHandshakeTimeoutSeconds: Int = 45,
    val flushDelaySeconds: Double = 0.01,
    val maxBatchBytes: Int = 0,
    val dataUploadMaxBatchBytes: Int = 0,
    val dataUploadFlushDelaySeconds: Double = 0.0,
    val vpnDnsProxyIp: String = DEFAULT_VPN_DNS_PROXY_IP,
    val vpnDnsServers: List<String> = listOf("1.1.1.1", "8.8.8.8"),
    val idleRepollCtlSeconds: Double = 0.05,
    val idleRepollDataSeconds: Double = 0.1,
    val traceEnabled: Boolean = false,
) {
    fun vpnResolverDnsServers(): List<String> {
        val legacyProxy = vpnDnsProxyIp.trim()
        val configured = vpnDnsServers
            .map { it.trim() }
            .filter { it.isNotEmpty() && it != legacyProxy }
        return configured.ifEmpty { DEFAULT_VPN_DNS_SERVERS }
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("brokerBaseUrl", brokerBaseUrl)
        put("clientToken", clientToken)
        put("targetAgentPeerLabel", targetAgentPeerLabel)
        put("verifyTls", verifyTls)
        put("http2Ctl", http2Ctl)
        put("http2Data", http2Data)
        put("shareLanSocks", shareLanSocks)
        put("httpPort", httpPort)
        put("socksPort", socksPort)
        put("httpTimeoutSeconds", httpTimeoutSeconds)
        put("tlsHandshakeTimeoutSeconds", tlsHandshakeTimeoutSeconds)
        put("flushDelaySeconds", flushDelaySeconds)
        put("maxBatchBytes", maxBatchBytes)
        put("dataUploadMaxBatchBytes", dataUploadMaxBatchBytes)
        put("dataUploadFlushDelaySeconds", dataUploadFlushDelaySeconds)
        put("vpnDnsProxyIp", vpnDnsProxyIp)
        put("vpnDnsServers", org.json.JSONArray(vpnDnsServers))
        put("idleRepollCtlSeconds", idleRepollCtlSeconds)
        put("idleRepollDataSeconds", idleRepollDataSeconds)
        put("traceEnabled", traceEnabled)
    }

    fun toRuntimeConfig(logPath: String, listenStatePath: String): JSONObject = JSONObject().apply {
        put("transport", "http")
        put("transport_profile", "auto")
        put("broker_base_url", brokerBaseUrl)
        put("client_token", clientToken)
        put("target_agent_peer_label", targetAgentPeerLabel)
        put("listen_host", "127.0.0.1")
        put("http_listen_hosts", org.json.JSONArray(listOf("127.0.0.1", "::1")))
        put(
            "socks_listen_hosts",
            org.json.JSONArray(
                if (shareLanSocks) listOf("0.0.0.0") else listOf("127.0.0.1", "::1")
            ),
        )
        put("http_listen_port", httpPort)
        put("socks_listen_port", socksPort)
        put("listen_state_path", listenStatePath)
        put("log_path", logPath)
        put("http_timeout_seconds", httpTimeoutSeconds)
        put("tls_handshake_timeout_seconds", tlsHandshakeTimeoutSeconds)
        put("flush_delay_seconds", flushDelaySeconds)
        if (maxBatchBytes > 0) {
            put("max_batch_bytes", maxBatchBytes)
        }
        put("verify_tls", verifyTls)
        put("streaming_up_lanes", org.json.JSONArray())
        put("vpn_dns_proxy_ip", vpnDnsProxyIp)
        put("vpn_dns_servers", org.json.JSONArray(vpnDnsServers))
        val dataUploadProfile = JSONObject().apply {
            if (dataUploadMaxBatchBytes > 0) {
                put("max_batch_bytes", dataUploadMaxBatchBytes)
            }
            if (dataUploadFlushDelaySeconds > 0.0) {
                put("flush_delay_seconds", dataUploadFlushDelaySeconds)
            }
        }
        if (dataUploadProfile.length() > 0) {
            put(
                "upload_profiles",
                JSONObject().apply {
                    put(
                        "data",
                        dataUploadProfile,
                    )
                },
            )
        }
        put(
            "up_workers",
            JSONObject().apply {
                put("data", 16)
            },
        )
        put(
            "adaptive_upload",
            JSONObject().apply {
                put("enabled", true)
                put("lanes", org.json.JSONArray(listOf("data")))
                put("min_workers", 2)
                put("initial_workers", 6)
                put("max_workers", 16)
                put("min_batch_bytes", 65536)
                put("max_batch_bytes", 524288)
                put("increase_after_successes", 2)
                put("decrease_after_errors", 1)
                put("backlog_threshold_frames", 32)
                put("decision_interval_seconds", 0.25)
            },
        )
        put(
            "idle_repoll_delay_seconds",
            JSONObject().apply {
                put("ctl", idleRepollCtlSeconds)
                put("data", idleRepollDataSeconds)
            },
        )
        put(
            "http2_enabled",
            JSONObject().apply {
                put("ctl", http2Ctl)
                put("data", http2Data)
            },
        )
    }

    fun toShareText(): String {
        val exportJson = JSONObject().apply {
            put("name", name)
            put("brokerBaseUrl", brokerBaseUrl)
            put("clientToken", clientToken)
            put("targetAgentPeerLabel", targetAgentPeerLabel)
            put("verifyTls", verifyTls)
            put("http2Ctl", http2Ctl)
            put("http2Data", http2Data)
            put("shareLanSocks", shareLanSocks)
            put("httpPort", httpPort)
            put("socksPort", socksPort)
            put("httpTimeoutSeconds", httpTimeoutSeconds)
            put("tlsHandshakeTimeoutSeconds", tlsHandshakeTimeoutSeconds)
            if (maxBatchBytes > 0) put("maxBatchBytes", maxBatchBytes)
            if (dataUploadMaxBatchBytes > 0) put("dataUploadMaxBatchBytes", dataUploadMaxBatchBytes)
            if (dataUploadFlushDelaySeconds > 0.0) {
                put("dataUploadFlushDelaySeconds", dataUploadFlushDelaySeconds)
            }
            put("vpnDnsProxyIp", vpnDnsProxyIp)
            put("vpnDnsServers", org.json.JSONArray(vpnDnsServers))
            put("idleRepollCtlSeconds", idleRepollCtlSeconds)
            put("idleRepollDataSeconds", idleRepollDataSeconds)
            put("traceEnabled", traceEnabled)
        }
        val encoded = Base64.encodeToString(
            exportJson.toString().toByteArray(Charsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
        return "$SHARE_PREFIX$encoded"
    }

    companion object {
        private const val SHARE_PREFIX = "twoman://profile?data="
        private const val DEFAULT_VPN_DNS_PROXY_IP = ""
        private val DEFAULT_VPN_DNS_SERVERS = listOf("1.1.1.1", "8.8.8.8")

        fun fromJson(json: JSONObject): ClientProfile = ClientProfile(
            id = json.optString("id").ifBlank { UUID.randomUUID().toString() },
            name = json.optString("name"),
            brokerBaseUrl = json.optString("brokerBaseUrl"),
            clientToken = json.optString("clientToken"),
            targetAgentPeerLabel = json.optString("targetAgentPeerLabel").ifBlank {
                json.optString("target_agent_peer_label")
            },
            verifyTls = json.optBoolean("verifyTls", false),
            http2Ctl = json.optBoolean("http2Ctl", true),
            http2Data = json.optBoolean("http2Data", false),
            shareLanSocks = json.optBoolean("shareLanSocks", false),
            httpPort = json.optInt("httpPort", 0),
            socksPort = json.optInt("socksPort", 0),
            httpTimeoutSeconds = json.optInt("httpTimeoutSeconds", 30),
            tlsHandshakeTimeoutSeconds = json.optInt("tlsHandshakeTimeoutSeconds", 45),
            flushDelaySeconds = json.optDouble("flushDelaySeconds", 0.01),
            maxBatchBytes = legacyAutoBatch(json.optInt("maxBatchBytes", 0)),
            dataUploadMaxBatchBytes = legacyAutoBatch(json.optInt("dataUploadMaxBatchBytes", 0)),
            dataUploadFlushDelaySeconds = json.optDouble("dataUploadFlushDelaySeconds", 0.0),
            vpnDnsProxyIp = json.optString("vpnDnsProxyIp").ifBlank { DEFAULT_VPN_DNS_PROXY_IP },
            vpnDnsServers = json.optJSONArray("vpnDnsServers")?.let { array ->
                buildList {
                    for (index in 0 until array.length()) {
                        val value = array.optString(index).trim()
                        if (value.isNotEmpty()) add(value)
                    }
                }.ifEmpty { DEFAULT_VPN_DNS_SERVERS }
            } ?: DEFAULT_VPN_DNS_SERVERS,
            idleRepollCtlSeconds = json.optDouble("idleRepollCtlSeconds", 0.05),
            idleRepollDataSeconds = json.optDouble("idleRepollDataSeconds", 0.1),
            traceEnabled = json.optBoolean("traceEnabled", false),
        )

        fun fromShareText(rawText: String): ClientProfile {
            val text = rawText.trim()
            val json = when {
                text.startsWith(SHARE_PREFIX) -> {
                    val encoded = text.removePrefix(SHARE_PREFIX)
                    val decoded = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                    JSONObject(String(decoded, Charsets.UTF_8))
                }
                text.matches(Regex("^[A-Za-z0-9_-]+$")) -> {
                    val decoded = Base64.decode(text, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                    JSONObject(String(decoded, Charsets.UTF_8))
                }
                text.startsWith("{") -> JSONObject(text)
                else -> error("Invalid import text")
            }
            return fromJson(json).copy(id = UUID.randomUUID().toString())
        }
    }
}

private fun legacyAutoBatch(value: Int): Int = if (value == 65536) 0 else value
