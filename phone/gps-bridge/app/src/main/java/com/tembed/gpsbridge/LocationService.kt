package com.tembed.gpsbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Due fasi, in ordine:
 *
 * 1. Fused Location (Play Services / microG), se il device ne ha una
 *    implementazione valida — su GrapheneOS, questo significa microG con
 *    il suo versionCode finto per passare il check di disponibilita'.
 *    Da' fix indoor via WiFi/rete, non solo satellite.
 * 2. Fallback a LocationManager.GPS_PROVIDER puro (quello di M0), se Fused
 *    Location non e' disponibile. Solo outdoor, nessun aiuto di rete.
 *
 * Qualunque sia la fase attiva, il risultato finisce sempre in
 * `LocationService.lastFix` — M1 legge solo quello, non gli importa quale
 * delle due l'ha prodotto.
 */
class LocationService : Service() {

    enum class Mode { FUSED, GPS_ONLY }

    data class Fix(
        val lat: Double,
        val lon: Double,
        val accuracyMeters: Float,
        val timeMillis: Long,
        val source: Mode
    )

    companion object {
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "gps_bridge_channel"
        private const val NOTIFICATION_ID = 1
        private const val MIN_TIME_MS = 1000L
        private const val MIN_DISTANCE_M = 0f
        const val HTTP_PORT = 8080

        @Volatile
        var lastFix: Fix? = null
            private set

        @Volatile
        var onFix: ((Fix) -> Unit)? = null
    }

    private lateinit var locationManager: LocationManager
    private var fusedClient: FusedLocationProviderClient? = null
    private var activeMode: Mode = Mode.GPS_ONLY
    private val httpServer = HttpGpsServer(HTTP_PORT)

    private val gpsListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            onNewLocation(location, Mode.GPS_ONLY)
        }

        @Deprecated("Deprecated in API 29, ma ancora richiamato su alcuni OEM/versioni")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {
            Log.d(TAG, "provider abilitato: $provider")
        }
        override fun onProviderDisabled(provider: String) {
            Log.w(TAG, "provider disabilitato: $provider")
        }
    }

    private val fusedCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            onNewLocation(location, Mode.FUSED)
        }
    }

    private fun onNewLocation(location: Location, source: Mode) {
        val fix = Fix(
            lat = location.latitude,
            lon = location.longitude,
            accuracyMeters = location.accuracy,
            timeMillis = location.time,
            source = source
        )
        lastFix = fix
        Log.d(TAG, "fix [$source]: lat=${fix.lat} lon=${fix.lon} acc=${fix.accuracyMeters}m")
        updateNotification(fix)
        onFix?.invoke(fix)
    }

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        createNotificationChannel()
        httpServer.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val fusedAvailable = isFusedLocationAvailable()
        activeMode = if (fusedAvailable) Mode.FUSED else Mode.GPS_ONLY

        val startupText = if (fusedAvailable) {
            "Play Services/microG trovato: uso Fused Location (meglio anche indoor)."
        } else {
            "Play Services/microG non disponibile: uso GPS diretto (serve cielo libero)."
        }
        Log.i(TAG, startupText)

        startForeground(NOTIFICATION_ID, buildNotification(startupText, activeMode))

        val hasFinePermission = checkSelfPermission(
            android.Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasFinePermission) {
            Log.e(TAG, "ACCESS_FINE_LOCATION non concesso, stop del service")
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            if (activeMode == Mode.FUSED) {
                startFusedUpdates()
            } else {
                startGpsOnlyUpdates()
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException richiedendo gli update di posizione", e)
            stopSelf()
            return START_NOT_STICKY
        }

        // NON START_STICKY: un restart automatico di Android avverrebbe da
        // background, e da Android 12 un foreground service di tipo
        // 'location' non puo' avviarsi da background
        // (ForegroundServiceStartNotAllowedException) - loop di crash
        // altrimenti. L'utente riavvia col bottone, non il sistema.
        return START_NOT_STICKY
    }

    /**
     * `isGooglePlayServicesAvailable` e' il check ufficiale: ritorna SUCCESS
     * sia con Play Services vere sia con microG, che si spaccia per una
     * versione sempre aggiornata apposta per passare questo controllo.
     */
    private fun isFusedLocationAvailable(): Boolean {
        val result = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this)
        if (result != ConnectionResult.SUCCESS) {
            Log.i(TAG, "GoogleApiAvailability = $result (non SUCCESS), fallback a GPS puro")
        }
        return result == ConnectionResult.SUCCESS
    }

    private fun startFusedUpdates() {
        val client = LocationServices.getFusedLocationProviderClient(this)
        fusedClient = client
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, MIN_TIME_MS).build()
        client.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
            .addOnFailureListener { e ->
                // Senza questo, una richiesta rifiutata resta silenziosa:
                // 'in attesa del primo fix' per sempre, senza nessun errore
                // visibile da nessuna parte.
                Log.e(TAG, "requestLocationUpdates (Fused) rifiutata", e)
            }
    }

    private fun startGpsOnlyUpdates() {
        if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            Log.w(TAG, "GPS_PROVIDER non abilitato nelle impostazioni di sistema")
        }
        locationManager.requestLocationUpdates(
            LocationManager.GPS_PROVIDER,
            MIN_TIME_MS,
            MIN_DISTANCE_M,
            gpsListener,
            Looper.getMainLooper()
        )
    }

    override fun onDestroy() {
        httpServer.stop()
        fusedClient?.removeLocationUpdates(fusedCallback)
        locationManager.removeUpdates(gpsListener)
        lastFix = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "GPS Bridge",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String, mode: Mode): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val title = if (mode == Mode.FUSED) "GPS Bridge (Fused)" else "GPS Bridge (GPS diretto)"
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openAppIntent)
            .build()
    }

    private fun updateNotification(fix: Fix) {
        val text = "lat=%.5f lon=%.5f (+-%.0fm)".format(fix.lat, fix.lon, fix.accuracyMeters)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text, fix.source))
    }
}
