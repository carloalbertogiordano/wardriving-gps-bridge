// wardrive.js - Bruce JS Interpreter
//
// M2: connette al hotspot del telefono, chiede la posizione al server
// (phone/gps-bridge, M1) via wifi.httpFetch(), stampa a schermo.
// M3 aggiungera' wifi.scan() e storage.write() sopra a fetchGps(), che e'
// gia' scritta per quello (ensureWifi() prima di ogni fetch, perche' uno
// scan() droppa la STA per un istante - deciso in PLAN.md).
//
// Protocollo (PLAN.md): GET /gps -> testo "lat,lon,acc,ts", niente JSON.
// 503 senza corpo = nessun fix ancora sul telefono, non e' un errore.

// ---- Config: da scrivere a mano una volta (PLAN.md, deciso cosi') ----
var WIFI_SSID = "NOME_HOTSPOT_TELEFONO";
var WIFI_PASSWORD = "PASSWORD_HOTSPOT";
var PHONE_IP = "192.168.43.1";   // IP mostrato nell'app telefono dopo Avvia
var PHONE_PORT = 8080;
// ------------------------------------------------------------------------

var GPS_URL = "http://" + PHONE_IP + ":" + PHONE_PORT + "/gps";
var WIFI_CONNECT_TIMEOUT_S = 15;
var LOOP_DELAY_MS = 2000;

var wifi = require("wifi");

function ensureWifi() {
    if (wifi.connected()) {
        return true;
    }
    println("WiFi non connesso, provo " + WIFI_SSID + "...");
    var ok = wifi.connect(WIFI_SSID, WIFI_CONNECT_TIMEOUT_S, WIFI_PASSWORD);
    if (!ok) {
        println("Connessione a " + WIFI_SSID + " fallita.");
    }
    return ok;
}

// Ritorna {lat, lon, acc, ts} se c'e' un fix, null se non c'e' ancora
// (503, normale) o se qualcosa e' andato storto (loggato, non lanciato:
// un loop non deve fermarsi per un fetch mancato).
function fetchGps() {
    if (!ensureWifi()) {
        return null;
    }

    var res = wifi.httpFetch(GPS_URL);

    if (res.status === 503) {
        return null; // nessun fix sul telefono ancora, non e' un errore
    }
    if (!res.ok) {
        println("httpFetch " + GPS_URL + " -> status " + res.status);
        return null;
    }

    var parts = res.body.split(",");
    if (parts.length !== 4) {
        println("risposta malformata: " + res.body);
        return null;
    }

    return {
        lat: parse_int(parts[0]),
        lon: parse_int(parts[1]),
        acc: parse_int(parts[2]),
        ts: parse_int(parts[3])
    };
}

println("wardrive.js M2 - target " + GPS_URL);

while (true) {
    var fix = fetchGps();
    if (fix) {
        println("fix: " + to_string(fix.lat) + "," + to_string(fix.lon) +
            " (+-" + to_string(fix.acc) + "m)");
    } else {
        println("...nessun fix ancora...");
    }
    delay(LOOP_DELAY_MS);
}
