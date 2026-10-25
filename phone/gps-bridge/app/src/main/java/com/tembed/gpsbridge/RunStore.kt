package com.tembed.gpsbridge

import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One Wi-Fi network as reported by a scan on the T-Embed. */
data class ScannedNet(
    val mac: String,
    val ssid: String,
    val auth: String,
    val channel: Int,
    val rssi: Int
)

/**
 * Collects the networks of each wardriving run and writes them as a Wigle
 * file (WigleWifi-1.6, the same format the stock Bruce module produces).
 *
 * Deduplication happens here, not on the ESP32: the phone has plenty of RAM
 * and can afford the smarter policy of keeping, for every MAC, the sighting
 * that places the access point best: the one with the lowest combined
 * uncertainty of GPS accuracy and signal-strength distance (see
 * [uncertaintyMeters]).
 *
 * A run is identified by an id the T-Embed picks at start. A new id starts a
 * new file, named after the time of the run's first fix.
 */
class RunStore(private val dir: File) {

    companion object {
        private const val TAG = "RunStore"
        private const val WRITE_INTERVAL_MS = 5_000L
        private const val HEADER =
            "WigleWifi-1.6,appRelease=wardriving-gps-bridge,model=T-Embed CC1101,release=1," +
                "device=ESP32-S3,display=,board=T-Embed,brand=LilyGo,star=Sol,body=4,subBody=1\n" +
                "MAC,SSID,AuthMode,FirstSeen,Channel,Frequency,RSSI,CurrentLatitude,CurrentLongitude," +
                "AltitudeMeters,AccuracyMeters,RCOIs,MfgrId,Type\n"
    }

    private class Sighting(val net: ScannedNet, val fix: LocationService.Fix)

    private class Run(val id: String, val file: File) {
        val sightings = LinkedHashMap<String, Sighting>()
        var dirty = false
        var lastWriteMillis = 0L
    }

    data class IngestResult(val added: Int, val improved: Int, val total: Int)

    private var current: Run? = null

    init {
        dir.mkdirs()
    }

    /** Networks in the run currently open, 0 if none. */
    @Synchronized
    fun currentTotal(): Int = current?.sightings?.size ?: 0

    @Synchronized
    fun ingest(runId: String, nets: List<ScannedNet>, fix: LocationService.Fix): IngestResult {
        val run = openRun(runId, fix)
        var added = 0
        var improved = 0
        for (scanned in nets) {
            // One canonical spelling, so the key and the written row agree
            // whatever case the sender used.
            val net = scanned.copy(mac = scanned.mac.uppercase(Locale.US))
            val known = run.sightings[net.mac]
            if (known == null) {
                run.sightings[net.mac] = Sighting(net, fix)
                added++
            } else if (uncertaintyMeters(net, fix) < uncertaintyMeters(known.net, known.fix)) {
                run.sightings[net.mac] = Sighting(net, fix)
                improved++
            }
        }
        if (added + improved > 0) {
            run.dirty = true
            writeIfDue(run, force = false)
        }
        return IngestResult(added, improved, run.sightings.size)
    }

    /** Writes pending changes now. Called when the service stops and on its periodic tick. */
    @Synchronized
    fun flush() {
        current?.let { writeIfDue(it, force = true) }
    }

    /** Writes pending changes if any are waiting, so the last scans of a run are never left in memory. */
    @Synchronized
    fun flushIfDirty() {
        current?.let { if (it.dirty) writeIfDue(it, force = true) }
    }

    /** Saved runs, newest first. */
    fun listRuns(): List<File> =
        dir.listFiles { f -> f.extension == "csv" }?.sortedByDescending { it.name } ?: emptyList()

    /**
     * How far from the access point the recorded position can be, in meters:
     * the GPS accuracy of the fix combined with the distance the signal
     * strength suggests between phone and access point. Lower is better, and
     * a sighting replaces the stored one only if it scores lower, so a closer
     * (stronger) sighting and a more precise fix both count - and neither
     * wins when it comes with a much worse value of the other.
     *
     * The distance is a rough log-distance path loss model (-40 dBm at 1 m,
     * exponent 3, typical for built-up areas). It is a heuristic to rank two
     * sightings of the same access point, not a range measurement.
     */
    private fun uncertaintyMeters(net: ScannedNet, fix: LocationService.Fix): Double {
        val distance = Math.pow(10.0, (-40.0 - net.rssi) / 30.0).coerceAtLeast(1.0)
        val accuracy = fix.accuracyMeters.toDouble().coerceAtLeast(1.0)
        return Math.hypot(accuracy, distance)
    }

    private fun openRun(runId: String, fix: LocationService.Fix): Run {
        current?.let { if (it.id == runId) return it }
        flush() // close the previous run before switching
        val name = fileStamp(fix.timeMillis) + ".csv"
        val run = Run(runId, File(dir, name))
        current = run
        Log.i(TAG, "new run $runId -> ${run.file.name}")
        return run
    }

    private fun writeIfDue(run: Run, force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - run.lastWriteMillis < WRITE_INTERVAL_MS) return
        try {
            // Write to a temp file and rename, so a crash mid-write cannot
            // leave a truncated run behind.
            val tmp = File(dir, run.file.name + ".tmp")
            tmp.bufferedWriter(Charsets.UTF_8).use { out ->
                out.write(HEADER)
                for (s in run.sightings.values) out.write(row(s))
            }
            if (!tmp.renameTo(run.file)) {
                run.file.delete()
                tmp.renameTo(run.file)
            }
            run.dirty = false
            run.lastWriteMillis = now
        } catch (e: Exception) {
            Log.e(TAG, "cannot write ${run.file.name}", e)
        }
    }

    private fun row(s: Sighting): String {
        val ch = s.net.channel
        val freq = if (ch == 14) 2484 else 2407 + ch * 5
        val ssid = "\"" + s.net.ssid.replace("\"", "\"\"") + "\""
        return String.format(
            Locale.US, "%s,%s,[%s],%s,%d,%d,%d,%.6f,%.6f,%.1f,%.0f,,,WIFI\n",
            s.net.mac, ssid, s.net.auth, wigleTime(s.fix.timeMillis), ch, freq, s.net.rssi,
            s.fix.lat, s.fix.lon, s.fix.altitudeMeters, s.fix.accuracyMeters
        )
    }

    private fun utc(pattern: String) =
        SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

    private fun fileStamp(millis: Long) = utc("yyMMdd_HHmmss").format(Date(millis))
    private fun wigleTime(millis: Long) = utc("yyyy-MM-dd HH:mm:ss").format(Date(millis))
}
