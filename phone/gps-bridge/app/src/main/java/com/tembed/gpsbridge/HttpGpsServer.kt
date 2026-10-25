package com.tembed.gpsbridge

import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * Minimal HTTP server for Bruce: GET /gps -> plain text
 * "lat,lon,acc,ts,age_ms,alt" read from LocationService.lastFix. Protocol
 * decided in the plan (PLAN.md):
 *
 * - no JSON, plain text, less parsing on both ends
 * - always answers from the cache, never a synchronous GPS read per request
 * - 503 with no body when there is no fix yet (Bruce checks res.ok)
 *
 * Only java.net, no NanoHTTPD-style library: the protocol is so simple the
 * dependency is not worth it.
 */
class HttpGpsServer(private val port: Int) {

    companion object {
        private const val TAG = "HttpGpsServer"
    }

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
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII))
            val requestLine = reader.readLine() ?: return
            val path = requestLine.split(" ").getOrNull(1) ?: "/"
            val out: OutputStream = s.getOutputStream()

            if (path != "/gps") {
                writeResponse(out, 404, "not found\n")
                return
            }

            val fix = LocationService.lastFix
            // One line per request: in standby we need to know whether Bruce
            // gets this far (and with what fix age) or whether the phone's
            // network is asleep before it even reaches the server.
            Log.i(TAG, "GET /gps from ${s.inetAddress?.hostAddress} fixAge=" +
                (fix?.let { System.currentTimeMillis() - it.timeMillis } ?: -1) + "ms")
            if (fix == null) {
                writeResponse(out, 503, "")
                return
            }

            // ageMillis is computed here, not on Bruce: the ESP32 clock is
            // millis() since boot, the phone's is real epoch, the two are not
            // comparable. Bruce only reads ageMillis to decide whether a fix
            // is too old - never fix.ts, which stays an absolute reference
            // for the log.
            val ageMillis = System.currentTimeMillis() - fix.timeMillis

            // Explicit Locale.US, otherwise "%.6f".format() uses the phone's
            // system locale: on an Italian locale (or many others) the
            // decimal separator becomes a comma, which breaks our
            // comma-separated protocol into extra pieces - found on a real
            // device, answer like "41,352781,14,..." instead of
            // "41.352781,...". Bruce rejected it as malformed (5 fields
            // expected, 7 arrived) and the fix stayed invisible even with a
            // working GPS.
            //
            // No trailing '\n': the body is exactly
            // "lat,lon,acc,ts,age_ms,alt", so split(",") on the Bruce side
            // meets no whitespace.
            val body = String.format(
                Locale.US, "%.6f,%.6f,%.0f,%d,%d,%.1f",
                fix.lat, fix.lon, fix.accuracyMeters, fix.timeMillis, ageMillis, fix.altitudeMeters
            )
            writeResponse(out, 200, body)
        }
    }

    private fun writeResponse(out: OutputStream, status: Int, body: String) {
        val statusText = when (status) {
            200 -> "OK"
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
