package com.twoman.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.color.MaterialColors
import com.twoman.android.databinding.ActivityMainBinding
import com.twoman.android.databinding.DialogProfileBinding
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private val loggerTag = "TwomanUi"
    private val modeSwitchTimeoutMs = 10_000L
    private val restartSettleMs = 1_500L
    private lateinit var binding: ActivityMainBinding
    private lateinit var profileStore: ProfileStore
    private lateinit var selectionStore: SelectionStore
    private lateinit var stateStore: RuntimeStateStore
    private lateinit var adapter: ProfileAdapter
    private val uiHandler = Handler(Looper.getMainLooper())
    private var pendingVpnProfile: ClientProfile? = null
    private var profiles: List<ClientProfile> = emptyList()

    companion object {
        private const val EXTRA_START_MODE = "twoman_start_mode"
    }

    private val statusTicker = object : Runnable {
        override fun run() {
            renderStatus()
            uiHandler.postDelayed(this, 1000)
        }
    }

    private val vpnPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val profile = pendingVpnProfile ?: return@registerForActivityResult
            pendingVpnProfile = null
            if (it.resultCode != Activity.RESULT_OK) {
                Toast.makeText(this, getString(R.string.vpn_permission_denied), Toast.LENGTH_SHORT).show()
                renderStatus()
                return@registerForActivityResult
            }
            switchToMode(profile, ProxyService.MODE_VPN)
        }

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyInsets()

        profileStore = ProfileStore(this)
        selectionStore = SelectionStore(this)
        stateStore = RuntimeStateStore(this)

        adapter = ProfileAdapter(
            onSelectMode = { profile, mode -> selectProfileMode(profile, mode) },
            onEdit = { showProfileDialog(it) },
            onShare = { shareProfile(it) },
            onDelete = { deleteProfile(it) },
        )
        binding.profileList.layoutManager = LinearLayoutManager(this)
        binding.profileList.adapter = adapter
        binding.addButton.setOnClickListener { showProfileDialog(null) }
        binding.logsButton.setOnClickListener { startActivity(Intent(this, LogActivity::class.java)) }
        binding.connectButton.setOnClickListener { onConnectClicked() }

        requestNotificationPermissionIfNeeded()
        reloadProfiles()
        handleIncomingIntent(intent)
        renderStatus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
        renderStatus()
    }

    override fun onStart() {
        super.onStart()
        uiHandler.post(statusTicker)
    }

    override fun onStop() {
        uiHandler.removeCallbacks(statusTicker)
        super.onStop()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun reloadProfiles() {
        profiles = profileStore.loadProfiles().sortedBy { it.name.lowercase() }
        val selection = ensureSelection(profiles)
        adapter.submit(profiles)
        adapter.setSelection(selection.profileId, selection.mode)
        adapter.setRuntimeStatus(resolveRuntimeStatus())
    }

    private fun renderStatus() {
        val status = resolveRuntimeStatus()
        val selection = ensureSelection(profiles)
        val selectedProfile = profiles.firstOrNull { it.id == selection.profileId }
        val starting = !status.running && status.message == getString(R.string.status_starting_message)
        val stopping = status.running && status.message == getString(R.string.status_stopping_message)
        val shareAddress = selectedProfile
            ?.takeIf { it.shareLanSocks && status.mode == ProxyService.MODE_PROXY && status.running }
            ?.let { LanShareInfo.displayAddress(it.socksPort) }
        val effectiveMode = if (status.running || starting) status.mode else selection.mode

        adapter.setSelection(selection.profileId, selection.mode)
        adapter.setRuntimeStatus(status)

        binding.selectedProfileText.text = selectedProfile?.name ?: getString(R.string.selection_none)
        binding.selectedModeText.text = when (effectiveMode) {
            ProxyService.MODE_VPN -> getString(R.string.selection_mode_vpn)
            else -> getString(R.string.selection_mode_proxy)
        }

        when {
            starting -> {
                binding.statusText.text = when (effectiveMode) {
                    ProxyService.MODE_VPN -> getString(R.string.status_vpn_starting)
                    else -> getString(R.string.status_proxy_starting)
                }
                binding.portsText.text = getString(R.string.status_starting_message)
                updateConnectionUi(
                    stateText = getString(R.string.status_starting_message),
                    iconTint = MaterialColors.getColor(binding.root, com.google.android.material.R.attr.colorPrimary),
                    buttonText = getString(R.string.action_starting),
                    buttonIcon = R.drawable.ic_connect,
                    buttonEnabled = false,
                    progressVisible = true,
                )
            }
            stopping -> {
                binding.statusText.text = getString(R.string.status_stopping_message)
                binding.portsText.text = getString(R.string.status_stopping_message)
                updateConnectionUi(
                    stateText = getString(R.string.status_stopping_message),
                    iconTint = getColor(R.color.twoman_warning),
                    buttonText = getString(R.string.action_stopping),
                    buttonIcon = R.drawable.ic_stop_square,
                    buttonEnabled = false,
                    progressVisible = true,
                )
            }
            status.running -> {
                binding.statusText.text = when (status.mode) {
                    ProxyService.MODE_VPN -> "${getString(R.string.status_vpn)}  ${status.profileName}"
                    else -> "${getString(R.string.status_proxy)}  ${status.profileName}"
                }
                binding.portsText.text = listOfNotNull(
                    "HTTP ${status.httpPort}   SOCKS ${status.socksPort}",
                    shareAddress?.let { "LAN $it" },
                ).joinToString("\n")
                updateConnectionUi(
                    stateText = when (status.mode) {
                        ProxyService.MODE_VPN -> getString(R.string.status_connected_vpn)
                        else -> getString(R.string.status_connected_proxy)
                    },
                    iconTint = getColor(R.color.twoman_success),
                    buttonText = getString(R.string.action_disconnect),
                    buttonIcon = R.drawable.ic_stop_square,
                    buttonEnabled = true,
                    progressVisible = false,
                )
            }
            else -> {
                binding.statusText.text = getString(R.string.status_stopped)
                binding.portsText.text = status.message.ifBlank { getString(R.string.status_idle_message) }
                updateConnectionUi(
                    stateText = if (status.message.isBlank()) getString(R.string.status_ready) else getString(R.string.status_error),
                    iconTint = if (status.message.isBlank()) getColor(R.color.twoman_muted) else getColor(R.color.twoman_warning),
                    buttonText = getString(R.string.action_connect),
                    buttonIcon = R.drawable.ic_connect,
                    buttonEnabled = selectedProfile != null,
                    progressVisible = false,
                )
            }
        }
    }

    private fun updateConnectionUi(
        stateText: String,
        iconTint: Int,
        buttonText: String,
        buttonIcon: Int,
        buttonEnabled: Boolean,
        progressVisible: Boolean,
    ) {
        binding.connectionStateText.text = stateText
        binding.connectionStateIcon.imageTintList = ColorStateList.valueOf(iconTint)
        binding.connectionProgress.visibility = if (progressVisible) View.VISIBLE else View.GONE
        binding.connectButton.text = buttonText
        binding.connectButton.setIconResource(buttonIcon)
        binding.connectButton.isEnabled = buttonEnabled
    }

    private fun resolveRuntimeStatus(): RuntimeStatus {
        val rawStatus = stateStore.read()
        val resolvedStatus = RuntimeHealth.resolve(this, rawStatus)
        if (resolvedStatus != rawStatus) {
            stateStore.write(resolvedStatus)
        }
        return resolvedStatus
    }

    private fun applyInsets() {
        val initialTop = binding.root.paddingTop
        val initialBottom = binding.root.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.updatePadding(
                top = initialTop + systemBars.top,
                bottom = initialBottom + systemBars.bottom,
            )
            insets
        }
        ViewCompat.requestApplyInsets(binding.root)
    }

    private fun onConnectClicked() {
        val status = resolveRuntimeStatus()
        if (status.running) {
            stopEverything()
            return
        }
        val selection = ensureSelection(profiles)
        val profile = profiles.firstOrNull { it.id == selection.profileId }
        if (profile == null) {
            Toast.makeText(this, getString(R.string.toast_select_profile), Toast.LENGTH_SHORT).show()
            return
        }
        when (selection.mode) {
            ProxyService.MODE_VPN -> startVpn(profile)
            else -> startProxy(profile)
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        val importText = extractImportText(intent) ?: return
        val imported = runCatching {
            ClientProfile.fromShareText(importText)
        }.getOrElse {
            Toast.makeText(this, getString(R.string.import_failed), Toast.LENGTH_SHORT).show()
            clearHandledIntent()
            return
        }
        val savedProfile = persistImportedProfile(imported)
        val requestedMode = requestedStartMode(intent)
        selectionStore.write(
            SelectionStore.Selection(
                profileId = savedProfile.id,
                mode = requestedMode ?: selectionStore.read().mode,
            ),
        )
        reloadProfiles()
        Toast.makeText(this, getString(R.string.import_applied), Toast.LENGTH_SHORT).show()
        clearHandledIntent()
        when (requestedMode) {
            ProxyService.MODE_VPN -> startVpn(savedProfile)
            ProxyService.MODE_PROXY -> startProxy(savedProfile)
        }
    }

    private fun extractImportText(intent: Intent?): String? {
        val action = intent?.action ?: return null
        return when (action) {
            Intent.ACTION_VIEW -> intent.dataString?.takeIf { it.startsWith("twoman://profile?data=") }
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.takeIf { it.isNotEmpty() }
            else -> null
        }
    }

    private fun requestedStartMode(intent: Intent?): String? {
        return when (intent?.getStringExtra(EXTRA_START_MODE)?.trim()?.lowercase()) {
            ProxyService.MODE_PROXY -> ProxyService.MODE_PROXY
            ProxyService.MODE_VPN -> ProxyService.MODE_VPN
            else -> null
        }
    }

    private fun persistImportedProfile(imported: ClientProfile): ClientProfile {
        val existing = profileStore.loadProfiles().firstOrNull {
            it.name == imported.name &&
                it.brokerBaseUrl == imported.brokerBaseUrl &&
                it.clientToken == imported.clientToken
        }
        val persisted = imported.copy(id = existing?.id ?: imported.id)
        val updated = profileStore.loadProfiles()
            .filterNot { it.id == persisted.id }
            .plus(persisted)
        profileStore.saveProfiles(updated)
        return persisted
    }

    private fun clearHandledIntent() {
        val clearedIntent = Intent(intent).apply {
            action = Intent.ACTION_MAIN
            data = null
            replaceExtras(Bundle())
        }
        setIntent(clearedIntent)
    }

    private fun startProxy(profile: ClientProfile) {
        Log.i(loggerTag, "startProxy profile=${profile.name} id=${profile.id}")
        selectionStore.write(SelectionStore.Selection(profile.id, ProxyService.MODE_PROXY))
        switchToMode(profile, ProxyService.MODE_PROXY)
    }

    private fun startVpn(profile: ClientProfile) {
        Log.i(loggerTag, "startVpn profile=${profile.name} id=${profile.id}")
        selectionStore.write(SelectionStore.Selection(profile.id, ProxyService.MODE_VPN))
        val intent = VpnService.prepare(this)
        if (intent != null) {
            pendingVpnProfile = profile
            vpnPermissionLauncher.launch(intent)
            return
        }
        switchToMode(profile, ProxyService.MODE_VPN)
    }

    private fun stopEverything() {
        Log.i(loggerTag, "stopEverything")
        val status = resolveRuntimeStatus()
        if (!status.running) {
            renderStatus()
            return
        }
        stateStore.write(status.copy(message = getString(R.string.status_stopping_message)))
        requestRuntimeStop(status)
        renderStatus()
    }

    private fun switchToMode(profile: ClientProfile, mode: String) {
        thread(name = "twoman-ui-switch", start = true) {
            val currentStatus = resolveRuntimeStatus()
            if (currentStatus.running) {
                runOnUiThread {
                    stateStore.write(currentStatus.copy(message = getString(R.string.status_stopping_message)))
                    renderStatus()
                }
                requestRuntimeStop(currentStatus)
                waitForRuntimeStopped(currentStatus)
            } else {
                settleAfterRecentStop()
            }
            runOnUiThread {
                markRuntimeStarting(profile, mode)
                if (mode == ProxyService.MODE_VPN) {
                    TunnelVpnService.start(this, profile)
                    Toast.makeText(this, getString(R.string.toast_vpn_starting), Toast.LENGTH_SHORT).show()
                } else {
                    ProxyService.start(this, profile, ProxyService.MODE_PROXY)
                    Toast.makeText(this, getString(R.string.toast_proxy_starting), Toast.LENGTH_SHORT).show()
                }
                renderStatus()
            }
        }
    }

    private fun waitForRuntimeStopped(status: RuntimeStatus) {
        val deadline = System.currentTimeMillis() + modeSwitchTimeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (isRuntimeFullyStopped(status)) {
                break
            }
            Thread.sleep(200)
        }
        settleAfterRecentStop()
    }

    private fun settleAfterRecentStop() {
        val state = stateStore.read()
        val ageMs = System.currentTimeMillis() - state.updatedAtEpochMs
        if (!state.running && ageMs < restartSettleMs) {
            Thread.sleep(restartSettleMs - ageMs)
        }
    }

    private fun requestRuntimeStop(status: RuntimeStatus) {
        val vpnServiceRunning = RuntimeHealth.isServiceRunning(this, TunnelVpnService::class.java.name)
        val proxyServiceRunning = RuntimeHealth.isServiceRunning(this, ProxyService::class.java.name)
        if (status.mode == ProxyService.MODE_VPN || vpnServiceRunning) {
            TunnelVpnService.stop(this)
        }
        if (status.mode == ProxyService.MODE_PROXY ||
            status.mode == ProxyService.MODE_VPN ||
            proxyServiceRunning
        ) {
            ProxyService.stop(this)
        }
    }

    private fun markRuntimeStarting(profile: ClientProfile, mode: String) {
        stateStore.write(
            RuntimeStatus(
                running = false,
                mode = mode,
                profileId = profile.id,
                profileName = profile.name,
                brokerBaseUrl = profile.brokerBaseUrl,
                httpPort = profile.httpPort,
                socksPort = profile.socksPort,
                logPath = AppFiles.runtimeLogFile(this, profile.id).absolutePath,
                message = getString(R.string.status_starting_message),
            ),
        )
    }

    private fun isRuntimeFullyStopped(status: RuntimeStatus): Boolean {
        if (RuntimeHealth.isServiceRunning(this, TunnelVpnService::class.java.name)) {
            return false
        }
        if (RuntimeHealth.isServiceRunning(this, ProxyService::class.java.name)) {
            return false
        }
        if (RuntimeHealth.isProcessRunning(this, "${packageName}:proxy")) {
            return false
        }
        return !isPortListening(status.socksPort) && !isPortListening(status.httpPort)
    }

    private fun isPortListening(port: Int): Boolean {
        if (port <= 0) {
            return false
        }
        return runCatching {
            Socket().use { socket ->
                socket.connect(InetSocketAddress("127.0.0.1", port), 250)
            }
        }.isSuccess
    }

    private fun ensureSelection(items: List<ClientProfile>): SelectionStore.Selection {
        val stored = selectionStore.read()
        val selectedProfile = items.firstOrNull { it.id == stored.profileId } ?: items.firstOrNull()
        val normalized = SelectionStore.Selection(
            profileId = selectedProfile?.id.orEmpty(),
            mode = when (stored.mode) {
                ProxyService.MODE_VPN -> ProxyService.MODE_VPN
                else -> ProxyService.MODE_PROXY
            },
        )
        if (normalized != stored) {
            selectionStore.write(normalized)
        }
        return normalized
    }

    private fun selectProfileMode(profile: ClientProfile, mode: String) {
        Log.i(loggerTag, "selectProfileMode profile=${profile.name} mode=$mode")
        selectionStore.write(SelectionStore.Selection(profile.id, mode))
        renderStatus()
    }

    private fun deleteProfile(profile: ClientProfile) {
        val updated = profileStore.loadProfiles().filterNot { it.id == profile.id }
        profileStore.saveProfiles(updated)
        if (selectionStore.read().profileId == profile.id) {
            val replacement = updated.firstOrNull()
            selectionStore.write(
                SelectionStore.Selection(
                    profileId = replacement?.id.orEmpty(),
                    mode = selectionStore.read().mode,
                ),
            )
        }
        reloadProfiles()
    }

    private fun showProfileDialog(existing: ClientProfile?) {
        Log.i(loggerTag, "showProfileDialog existing=${existing?.name ?: "new"}")
        val dialogBinding = DialogProfileBinding.inflate(layoutInflater)
        val profile = existing ?: ClientProfile(
            name = "",
            brokerBaseUrl = "",
            clientToken = "",
        )
        val importedProfileHolder = arrayOfNulls<ClientProfile>(1)
        importedProfileHolder[0] = existing

        dialogBinding.nameInput.setText(profile.name)
        dialogBinding.brokerInput.setText(profile.brokerBaseUrl)
        dialogBinding.tokenInput.setText(profile.clientToken)
        dialogBinding.targetAgentInput.setText(profile.targetAgentPeerLabel)
        dialogBinding.httpPortInput.setText(if (profile.httpPort == 0) "" else profile.httpPort.toString())
        dialogBinding.socksPortInput.setText(if (profile.socksPort == 0) "" else profile.socksPort.toString())
        dialogBinding.verifyTlsSwitch.isChecked = profile.verifyTls
        dialogBinding.http2CtlSwitch.isChecked = profile.http2Ctl
        dialogBinding.http2DataSwitch.isChecked = profile.http2Data
        dialogBinding.shareLanSwitch.isChecked = profile.shareLanSocks
        dialogBinding.importButton.setOnClickListener {
            importedProfileHolder[0] = applyImportedProfile(dialogBinding)
        }

        AlertDialog.Builder(this)
            .setView(dialogBinding.root)
            .setPositiveButton(R.string.action_save) { _, _ ->
                saveProfile(existing, importedProfileHolder[0], dialogBinding)
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun applyImportedProfile(dialogBinding: DialogProfileBinding): ClientProfile? {
        val imported = runCatching {
            ClientProfile.fromShareText(dialogBinding.importInput.text?.toString().orEmpty())
        }.getOrElse {
            Toast.makeText(this, getString(R.string.import_failed), Toast.LENGTH_SHORT).show()
            return null
        }
        dialogBinding.nameInput.setText(imported.name)
        dialogBinding.brokerInput.setText(imported.brokerBaseUrl)
        dialogBinding.tokenInput.setText(imported.clientToken)
        dialogBinding.targetAgentInput.setText(imported.targetAgentPeerLabel)
        dialogBinding.httpPortInput.setText(if (imported.httpPort == 0) "" else imported.httpPort.toString())
        dialogBinding.socksPortInput.setText(if (imported.socksPort == 0) "" else imported.socksPort.toString())
        dialogBinding.verifyTlsSwitch.isChecked = imported.verifyTls
        dialogBinding.http2CtlSwitch.isChecked = imported.http2Ctl
        dialogBinding.http2DataSwitch.isChecked = imported.http2Data
        dialogBinding.shareLanSwitch.isChecked = imported.shareLanSocks
        Toast.makeText(this, getString(R.string.import_applied), Toast.LENGTH_SHORT).show()
        return imported
    }

    private fun saveProfile(
        existing: ClientProfile?,
        importedProfile: ClientProfile?,
        dialogBinding: DialogProfileBinding,
    ) {
        val name = dialogBinding.nameInput.text.toString().trim()
        val broker = dialogBinding.brokerInput.text.toString().trim()
        val token = dialogBinding.tokenInput.text.toString().trim()
        val targetAgent = dialogBinding.targetAgentInput.text.toString().trim()
        val httpPort = dialogBinding.httpPortInput.text.toString().toIntOrNull() ?: 0
        val socksPort = dialogBinding.socksPortInput.text.toString().toIntOrNull() ?: 0
        if (name.isBlank() || broker.isBlank() || token.isBlank()) {
            Toast.makeText(this, getString(R.string.save_requires_fields), Toast.LENGTH_SHORT).show()
            return
        }
        val baseProfile = importedProfile ?: existing
        val profile = ClientProfile(
            id = existing?.id ?: java.util.UUID.randomUUID().toString(),
            name = name,
            brokerBaseUrl = broker,
            clientToken = token,
            targetAgentPeerLabel = targetAgent,
            verifyTls = dialogBinding.verifyTlsSwitch.isChecked,
            http2Ctl = dialogBinding.http2CtlSwitch.isChecked,
            http2Data = dialogBinding.http2DataSwitch.isChecked,
            shareLanSocks = dialogBinding.shareLanSwitch.isChecked,
            httpPort = httpPort,
            socksPort = socksPort,
            httpTimeoutSeconds = baseProfile?.httpTimeoutSeconds ?: 30,
            flushDelaySeconds = baseProfile?.flushDelaySeconds ?: 0.01,
            maxBatchBytes = baseProfile?.maxBatchBytes ?: 65536,
            dataUploadMaxBatchBytes = baseProfile?.dataUploadMaxBatchBytes ?: 65536,
            dataUploadFlushDelaySeconds = baseProfile?.dataUploadFlushDelaySeconds ?: 0.004,
            vpnDnsServers = baseProfile?.vpnDnsServers ?: listOf("1.1.1.1", "8.8.8.8"),
            idleRepollCtlSeconds = baseProfile?.idleRepollCtlSeconds ?: 0.05,
            idleRepollDataSeconds = baseProfile?.idleRepollDataSeconds ?: 0.1,
            traceEnabled = baseProfile?.traceEnabled ?: false,
        )
        val updated = profileStore.loadProfiles()
            .filterNot { it.id == profile.id }
            .plus(profile)
        profileStore.saveProfiles(updated)
        selectionStore.write(
            SelectionStore.Selection(
                profileId = profile.id,
                mode = selectionStore.read().mode,
            ),
        )
        reloadProfiles()
    }

    private fun shareProfile(profile: ClientProfile) {
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, profile.toShareText())
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.share_chooser_title)))
    }
}
