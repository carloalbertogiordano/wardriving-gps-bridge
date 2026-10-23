// wardrive.js - Bruce JS Interpreter
//
// M2 con setup semi-automatico: al primo avvio scansiona le reti, fai
// scegliere l'hotspot del telefono, chiede la password, si connette,
// deduce e verifica l'IP del telefono (e' sempre il gateway, visto che
// ci si connette solo al suo hotspot), salva tutto. Ai run successivi
// legge la config salvata e parte dritto.
//
// M3 aggiungera' wifi.scan() reale (quello wardriving) e storage.write()
// sopra a fetchGps(), che e' gia' scritta per quello - vedi ensureWifi().
//
// Protocollo verso il telefono (PLAN.md): GET /gps -> testo
// "lat,lon,acc,ts", niente JSON. 503 senza corpo = nessun fix ancora sul
// telefono, non e' un errore.

var wifi = require("wifi");
var dialog = require("dialog");
var storage = require("storage");

var CONFIG_PATH = "/wardrive_config.txt";
var PHONE_PORT = 8080;
var WIFI_CONNECT_TIMEOUT_S = 20;
var LOOP_DELAY_MS = 2000;

// ---- config: letta da file, oppure chiesta all'utente al primo avvio ----
var config = null; // { ssid, password, phoneIp }

function loadConfig() {
    try {
        var raw = storage.read(CONFIG_PATH);
        var lines = raw.split("\n");
        if (lines.length < 3) return null;
        return { ssid: lines[0], password: lines[1], phoneIp: lines[2] };
    } catch (e) {
        return null; // normale al primissimo avvio, nessun file ancora
    }
}

function saveConfig(cfg) {
    var data = cfg.ssid + "\n" + cfg.password + "\n" + cfg.phoneIp;
    storage.write(CONFIG_PATH, data, "write"); // "write": default e' append!
}

// L'ultimo ottetto a '.1' e' la convenzione quasi universale per il
// gateway su hotspot Android/router consumer. Si deduce dal nostro
// stesso IP (wifi.ipAddress()), non c'e' un gatewayIP() in Bruce.
function guessGatewayFromOwnIp(ip) {
    var parts = ip.split(".");
    if (parts.length !== 4) return null;
    return parts[0] + "." + parts[1] + "." + parts[2] + ".1";
}

// Prova a raggiungere /gps sull'IP dato. Ritorna true se il telefono
// risponde (anche 503 "nessun fix ancora" conta: significa che l'host e'
// quello giusto), false se la connessione fallisce del tutto.
// httpFetch lancia un'eccezione JS se non si connette per niente - non
// torna solo ok:false - quindi serve try/catch qui, sempre.
function canReachPhone(ip) {
    try {
        wifi.httpFetch("http://" + ip + ":" + PHONE_PORT + "/gps");
        return true;
    } catch (e) {
        return false;
    }
}

// Scansiona, fa scegliere l'SSID, chiede la password, si connette,
// deduce e verifica l'IP del telefono. Ritorna la config se tutto va
// bene, null se l'utente annulla o qualcosa fallisce (l'errore e' gia'
// mostrato a schermo da qui dentro).
function runSetupWizard() {
    dialog.info("Scansione reti WiFi...");
    var nets = wifi.scan();

    var seen = {};
    var ssidList = [];
    for (var i = 0; i < nets.length; i++) {
        var ssid = nets[i].SSID;
        if (ssid && !seen[ssid]) {
            seen[ssid] = true;
            ssidList.push(ssid);
        }
    }

    if (ssidList.length === 0) {
        dialog.error("Nessuna rete trovata. Hotspot del telefono attivo?");
        return null;
    }

    var chosenSsid = dialog.choice(ssidList);
    if (!chosenSsid) {
        return null; // annullato
    }

    var password = keyboard("Password WiFi", 63, "Password per " + chosenSsid, true);

    dialog.info("Connessione a " + chosenSsid + "...");
    var connected = wifi.connect(chosenSsid, WIFI_CONNECT_TIMEOUT_S, password);
    if (!connected) {
        dialog.error("Connessione a " + chosenSsid + " fallita.");
        return null;
    }

    var myIp = wifi.ipAddress();
    var guessedIp = guessGatewayFromOwnIp(myIp);
    if (!guessedIp) {
        dialog.error("IP locale inatteso: " + to_string(myIp));
        return null;
    }

    dialog.info("Cerco il server sul telefono (" + guessedIp + ")...");
    if (!canReachPhone(guessedIp)) {
        dialog.error(
            "Telefono non trovato su " + guessedIp +
            ". App GPS Bridge avviata sul telefono?"
        );
        return null;
    }

    dialog.success("Connesso. Telefono trovato su " + guessedIp + ".");

    var cfg = { ssid: chosenSsid, password: password, phoneIp: guessedIp };
    saveConfig(cfg);
    return cfg;
}

function ensureWifi() {
    if (wifi.connected()) {
        return true;
    }
    var ok = wifi.connect(config.ssid, WIFI_CONNECT_TIMEOUT_S, config.password);
    if (!ok) {
        println("Riconnessione a " + config.ssid + " fallita.");
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

    var url = "http://" + config.phoneIp + ":" + PHONE_PORT + "/gps";
    var res;
    try {
        res = wifi.httpFetch(url);
    } catch (e) {
        println("telefono non raggiungibile su " + config.phoneIp);
        return null;
    }

    if (res.status === 503) {
        return null; // nessun fix sul telefono ancora, non e' un errore
    }
    if (!res.ok) {
        println("httpFetch " + url + " -> status " + res.status);
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

// ---- avvio ----

config = loadConfig();
if (!config) {
    config = runSetupWizard();
}

if (!config) {
    println("Setup non completato, script interrotto.");
} else {
    println("wardrive.js - telefono su " + config.phoneIp + ":" + PHONE_PORT);
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
}
