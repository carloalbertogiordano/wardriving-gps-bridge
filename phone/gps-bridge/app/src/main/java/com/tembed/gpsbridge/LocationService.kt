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

/**
 * M0: tiene acceso il GPS (LocationManager.GPS_PROVIDER puro, niente
 * Play Services) e mantiene l'ultimo fix in una cache statica.
 *
 * In M1 un server HTTP leggerà `LocationService.lastFix` per rispondere
 * a Bruce senza fare mai una lettura GPS sincrona per richiesta.
 */
class LocationService : Service() {

    data class Fix(
        val lat: Double,
        val lon: Double,
        val accuracyMeters: Float,
        val timeMillis: Long
    )

    companion object {
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "gps_bridge_channel"
        private const val NOTIFICATION_ID = 1
        private const val MIN_TIME_MS = 1000L   // richiedi update al massimo ogni 1s
        private const val MIN_DISTANCE_M = 0f   // nessun filtro per distanza, vogliamo ogni fix

        /** Ultimo fix noto, aggiornato solo da questo service. Letto da M1. */
        @Volatile
        var lastFix: Fix? = null
            private set

        /** Callback opzionale per aggiornare la UI mentre l'Activity è in primo piano. */
        @Volatile
        var onFix: ((Fix) -> Unit)? = null
    }

    private lateinit var locationManager: LocationManager

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val fix = Fix(
                lat = location.latitude,
                lon = location.longitude,
                accuracyMeters = location.accuracy,
                timeMillis = location.time
            )
            lastFix = fix
            Log.d(TAG, "fix: lat=${fix.lat} lon=${fix.lon} acc=${fix.accuracyMeters}m")
            updateNotification(fix)
            onFix?.invoke(fix)
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

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification("In attesa del primo fix GPS...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val hasFinePermission = checkSelfPermission(
            android.Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasFinePermission) {
            Log.e(TAG, "ACCESS_FINE_LOCATION non concesso, stop del service")
            stopSelf()
            return START_NOT_STICKY
        }

        if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            Log.w(TAG, "GPS_PROVIDER non abilitato nelle impostazioni di sistema")
        }

        try {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                MIN_TIME_MS,
                MIN_DISTANCE_M,
                listener,
                Looper.getMainLooper()
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException richiedendo gli update GPS", e)
            stopSelf()
            return START_NOT_STICKY
        }

        return START_STICKY
    }

    override fun onDestroy() {
        locationManager.removeUpdates(listener)
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

    private fun buildNotification(text: String): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("GPS Bridge attivo")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openAppIntent)
            .build()
    }

    private fun updateNotification(fix: Fix) {
        val text = "lat=%.5f lon=%.5f (+-%.0fm)".format(fix.lat, fix.lon, fix.accuracyMeters)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }
}
