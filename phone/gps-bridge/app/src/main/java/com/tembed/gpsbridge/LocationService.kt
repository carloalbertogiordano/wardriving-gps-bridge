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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import java.util.Locale
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Two phases, in order:
 *
 * 1. Fused Location (Play Services / microG), if the device has a valid
 *    implementation. On GrapheneOS that means either microG with its fake
 *    versionCode (to pass the availability check) or the sandboxed Google
 *    Play, which GrapheneOS reroutes to the system GNSS anyway.
 * 2. Fallback to plain LocationManager.GPS_PROVIDER when Fused Location is
 *    not available. Outdoors only, no network assistance.
 *
 * Whichever phase is active, the result always ends up in
 * `LocationService.lastFix`: the HTTP server only reads that and does not
 * care which phase produced it.
 */
class LocationService : Service() {

    enum class Mode { FUSED, GPS_ONLY }

    data class Fix(
        val lat: Double,
        val lon: Double,
        val accuracyMeters: Float,
        val timeMillis: Long,
        val altitudeMeters: Double,
        val source: Mode
    )

    companion object {
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "gps_bridge_channel"
        private const val NOTIFICATION_ID = 1
        private const val MIN_TIME_MS = 1000L
        private const val MIN_DISTANCE_M = 0f
        const val HTTP_PORT = 8080

        // Seen on a real device: the fix stream stops completely after a
        // short burst (both with Fused and with plain GPS_PROVIDER) and
        // never resumes on its own - it stayed silent for 30+ minutes with
        // the service alive. The cause is unknown (GrapheneOS's sandboxed
        // provider, or indoor reception): the watchdog does not fix it, it
        // only forces a fresh registration when the stream stops.
        private const val WATCHDOG_INTERVAL_MS = 15_000L
        private const val STALE_THRESHOLD_MS = 30_000L

        @Volatile
        var lastFix: Fix? = null
            private set

        @Volatile
        var onFix: ((Fix) -> Unit)? = null

        // The UI reads this to show Start/Stop correctly when it is reopened
        // while the service is already running.
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    private lateinit var locationManager: LocationManager
    private var fusedClient: FusedLocationProviderClient? = null
    private var activeMode: Mode = Mode.GPS_ONLY
    private val httpServer = HttpGpsServer(HTTP_PORT)

    private val watchdogHandler = Handler(Looper.getMainLooper())
    private var serviceStartMillis = 0L
    private var wakeLock: PowerManager.WakeLock? = null

    private val watchdogRunnable = object : Runnable {
        override fun run() {
            val reference = lastFix?.timeMillis ?: serviceStartMillis
            val age = System.currentTimeMillis() - reference
            if (age > STALE_THRESHOLD_MS) {
                Log.w(TAG, "no fix for ${age}ms, re-registering updates ($activeMode)")
                reRegisterUpdates()
            }
            watchdogHandler.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    private fun reRegisterUpdates() {
        try {
            if (activeMode == Mode.FUSED) {
                fusedClient?.removeLocationUpdates(fusedCallback)
                startFusedUpdates()
            } else {
                locationManager.removeUpdates(gpsListener)
                startGpsOnlyUpdates()
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException while re-registering updates", e)
        }
    }

    private val gpsListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            onNewLocation(location, Mode.GPS_ONLY)
        }

        @Deprecated("Deprecated in API 29, but still called on some OEMs/versions")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {
            Log.d(TAG, "provider enabled: $provider")
        }
        override fun onProviderDisabled(provider: String) {
            Log.w(TAG, "provider disabled: $provider")
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
            altitudeMeters = if (location.hasAltitude()) location.altitude else 0.0,
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
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val fusedAvailable = isFusedLocationAvailable()
        activeMode = if (fusedAvailable) Mode.FUSED else Mode.GPS_ONLY

        val startupText = if (fusedAvailable) {
            "Play Services/microG found: using Fused Location (better indoors too)."
        } else {
            "Play Services/microG not available: using plain GPS (needs open sky)."
        }
        Log.i(TAG, startupText)

        startForeground(NOTIFICATION_ID, buildNotification(startupText, activeMode))

        val hasFinePermission = checkSelfPermission(
            android.Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasFinePermission) {
            Log.e(TAG, "ACCESS_FINE_LOCATION not granted, stopping the service")
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
            Log.e(TAG, "SecurityException while requesting location updates", e)
            stopSelf()
            return START_NOT_STICKY
        }

        // Without a wake lock the CPU suspends with the screen off: the
        // foreground service stays "alive" but neither the GNSS callbacks
        // nor the HTTP server (accept() on the socket) run until something
        // wakes the phone. Bruce sees a late or missing answer and the
        // next fix seems never to arrive.
        if (wakeLock?.isHeld != true) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gpsbridge:service")
                .apply { acquire() }
        }

        serviceStartMillis = System.currentTimeMillis()
        watchdogHandler.removeCallbacks(watchdogRunnable)
        watchdogHandler.postDelayed(watchdogRunnable, WATCHDOG_INTERVAL_MS)

        // NOT START_STICKY: an automatic restart by Android would happen
        // from the background, and since Android 12 a foreground service of
        // type 'location' cannot start from the background
        // (ForegroundServiceStartNotAllowedException) - a crash loop
        // otherwise. The user restarts with the button, not the system.
        return START_NOT_STICKY
    }

    /**
     * `isGooglePlayServicesAvailable` is the official check: it returns
     * SUCCESS with real Play Services and with microG, which poses as an
     * always up-to-date version precisely to pass this check.
     */
    private fun isFusedLocationAvailable(): Boolean {
        val result = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this)
        if (result != ConnectionResult.SUCCESS) {
            Log.i(TAG, "GoogleApiAvailability = $result (not SUCCESS), falling back to plain GPS")
        }
        return result == ConnectionResult.SUCCESS
    }

    private fun startFusedUpdates() {
        val client = LocationServices.getFusedLocationProviderClient(this)
        fusedClient = client
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, MIN_TIME_MS).build()
        client.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
            .addOnFailureListener { e ->
                // Without this a rejected request is silent: "waiting for the
                // first fix" forever, with no error visible anywhere.
                Log.e(TAG, "requestLocationUpdates (Fused) rejected", e)
            }
    }

    private fun startGpsOnlyUpdates() {
        if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            Log.w(TAG, "GPS_PROVIDER is not enabled in the system settings")
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
        isRunning = false
        watchdogHandler.removeCallbacks(watchdogRunnable)
        httpServer.stop()
        fusedClient?.removeLocationUpdates(fusedCallback)
        locationManager.removeUpdates(gpsListener)
        lastFix = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
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
        val title = if (mode == Mode.FUSED) "GPS Bridge (Fused)" else "GPS Bridge (plain GPS)"
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openAppIntent)
            .build()
    }

    private fun updateNotification(fix: Fix) {
        val text = String.format(
            Locale.US, "lat=%.5f lon=%.5f (+-%.0fm)", fix.lat, fix.lon, fix.accuracyMeters
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text, fix.source))
    }
}
