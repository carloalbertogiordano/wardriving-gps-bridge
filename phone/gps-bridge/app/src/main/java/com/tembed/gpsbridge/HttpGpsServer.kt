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
 * Server HTTP minimale per Bruce: GET /gps -> testo "lat,lon,acc,ts" letto
 * da LocationService.lastFix. Protocollo deciso nel piano (PLAN.md):
 *
 * - niente JSON, testo semplice, meno parsing sui due lati
 * - risponde sempre dalla cache, mai una lettura GPS sincrona per richiesta
 * - 503 senza corpo se non c'e' ancora un fix (Bruce controlla res.ok)
 *
 * Solo java.net, nessuna libreria tipo NanoHTTPD: il protocollo e' cosi'
 * semplice che non vale la dipendenza.
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
                Log.i(TAG, "in ascolto su porta $port")
                while (!socket.isClosed) {
                    try {
                        handleClient(socket.accept())
                    } catch (e: Exception) {
                        if (!socket.isClosed) Log.w(TAG, "errore gestendo una connessione", e)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "impossibile aprire la porta $port", e)
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
            // Una riga per richiesta: in standby serve sapere se Bruce
            // arriva fino a qui (e con che eta' del fix) o se la rete
            // del telefono e' addormentata prima ancora del server.
            Log.i(TAG, "GET /gps da ${s.inetAddress?.hostAddress} fixAge=" +
                (fix?.let { System.currentTimeMillis() - it.timeMillis } ?: -1) + "ms")
            if (fix == null) {
                writeResponse(out, 503, "")
                return
            }

            // ageMillis calcolato qui, non su Bruce: l'orologio dell'ESP32
            // e' millis() da boot, quello del telefono e' epoch reale, i
            // due non sono confrontabili. Bruce legge solo ageMillis per
            // decidere se un fix e' troppo vecchio - mai fix.ts, che resta
            // solo un riferimento assoluto per il log.
            val ageMillis = System.currentTimeMillis() - fix.timeMillis

            // Locale.US esplicito, altrimenti "%.6f".format() usa il
            // locale di sistema del telefono: su locale italiana (o molte
            // altre) il separatore decimale diventa la virgola, che
            // spacca il nostro protocollo a virgole in pezzi in piu' -
            // trovato su device reale, risposta tipo "41,352781,14,..."
            // invece di "41.352781,...". Bruce la scartava come
            // malformata (5 campi attesi, ne arrivavano 7), e il fix
            // restava invisibile anche con un GPS funzionante.
            //
            // Niente '\n' finale: il corpo e' esattamente
            // "lat,lon,acc,ts,age_ms", split(",") lato Bruce senza whitespace.
            val body = String.format(
                Locale.US, "%.6f,%.6f,%.0f,%d,%d",
                fix.lat, fix.lon, fix.accuracyMeters, fix.timeMillis, ageMillis
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
