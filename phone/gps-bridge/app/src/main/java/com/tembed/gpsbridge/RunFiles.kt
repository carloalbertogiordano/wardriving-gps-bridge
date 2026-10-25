package com.tembed.gpsbridge

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** What the list of saved runs shows about one file. */
data class RunSummary(val file: File, val networks: Int, val startMillis: Long?, val sizeBytes: Long)

/** One network of a saved run, ready to be plotted. */
data class MapPoint(
    val mac: String,
    val ssid: String,
    val auth: String,
    val channel: Int,
    val rssi: Int,
    val lat: Double,
    val lon: Double,
    val time: String
)

/** Reads the Wigle files written by [RunStore]. */
object RunFiles {

    fun dir(context: Context): File = File(context.filesDir, "runs")

    /** Saved runs, newest first. */
    fun list(context: Context): List<RunSummary> =
        (dir(context).listFiles { f -> f.extension == "csv" } ?: emptyArray())
            .sortedByDescending { it.name }
            .map { summary(it) }

    fun summary(file: File): RunSummary {
        // Two header lines, then one line per network.
        val lines = file.useLines { seq -> seq.count { it.isNotBlank() } }
        return RunSummary(file, (lines - 2).coerceAtLeast(0), startOf(file), file.length())
    }

    // The file name is the UTC time of the run's first fix: yyMMdd_HHmmss.
    private fun startOf(file: File): Long? = try {
        SimpleDateFormat("yyMMdd_HHmmss", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .parse(file.nameWithoutExtension)?.time
    } catch (e: Exception) {
        null
    }

    fun points(file: File): List<MapPoint> {
        val result = ArrayList<MapPoint>()
        file.useLines { lines ->
            for (line in lines.drop(2)) {
                val c = splitCsv(line)
                if (c.size < 10) continue
                val lat = c[7].toDoubleOrNull() ?: continue
                val lon = c[8].toDoubleOrNull() ?: continue
                result += MapPoint(
                    mac = c[0],
                    ssid = c[1],
                    auth = c[2].trim('[', ']'),
                    channel = c[4].toIntOrNull() ?: 0,
                    rssi = c[6].toIntOrNull() ?: 0,
                    lat = lat,
                    lon = lon,
                    time = c[3]
                )
            }
        }
        return result
    }

    /** The JSON array the map page takes. Built with org.json so every string is escaped. */
    fun pointsJson(points: List<MapPoint>): String {
        val array = JSONArray()
        for (p in points) {
            array.put(
                JSONObject()
                    .put("mac", p.mac).put("ssid", p.ssid).put("auth", p.auth)
                    .put("channel", p.channel).put("rssi", p.rssi)
                    .put("lat", p.lat).put("lon", p.lon).put("time", p.time)
            )
        }
        return array.toString()
    }

    /** Splits one CSV line, honoring double quotes and "" as an escaped quote. */
    internal fun splitCsv(line: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var inQuotes = false
        var i = 0
        while (i < line.length) {
            val ch = line[i]
            when {
                inQuotes && ch == '"' && i + 1 < line.length && line[i + 1] == '"' -> {
                    cur.append('"'); i++
                }
                ch == '"' -> inQuotes = !inQuotes
                ch == ',' && !inQuotes -> { out += cur.toString(); cur.setLength(0) }
                else -> cur.append(ch)
            }
            i++
        }
        out += cur.toString()
        return out
    }

    fun title(summary: RunSummary): String {
        val start = summary.startMillis ?: return summary.file.name
        return SimpleDateFormat("d MMM yyyy, HH:mm", Locale.getDefault()).format(Date(start))
    }
}
