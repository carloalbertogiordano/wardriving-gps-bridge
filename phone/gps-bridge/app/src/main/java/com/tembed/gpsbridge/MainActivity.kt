package com.tembed.gpsbridge

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Locale

/**
 * Setup checklist (location, notifications, battery optimization) plus the
 * Start/Stop button for LocationService. Each requirement shows its state and
 * a button to fix it, so a missing permission is visible instead of showing
 * up later as a silently dead GPS.
 */
class MainActivity : Activity() {

    private val permissionRequestCode = 100

    private lateinit var locationState: TextView
    private lateinit var locationButton: Button
    private lateinit var notificationsRow: View
    private lateinit var notificationsState: TextView
    private lateinit var notificationsButton: Button
    private lateinit var batteryState: TextView
    private lateinit var batteryButton: Button
    private lateinit var setupHint: TextView
    private lateinit var statusText: TextView
    private lateinit var toggleButton: Button
    private lateinit var serverInfoText: TextView

    // Set when the system will no longer show the permission dialog: the only
    // way left to grant it is the app's settings screen.
    private var locationNeedsSettings = false
    private var notificationsNeedsSettings = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        locationState = findViewById(R.id.locationState)
        locationButton = findViewById(R.id.locationButton)
        notificationsRow = findViewById(R.id.notificationsRow)
        notificationsState = findViewById(R.id.notificationsState)
        notificationsButton = findViewById(R.id.notificationsButton)
        batteryState = findViewById(R.id.batteryState)
        batteryButton = findViewById(R.id.batteryButton)
        setupHint = findViewById(R.id.setupHint)
        statusText = findViewById(R.id.statusText)
        toggleButton = findViewById(R.id.toggleButton)
        serverInfoText = findViewById(R.id.serverInfoText)

        locationButton.setOnClickListener {
            if (locationNeedsSettings) openAppSettings()
            else requestPermissions(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ),
                permissionRequestCode
            )
        }
        notificationsButton.setOnClickListener {
            if (notificationsNeedsSettings) openAppSettings()
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestPermissions(
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS), permissionRequestCode
                )
            }
        }
        batteryButton.setOnClickListener { requestBatteryExemption() }
        findViewById<Button>(R.id.runsButton).setOnClickListener {
            startActivity(Intent(this, RunsActivity::class.java))
        }

        toggleButton.setOnClickListener {
            if (!LocationService.isRunning) startLocationService() else stopLocationService()
        }

        LocationService.onFix = { fix ->
            runOnUiThread {
                val sourceLabel = if (fix.source == LocationService.Mode.FUSED) "Fused" else "Plain GPS"
                statusText.text = String.format(
                    Locale.US, "[$sourceLabel] lat=%.5f lon=%.5f (+-%.0fm)",
                    fix.lat, fix.lon, fix.accuracyMeters
                )
            }
        }
    }

    // The user may have changed a permission in the system settings while the
    // app was in the background, so the checklist is recomputed every time.
    override fun onResume() {
        super.onResume()
        refreshSetup()
    }

    override fun onDestroy() {
        LocationService.onFix = null
        super.onDestroy()
    }

    private fun hasLocationPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun needsNotificationPermission() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    private fun hasNotificationPermission() =
        !needsNotificationPermission() ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun isBatteryExempt() =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private fun refreshSetup() {
        val location = hasLocationPermission()
        val notifications = hasNotificationPermission()
        val battery = isBatteryExempt()

        locationState.text = (if (location) "✓ " else "✗ ") + "Precise location"
        locationButton.visibility = if (location) View.GONE else View.VISIBLE
        locationButton.text = if (locationNeedsSettings) "Settings" else "Grant"

        notificationsRow.visibility = if (needsNotificationPermission()) View.VISIBLE else View.GONE
        notificationsState.text = (if (notifications) "✓ " else "✗ ") + "Notifications"
        notificationsButton.visibility = if (notifications) View.GONE else View.VISIBLE
        notificationsButton.text = if (notificationsNeedsSettings) "Settings" else "Grant"

        batteryState.text = (if (battery) "✓ " else "✗ ") + "Unrestricted battery"
        batteryButton.visibility = if (battery) View.GONE else View.VISIBLE

        setupHint.text = when {
            !location -> "Location is required: without it there is no GPS to bridge."
            !battery -> "Without the battery exemption Android may pause the GPS or the server " +
                "when the screen turns off."
            !notifications -> "Without notifications the running service is easy to miss."
            else -> ""
        }

        toggleButton.isEnabled = location
        toggleButton.text = if (LocationService.isRunning) "Stop" else "Start"
        if (LocationService.isRunning) showServerInfo() else {
            statusText.text = "GPS: stopped"
            serverInfoText.text = ""
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != permissionRequestCode) return

        // A denied permission that no longer shows a rationale was refused for
        // good ("don't ask again"): the next click has to open the settings.
        if (permissions.contains(Manifest.permission.ACCESS_FINE_LOCATION) && !hasLocationPermission()) {
            locationNeedsSettings =
                !shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (needsNotificationPermission() &&
            permissions.contains(Manifest.permission.POST_NOTIFICATIONS) && !hasNotificationPermission()
        ) {
            notificationsNeedsSettings =
                !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        }
        refreshSetup()
    }

    private fun requestBatteryExemption() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (e: ActivityNotFoundException) {
            // Some builds do not offer the direct dialog: fall back to the list.
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun openAppSettings() {
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:$packageName"))
        )
    }

    private fun startLocationService() {
        startForegroundService(Intent(this, LocationService::class.java))
        statusText.text = "Waiting for the first fix..."
        toggleButton.text = "Stop"
        showServerInfo()
    }

    private fun stopLocationService() {
        stopService(Intent(this, LocationService::class.java))
        toggleButton.text = "Start"
        statusText.text = "GPS: stopped"
        serverInfoText.text = ""
    }

    private fun showServerInfo() {
        serverInfoText.text = "Server at:\n" + localIpAddresses()
            .joinToString("\n") { "http://$it:${LocationService.HTTP_PORT}/gps" }
    }

    /** All non-loopback IPv4 addresses: with the hotspot on there is usually just one. */
    private fun localIpAddresses(): List<String> = try {
        NetworkInterface.getNetworkInterfaces().asSequence()
            .flatMap { it.inetAddresses.asSequence() }
            .filter { !it.isLoopbackAddress && it is Inet4Address }
            .mapNotNull { it.hostAddress }
            .toList()
    } catch (e: Exception) {
        emptyList()
    }
}
