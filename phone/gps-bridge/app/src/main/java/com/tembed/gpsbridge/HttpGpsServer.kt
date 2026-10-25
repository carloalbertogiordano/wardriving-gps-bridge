package com.tembed.gpsbridge

import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * Minimal HTTP server for the T-Embed. Decisions are in PLAN.md:
 *
 * - POST /scan?run=ID&ago=MS: the T-Embed sends one Wi-Fi scan (JSON), the
 *   phone attaches the position, deduplicates and stores it. `ago` is how
 *   long before the request the scan happened, so a live scan and one that
 *   was queued during an outage are placed with the same rule. Answers
 *   "ok,added,improved,total", 503 with no body when there is no fix close
 *   enough to the scan time (the T-Embed shows "waiting for fix"), 400 for a
 *   malformed body.
 * - GET /gps: the last fix as plain text "lat,lon,acc,ts,age_ms,alt", kept
 *   for debugging with curl; the script no longer uses it.
 *
 * No JSON on the way out and no NanoHTTPD-style library: the answers are tiny
 * and java.net is enough.
 */
class HttpGpsServer(private val port: Int) {

    companion object {
        private const val TAG = "HttpGpsServer"
        private const val MAX_BODY_BYTES = 64 * 1024

        // A fix further than this from the scan time is not trusted.
        private const val MAX_FIX_GAP_MS = 20_000L
    }

    private class Request(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val body: ByteArray
    )

    @Volatile private var serverSocket: ServerSocket? = null
    private var thread: Thread? = null

    fun start() {
        if (thread != null) return
        thread = Thread {
            try {
                val socket = ServerSocket(port)
                serverSocket = socket
                Log.i(TAG, "listening on port $port")
                while (!socket.isClosed) {
                    try {
                        handleClient(socket.accept())
                    } catch (e: Exception) {
                        if (!socket.isClosed) Log.w(TAG, "error handling a connection", e)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "cannot open port $port", e)
            }
        }.also {
            it.isDaemon = true
            it.name = "HttpGpsServer"
            it.start()
        }
    }

    fun stop() {
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
        thread = null
    }

    private fun handleClient(client: Socket) {
        client.use { s ->
            s.soTimeout = 3000
            val request = readRequest(s.getInputStream()) ?: return
            val out = s.getOutputStream()
            Log.i(TAG, "${request.method} ${request.path} from ${s.inetAddress?.hostAddress}")

            when {
                request.method == "GET" && request.path == "/gps" -> serveGps(out)
                request.method == "POST" && request.path == "/scan" -> serveScan(out, request)
                else -> writeResponse(out, 404, "not found\n")
            }
        }
    }

    private fun serveGps(out: OutputStream) {
        val fix = LocationService.lastFix
        if (fix == null) {
            writeResponse(out, 503, "")
            return
        }

        // ageMillis is computed here, not on the T-Embed: its clock is
        // millis() since boot, the phone's is real epoch, the two are not
        // comparable.
        val ageMillis = System.currentTimeMillis() - fix.timeMillis

        // Explicit Locale.US, otherwise "%.6f".format() uses the phone's
        // system locale: on an Italian locale the decimal separator becomes
        // a comma, which breaks a comma-separated body into extra pieces.
        // No trailing '\n', so a split(",") meets no whitespace.
        val body = String.format(
            Locale.US, "%.6f,%.6f,%.0f,%d,%d,%.1f",
            fix.lat, fix.lon, fix.accuracyMeters, fix.timeMillis, ageMillis, fix.altitudeMeters
        )
        writeResponse(out, 200, body)
    }

    private fun serveScan(out: OutputStream, request: Request) {
        val store = LocationService.runStore
        if (store == null) {
            writeResponse(out, 503, "")
            return
        }
        val runId = request.query["run"]
        val ago = request.query["ago"]?.toLongOrNull() ?: 0L
        if (runId.isNullOrEmpty()) {
            writeResponse(out, 400, "missing run\n")
            return
        }

        val nets = try {
            parseScan(request.body)
        } catch (e: Exception) {
            Log.w(TAG, "malformed scan body", e)
            writeResponse(out, 400, "malformed body\n")
            return
        }

        // The fix at the moment the scan happened, not at the moment it was
        // delivered: that is what makes queued scans usable.
        val scanTime = System.currentTimeMillis() - ago.coerceAtLeast(0L)
        val fix = FixHistory.nearest(scanTime, MAX_FIX_GAP_MS)
        if (fix == null) {
            writeResponse(out, 503, "")
            return
        }

        val result = store.ingest(runId, nets, fix)
        writeResponse(out, 200, "ok,${result.added},${result.improved},${result.total}")
    }

    /** Body shape: {"n":[{"m":mac,"s":ssid,"a":auth,"c":channel,"r":rssi}, ...]} */
    private fun parseScan(body: ByteArray): List<ScannedNet> {
        val array = JSONObject(String(body, StandardCharsets.UTF_8)).getJSONArray("n")
        return (0 until array.length()).map { i ->
            val n = array.getJSONObject(i)
            ScannedNet(
                mac = n.getString("m"),
                ssid = n.optString("s", ""),
                auth = n.optString("a", "UNKNOWN"),
                channel = n.optInt("c", 0),
                rssi = n.optInt("r", -100)
            )
        }
    }

    private fun readRequest(input: InputStream): Request? {
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val target = parts[1]
        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "").split('&')
            .filter { it.contains('=') }
            .associate {
                URLDecoder.decode(it.substringBefore('='), "UTF-8") to
                    URLDecoder.decode(it.substringAfter('='), "UTF-8")
            }

        var contentLength = 0
        while (true) {
            val line = readLine(input) ?: return null
            if (line.isEmpty()) break
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                contentLength = line.substringAfter(':').trim().toIntOrNull() ?: 0
            }
        }
        if (contentLength !in 0..MAX_BODY_BYTES) return null

        val body = ByteArray(contentLength)
        var read = 0
        while (read < contentLength) {
            val n = input.read(body, read, contentLength - read)
            if (n < 0) return null
            read += n
        }
        return Request(parts[0], path, query, body)
    }

    // Reads up to '\n' byte by byte: a BufferedReader would also swallow the
    // start of the body, and the body length is counted in bytes, not chars.
    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("US-ASCII")
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
            if (buf.size() > 8192) return null
        }
        return buf.toString("US-ASCII")
    }

    private fun writeResponse(out: OutputStream, status: Int, body: String) {
        val statusText = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            404 -> "Not Found"
            else -> "Service Unavailable"
        }
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        val header = "HTTP/1.1 $status $statusText\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        out.write(header.toByteArray(StandardCharsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }
}
