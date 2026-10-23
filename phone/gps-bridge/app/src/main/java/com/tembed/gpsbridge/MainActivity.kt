package com.tembed.gpsbridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView

/**
 * M0: bottone Start/Stop per LocationService. Nessuna persistenza dello
 * stato tra riavvii dell'Activity: e' solo per validare il GPS puro su
 * GrapheneOS, non ancora l'app finale (quella arriva in M4).
 */
class MainActivity : Activity() {

    private val requestCode = 100
    private var serviceRunning = false

    private lateinit var statusText: TextView
    private lateinit var toggleButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        toggleButton = findViewById(R.id.toggleButton)

        toggleButton.setOnClickListener {
            if (!serviceRunning) requestPermissionsAndStart() else stopService()
        }

        LocationService.onFix = { fix ->
            runOnUiThread {
                statusText.text = "lat=%.5f lon=%.5f (+-%.0fm)"
                    .format(fix.lat, fix.lon, fix.accuracyMeters)
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
            statusText.text = "Permesso posizione negato: niente da fare senza."
        }
    }

    private fun startLocationService() {
        startForegroundService(Intent(this, LocationService::class.java))
        serviceRunning = true
        toggleButton.text = "Ferma"
        statusText.text = "In attesa del primo fix..."
    }

    private fun stopService() {
        stopService(Intent(this, LocationService::class.java))
        serviceRunning = false
        toggleButton.text = "Avvia"
        statusText.text = "GPS: fermo"
    }
}
