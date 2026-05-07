package com.twoman.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientProfileTest {
    @Test
    fun vpnDnsUsesRealResolversInsteadOfLegacyVirtualProxy() {
        val profile = ClientProfile(
            name = "test",
            brokerBaseUrl = "https://example.invalid/parvaneh",
            clientToken = "token",
            vpnDnsProxyIp = "198.18.0.2",
            vpnDnsServers = listOf("198.18.0.2", "1.1.1.1", "8.8.8.8"),
        )

        assertEquals(listOf("1.1.1.1", "8.8.8.8"), profile.vpnResolverDnsServers())
    }

    @Test
    fun runtimeConfigEnablesMobileSafeAdaptiveUpload() {
        val config = ClientProfile(
            name = "test",
            brokerBaseUrl = "https://example.invalid/parvaneh",
            clientToken = "token",
        ).toRuntimeConfig("/tmp/helper.log", "/tmp/listen-state.json")

        assertEquals(45, config.getInt("tls_handshake_timeout_seconds"))
        assertEquals(16, config.getJSONObject("up_workers").getInt("data"))
        assertTrue(config.getJSONObject("adaptive_upload").getBoolean("enabled"))
        assertEquals(6, config.getJSONObject("adaptive_upload").getInt("initial_workers"))
        assertEquals(16, config.getJSONObject("adaptive_upload").getInt("max_workers"))
    }

    @Test
    fun legacyFixedBatchShareValueFallsBackToBrokerProfile() {
        val profile = ClientProfile.fromJson(
            org.json.JSONObject()
                .put("name", "test")
                .put("brokerBaseUrl", "https://example.invalid/parvaneh")
                .put("clientToken", "token")
                .put("dataUploadMaxBatchBytes", 65536),
        )

        assertEquals(0, profile.dataUploadMaxBatchBytes)
        assertFalse(profile.toRuntimeConfig("/tmp/helper.log", "/tmp/listen-state.json").has("upload_profiles"))
    }
}
