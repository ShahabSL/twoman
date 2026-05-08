package com.twoman.android

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Process
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

class ProxyService : Service() {
    private val loggerTag = BuildConfig.RUNTIME_LOG_TAG
    // Give the helper enough time to unwind active transport reads and stream
    // resets on normal shutdown before falling back to a hard process kill.
    private val helperStopJoinTimeoutMs = 12_000L
    private var helperThread: Thread? = null
    private var listenWatcherThread: Thread? = null
    @Volatile
    private var helperProcess: java.lang.Process? = null
    private lateinit var stateStore: RuntimeStateStore
    @Volatile
    private var currentMode: String = MODE_PROXY
    @Volatile
    private var currentProfile: ClientProfile? = null
    @Volatile
    private var stopRequested = false

    override fun onCreate() {
        super.onCreate()
        stateStore = RuntimeStateStore(this)
        Log.i(loggerTag, "ProxyService onCreate")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.i(loggerTag, "ProxyService stop requested")
            requestStop()
            return START_NOT_STICKY
        }
        val profileJson = intent?.getStringExtra(EXTRA_PROFILE_JSON) ?: return START_NOT_STICKY
        val mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_PROXY
        val androidNetworkHandle = intent.getLongExtra(EXTRA_ANDROID_NETWORK_HANDLE, 0L)
        val profile = ClientProfile.fromJson(JSONObject(profileJson))
        Log.i(loggerTag, "ProxyService onStartCommand mode=$mode profile=${profile.name}")
        currentMode = mode
        currentProfile = profile
        stopRequested = false
        NotificationHelper.ensureChannel(this)
        val notification = NotificationHelper.build(
            this,
            getString(R.string.runtime_proxy_title),
            getString(R.string.status_starting_message),
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NotificationHelper.PROXY_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NotificationHelper.PROXY_NOTIFICATION_ID, notification)
        }
        if (helperThread == null) {
            helperThread = thread(name = "local-runtime-helper", start = true) {
                runHelper(profile, mode, androidNetworkHandle)
            }
            listenWatcherThread = thread(name = "local-runtime-listen-watch", start = true) {
                waitForListenState(profile, mode)
            }
        }
        return START_NOT_STICKY
    }

    private fun runHelper(profile: ClientProfile, mode: String, androidNetworkHandle: Long) {
        val configFile = AppFiles.runtimeConfigFile(this, profile.id)
        val logFile = AppFiles.runtimeLogFile(this, profile.id)
        val listenStateFile = AppFiles.runtimeListenStateFile(this, profile.id)
        listenStateFile.delete()
        val runtimeConfig = profile.toRuntimeConfig(logFile.absolutePath, listenStateFile.absolutePath).apply {
            put("vpn_filter_aaaa", mode == MODE_VPN)
            if (mode == MODE_VPN) {
                put("vpn_dns_query_timeout_seconds", 15.0)
                put("vpn_dns_cache_ttl_seconds", 30.0)
                put("vpn_dns_max_inflight", 32)
                if (androidNetworkHandle != 0L) {
                    put("android_network_handle", java.lang.Long.toUnsignedString(androidNetworkHandle))
                }
            }
        }
        configFile.writeText(runtimeConfig.toString(2), Charsets.UTF_8)
        stateStore.write(
            RuntimeStatus(
                running = true,
                mode = mode,
                profileId = profile.id,
                profileName = profile.name,
                brokerBaseUrl = profile.brokerBaseUrl,
                httpPort = 0,
                socksPort = 0,
                logPath = logFile.absolutePath,
                message = getString(R.string.status_starting_message),
            ),
        )
        try {
            val helperBinary = File(applicationInfo.nativeLibraryDir, "libtwoman_helper.so")
            if (!helperBinary.canExecute()) {
                helperBinary.setExecutable(true, false)
            }
            val processBuilder = ProcessBuilder(
                helperBinary.absolutePath,
                "--config",
                configFile.absolutePath,
                "--mode",
                "helper",
            )
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile))
            processBuilder.environment()["TWOMAN_STDERR_ALREADY_LOGGED"] = "1"
            val process = processBuilder
                .start()
            helperProcess = process
            val exitCode = process.waitFor()
            if (!stopRequested && exitCode != 0) {
                error("Go helper exited with code $exitCode")
            }
        } catch (error: Throwable) {
            stateStore.write(
                RuntimeStatus(
                    running = false,
                    mode = "stopped",
                    profileId = profile.id,
                    profileName = profile.name,
                    brokerBaseUrl = profile.brokerBaseUrl,
                    httpPort = currentListenState(profile)?.httpPort ?: 0,
                    socksPort = currentListenState(profile)?.socksPort ?: 0,
                    logPath = logFile.absolutePath,
                    message = error.message ?: error.javaClass.simpleName,
                ),
            )
        } finally {
            helperProcess = null
            helperThread = null
            listenWatcherThread = null
            stopSelf()
        }
    }

    private fun waitForListenState(profile: ClientProfile, mode: String) {
        repeat(75) {
            if (stopRequested || helperThread == null) {
                return
            }
            val listenState = currentListenState(profile)
            if (listenState != null && listenState.httpPort > 0 && listenState.socksPort > 0) {
                stateStore.write(
                    RuntimeStatus(
                        running = true,
                        mode = mode,
                        profileId = profile.id,
                        profileName = profile.name,
                        brokerBaseUrl = profile.brokerBaseUrl,
                        httpPort = listenState.httpPort,
                        socksPort = listenState.socksPort,
                        logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                        message = "",
                    ),
                )
                return
            }
            Thread.sleep(200L)
        }
    }

    private fun currentListenState(profile: ClientProfile): RuntimeListenState? =
        AppFiles.readRuntimeListenState(this, profile.id)

    private fun requestStop() {
        stopRequested = true
        stopForeground(STOP_FOREGROUND_REMOVE)
        currentProfile?.let { profile ->
            val listenState = currentListenState(profile)
            stateStore.write(
                RuntimeStatus(
                    running = true,
                    mode = currentMode,
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
        val threadToJoin = helperThread
        val watcherToJoin = listenWatcherThread
        thread(name = "local-runtime-stop", start = true) {
            val process = helperProcess
            process?.destroy()
            Log.i(loggerTag, "ProxyService stop helper signalled=${process != null}")
            if (threadToJoin != null) {
                runCatching { threadToJoin.join(helperStopJoinTimeoutMs) }
            }
            if (threadToJoin?.isAlive == true) {
                process?.destroyForcibly()
                runCatching { threadToJoin.join(2_000L) }
            }
            if (watcherToJoin != null) {
                runCatching { watcherToJoin.join(helperStopJoinTimeoutMs) }
            }
            val helperStillRunning = (threadToJoin?.isAlive == true) || (helperThread?.isAlive == true)
            val watcherStillRunning = (watcherToJoin?.isAlive == true) || (listenWatcherThread?.isAlive == true)
            if (helperStillRunning || watcherStillRunning) {
                Log.w(loggerTag, "ProxyService helper thread still alive after stop timeout")
                currentProfile?.let { profile ->
                    stateStore.write(
                        RuntimeStatus(
                            running = false,
                            mode = "stopped",
                            profileId = profile.id,
                            profileName = profile.name,
                            brokerBaseUrl = profile.brokerBaseUrl,
                            httpPort = currentListenState(profile)?.httpPort ?: 0,
                            socksPort = currentListenState(profile)?.socksPort ?: 0,
                            logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                            message = "",
                        ),
                    )
                }
                stopSelf()
                terminateProxyProcess("helper thread stop timeout")
                return@thread
            }
            currentProfile?.let { profile ->
                stateStore.write(
                    RuntimeStatus(
                        running = false,
                        mode = "stopped",
                        profileId = profile.id,
                        profileName = profile.name,
                        brokerBaseUrl = profile.brokerBaseUrl,
                        httpPort = currentListenState(profile)?.httpPort ?: 0,
                        socksPort = currentListenState(profile)?.socksPort ?: 0,
                        logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                        message = "",
                    ),
                )
            }
            stopSelf()
            Log.i(loggerTag, "ProxyService helper stopped cleanly")
        }
    }

    private fun terminateProxyProcess(reason: String) {
        Log.i(loggerTag, "ProxyService terminating process reason=$reason")
        Process.killProcess(Process.myPid())
    }

    override fun onDestroy() {
        Log.i(loggerTag, "ProxyService onDestroy")
        if (!stopRequested && helperThread?.isAlive == true) {
            Log.w(loggerTag, "ProxyService destroyed with live helper; signalling stop")
            stopRequested = true
            helperProcess?.destroy()
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val ACTION_START = "com.twoman.android.action.PROXY_START"
        private const val ACTION_STOP = "com.twoman.android.action.PROXY_STOP"
        const val EXTRA_PROFILE_JSON = "profile_json"
        const val EXTRA_MODE = "mode"
        const val EXTRA_ANDROID_NETWORK_HANDLE = "android_network_handle"
        const val MODE_PROXY = "proxy"
        const val MODE_VPN = "vpn"

        fun start(context: Context, profile: ClientProfile, mode: String, androidNetworkHandle: Long = 0L) {
            context.startForegroundService(
                Intent(context, ProxyService::class.java).apply {
                    action = ACTION_START
                    putExtra(EXTRA_PROFILE_JSON, profile.toJson().toString())
                    putExtra(EXTRA_MODE, mode)
                    putExtra(EXTRA_ANDROID_NETWORK_HANDLE, androidNetworkHandle)
                },
            )
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, ProxyService::class.java).apply {
                    action = ACTION_STOP
                },
            )
        }
    }
}
