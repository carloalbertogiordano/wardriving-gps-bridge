package com.tembed.gpsbridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Locale

/**
 * Start/Stop button for LocationService. No state is kept across Activity
 * restarts: this is a bridge UI, not a full app.
 */
class MainActivity : Activity() {

    private val requestCode = 100
    private var serviceRunning = false

    private lateinit var statusText: TextView
    private lateinit var toggleButton: Button
    private lateinit var serverInfoText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        toggleButton = findViewById(R.id.toggleButton)
        serverInfoText = findViewById(R.id.serverInfoText)

        toggleButton.setOnClickListener {
            if (!serviceRunning) requestPermissionsAndStart() else stopService()
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

    override fun onDestroy() {
        LocationService.onFix = null
        super.onDestroy()
    }

    private fun requestPermissionsAndStart() {
        val needed = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed += Manifest.permission.ACCESS_FINE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }

        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), requestCode)
        } else {
            startLocationService()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != this.requestCode) return

        val fineLocationGranted = permissions.indexOf(Manifest.permission.ACCESS_FINE_LOCATION)
            .let { it == -1 || grantResults.getOrNull(it) == PackageManager.PERMISSION_GRANTED }

        if (fineLocationGranted) {
            startLocationService()
        } else {
            statusText.text = "Location permission denied: nothing to do without it."
        }
    }

    private fun startLocationService() {
        startForegroundService(Intent(this, LocationService::class.java))
        serviceRunning = true
        toggleButton.text = "Stop"
        statusText.text = "Waiting for the first fix..."
        serverInfoText.text = "Server at:\n" + localIpAddresses()
            .joinToString("\n") { "http://$it:${LocationService.HTTP_PORT}/gps" }
    }

    private fun stopService() {
        stopService(Intent(this, LocationService::class.java))
        serviceRunning = false
        toggleButton.text = "Start"
        statusText.text = "GPS: stopped"
        serverInfoText.text = ""
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
