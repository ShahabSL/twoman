package com.twoman.android

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.InetAddresses
import android.net.IpPrefix
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import engine.Engine
import engine.Key
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class TunnelVpnService : VpnService() {
    private val loggerTag = BuildConfig.RUNTIME_LOG_TAG
    private var vpnInterface: ParcelFileDescriptor? = null
    private var vpnInterfaceFd: Int? = null
    private lateinit var stateStore: RuntimeStateStore
    private var activeProfile: ClientProfile? = null
    @Volatile
    private var workerStarted = false
    @Volatile
    private var stopRequested = false
    private val stopOnce = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        stateStore = RuntimeStateStore(this)
        Log.i(loggerTag, "TunnelVpnService onCreate")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.i(loggerTag, "TunnelVpnService stop requested")
            thread(name = "vpn-runtime-stop", start = true) {
                stopTunnel("stop requested")
            }
            return START_NOT_STICKY
        }
        val profileJson = intent?.getStringExtra(EXTRA_PROFILE_JSON) ?: return START_NOT_STICKY
        val profile = ClientProfile.fromJson(JSONObject(profileJson))
        Log.i(loggerTag, "TunnelVpnService onStartCommand profile=${profile.name}")
        activeProfile = profile
        stopRequested = false
        stopOnce.set(false)
        NotificationHelper.ensureChannel(this)
        val notification = NotificationHelper.build(
            this,
            getString(R.string.runtime_vpn_title),
            getString(R.string.status_starting_message),
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NotificationHelper.VPN_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NotificationHelper.VPN_NOTIFICATION_ID, notification)
        }
        if (!workerStarted) {
            workerStarted = true
            thread(name = "vpn-runtime-start", start = true) {
                runCatching { startTunnel(profile) }
                    .onFailure { error ->
                        val listenState = currentListenState(profile)
                        stateStore.write(
                            RuntimeStatus(
                                running = false,
                                mode = "stopped",
                                profileId = profile.id,
                                profileName = profile.name,
                                brokerBaseUrl = profile.brokerBaseUrl,
                                httpPort = listenState?.httpPort ?: 0,
                                socksPort = listenState?.socksPort ?: 0,
                                logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                                message = error.message?.takeIf { it.isNotBlank() }
                                    ?: error.javaClass.simpleName,
                            ),
                        )
                        stopSelf()
                    }
            }
        }
        return START_NOT_STICKY
    }

    private fun startTunnel(profile: ClientProfile) {
        ProxyService.start(this, profile, ProxyService.MODE_VPN)
        val listenState = waitForListenState(profile)
        if (stopRequested) {
            stopTunnel("start cancelled")
            return
        }

        val configureIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = Builder()
            .setSession(BuildConfig.VPN_SESSION_NAME)
            .setMtu(1500)
            .addAddress("198.18.0.1", 30)
            .addRoute("0.0.0.0", 0)
            .setConfigureIntent(configureIntent)

        var dnsAdded = false
        profile.vpnResolverDnsServers().forEach { dnsServer ->
            runCatching {
                builder.addDnsServer(dnsServer)
                dnsAdded = true
            }.onFailure { error ->
                Log.w(loggerTag, "ignoring invalid VPN DNS server=$dnsServer", error)
            }
        }
        check(dnsAdded) { "no valid VPN DNS servers configured" }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Keep local-network access outside the VPN so same-Wi-Fi clients and wireless
            // debugging do not disappear as soon as the tunnel comes up.
            listOf(
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.0.0/16",
                "fc00::/7",
                "fe80::/10",
            ).forEach { cidr ->
                runCatching {
                    val (address, prefixLength) = cidr.split("/", limit = 2)
                    builder.excludeRoute(
                        IpPrefix(
                            InetAddresses.parseNumericAddress(address),
                            prefixLength.toInt(),
                        ),
                    )
                }
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            runCatching { builder.addDisallowedApplication(packageName) }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setBlocking(true)
        }

        vpnInterface = builder.establish() ?: error("failed to establish VPN interface")
        if (stopRequested) {
            stopTunnel("vpn established after stop")
            return
        }

        val interfaceFd = vpnInterface!!.detachFd()
        vpnInterfaceFd = interfaceFd
        vpnInterface = null

        val key = Key().apply {
            mark = 0
            mtu = 1500
            device = "fd://$interfaceFd"
            proxy = "socks5://127.0.0.1:${listenState.socksPort}"
            `interface` = ""
            logLevel = if (profile.traceEnabled) "debug" else "info"
            restAPI = ""
            tcpSendBufferSize = ""
            tcpReceiveBufferSize = ""
            tcpModerateReceiveBuffer = false
        }

        synchronized(ENGINE_LOCK) {
            runCatching { Engine.stop() }
            Engine.insert(key)
            Engine.start()
        }
        stateStore.write(
            RuntimeStatus(
                running = true,
                mode = ProxyService.MODE_VPN,
                profileId = profile.id,
                profileName = profile.name,
                brokerBaseUrl = profile.brokerBaseUrl,
                httpPort = listenState.httpPort,
                socksPort = listenState.socksPort,
                logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                message = "",
            ),
        )
    }

    private fun stopTunnel(reason: String) {
        if (!stopOnce.compareAndSet(false, true)) {
            Log.i(loggerTag, "TunnelVpnService stopTunnel ignored duplicate reason=$reason")
            return
        }
        stopRequested = true
        Log.i(loggerTag, "TunnelVpnService stopTunnel reason=$reason")
        val interfaceToClose = vpnInterface
        vpnInterface = null
        val interfaceFd = vpnInterfaceFd
        vpnInterfaceFd = null
        if (interfaceToClose != null) {
            Log.i(loggerTag, "TunnelVpnService closing pending vpn interface")
            runCatching { interfaceToClose.close() }.onFailure { Log.w(loggerTag, "vpnInterface close failed", it) }
        } else if (interfaceFd != null) {
            // The VPN tun fd ownership was detached and handed to the engine.
            Log.i(loggerTag, "TunnelVpnService stopping engine-owned vpn fd=$interfaceFd")
        }
        workerStarted = false
        synchronized(ENGINE_LOCK) {
            runCatching { Engine.stop() }.onFailure { Log.w(loggerTag, "Engine.stop failed", it) }
        }
        Log.i(loggerTag, "TunnelVpnService requesting proxy stop")
        ProxyService.stop(this)
        activeProfile?.let { profile ->
            val listenState = currentListenState(profile)
            stateStore.write(
                RuntimeStatus(
                    running = true,
                    mode = ProxyService.MODE_VPN,
                    profileId = profile.id,
                    profileName = profile.name,
                    brokerBaseUrl = profile.brokerBaseUrl,
                    httpPort = listenState?.httpPort ?: 0,
                    socksPort = listenState?.socksPort ?: 0,
                    logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                    message = getString(R.string.status_stopping_message),
                ),
            )
        }
        Log.i(loggerTag, "TunnelVpnService stopping foreground")
        stopForeground(STOP_FOREGROUND_REMOVE)
        Log.i(loggerTag, "TunnelVpnService stopSelf")
        stopSelf()
    }

    override fun onRevoke() {
        Log.i(loggerTag, "TunnelVpnService onRevoke")
        stopTunnel("system revoke")
        super.onRevoke()
    }

    private fun waitForListenState(profile: ClientProfile): RuntimeListenState {
        repeat(75) {
            val listenState = currentListenState(profile)
            if (listenState != null && listenState.socksPort > 0) {
                runCatching {
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress("127.0.0.1", listenState.socksPort), 250)
                    }
                }.onSuccess { return listenState }
            }
            Thread.sleep(200L)
        }
        error("local SOCKS proxy did not start")
    }

    private fun currentListenState(profile: ClientProfile): RuntimeListenState? =
        AppFiles.readRuntimeListenState(this, profile.id)

    override fun onDestroy() {
        Log.i(loggerTag, "TunnelVpnService onDestroy")
        if (!stopRequested) {
            stopTunnel("service destroy")
        } else {
            workerStarted = false
            runCatching { vpnInterface?.close() }
            vpnInterface = null
            vpnInterfaceFd = null
            stopForeground(STOP_FOREGROUND_REMOVE)
        }
        super.onDestroy()
    }

    companion object {
        private const val ACTION_START = "com.twoman.android.action.VPN_START"
        private const val ACTION_STOP = "com.twoman.android.action.VPN_STOP"
        private val ENGINE_LOCK = Any()
        const val EXTRA_PROFILE_JSON = "profile_json"

        fun start(context: Context, profile: ClientProfile) {
            context.startForegroundService(
                Intent(context, TunnelVpnService::class.java).apply {
                    action = ACTION_START
                    putExtra(EXTRA_PROFILE_JSON, profile.toJson().toString())
                },
            )
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, TunnelVpnService::class.java).apply {
                    action = ACTION_STOP
                },
            )
        }
    }
}
