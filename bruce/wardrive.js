// wardrive.js - Bruce JS Interpreter
//
// M2: setup semi-automatico al primo avvio (scansiona le reti, fai
// scegliere l'hotspot del telefono, chiede la password, si connette,
// deduce e verifica l'IP del telefono - e' sempre il gateway, visto che
// ci si connette solo al suo hotspot - salva tutto). Ai run successivi
// legge la config salvata e parte dritto.
//
// M3: wifi.scan() nel loop, ogni rete trovata va nel CSV insieme al fix
// GPS corrente.
//
// M4: fix mancante o scaduto non viene loggato (si salta il giro, non si
// inventano coordinate vecchie), piccolo stato a schermo (reti loggate
// in totale, eta' dell'ultimo fix).
//
// Protocollo verso il telefono (PLAN.md): GET /gps -> testo
// "lat,lon,acc,ts,age_ms", niente JSON. 503 senza corpo = nessun fix
// ancora sul telefono, non e' un errore. age_ms e' calcolato dal
// telefono stesso (System.currentTimeMillis() - orario del fix): Bruce
// non ha un orologio comparabile (millis() e' da boot, non epoch), quindi
// non puo' calcolare l'eta' da solo - deve leggerla gia' pronta.

var wifi = require("wifi");
var dialog = require("dialog");
var storage = require("storage");
var serial = require("serial");
var keyboard = require("keyboard");

var CONFIG_PATH = "/wardrive_config.txt";
var LOG_DIR = "/BruceWardriving"; // stessa cartella del wardriving nativo di Bruce
var MAX_TRACKED_MACS = 1500; // tetto della tabella di dedup, vedi sotto
var PHONE_PORT = 8080;
var WIFI_CONNECT_TIMEOUT_S = 20;
var LOOP_DELAY_MS = 2000;
var STALE_FIX_MS = 20000; // oltre questo, il fix e' troppo vecchio per fidarsene

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
// stesso IP (wifi.getIPAddress()), non c'e' un gatewayIP() in Bruce.
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

    // bare keyboard() non esiste in 1.16.1 (verificato su mqjs_stdlib.c
    // reale): e' dialog.prompt(title, maxSize, msg), stesso native_keyboard
    // dentro, solo niente 4o parametro mask - l'arity e' 3 non 4, ma il
    // motore passa comunque argc reale quindi il 4o true arriva lo stesso.
    var password = dialog.prompt("Password WiFi", 63, "Password per " + chosenSsid, true);

    dialog.info("Connessione a " + chosenSsid + "...");
    var connected = wifi.connect(chosenSsid, WIFI_CONNECT_TIMEOUT_S, password);
    if (!connected) {
        dialog.error("Connessione a " + chosenSsid + " fallita.");
        return null;
    }

    var myIp = wifi.getIPAddress();
    var guessedIp = guessGatewayFromOwnIp(myIp);

    // httpFetch non ha un timeout configurabile (verificato sul codice):
    // se l'IP e' sbagliato e non risponde affatto, la connessione resta
    // bloccata a lungo e puo' far scattare il watchdog dell'ESP32 (crash
    // senza nessun errore a schermo - visto su device reale: l'euristica
    // '.1' non vale per tutti gli hotspot, es. 10.48.104.130). Meglio far
    // confermare o correggere l'IP all'utente PRIMA di un test di rete
    // alla cieca, che indovinare e sperare.
    dialog.info(
        "IP ipotizzato: " + (guessedIp ? guessedIp : "nessuno") +
        ". Nella prossima schermata confermalo o correggilo " +
        "(guardalo sull'app del telefono se non sei sicuro).",
        true // aspetta la pressione, cosi' l'utente legge prima della tastiera
    );

    var typedIp = dialog.prompt(
        "IP del telefono",
        15,
        guessedIp ? ("Lascia vuoto per " + guessedIp) : "Es: 10.48.104.130"
    );
    var phoneIp = typedIp ? typedIp : guessedIp;

    if (!phoneIp || phoneIp.split(".").length !== 4) {
        dialog.error("IP non valido: " + to_string(phoneIp));
        return null;
    }

    dialog.info("Cerco il server sul telefono (" + phoneIp + ")...");
    if (!canReachPhone(phoneIp)) {
        dialog.error(
            "Telefono non trovato su " + phoneIp +
            ". App GPS Bridge avviata sul telefono? IP corretto?"
        );
        return null;
    }

    dialog.success("Connesso. Telefono trovato su " + phoneIp + ".");

    var cfg = { ssid: chosenSsid, password: password, phoneIp: phoneIp };
    saveConfig(cfg);
    return cfg;
}

function ensureWifi() {
    if (wifi.connected()) {
        return true;
    }
    var ok = wifi.connect(config.ssid, WIFI_CONNECT_TIMEOUT_S, config.password);
    if (!ok) {
        serial.println("Riconnessione a " + config.ssid + " fallita.");
    }
    return ok;
}

// Ritorna {lat, lon, acc, ts, ageMs} se c'e' un fix FRESCO, null se non
// c'e' ancora (503, normale), e' scaduto (M4: meglio niente riga che una
// riga con coordinate vecchie), o qualcosa e' andato storto (loggato, non
// lanciato: un loop non deve fermarsi per un fetch mancato).
function fetchGps() {
    if (!ensureWifi()) {
        return null;
    }

    var url = "http://" + config.phoneIp + ":" + PHONE_PORT + "/gps";
    var res;
    try {
        res = wifi.httpFetch(url);
    } catch (e) {
        serial.println("telefono non raggiungibile su " + config.phoneIp);
        return null;
    }

    if (res.status === 503) {
        return null; // nessun fix sul telefono ancora, non e' un errore
    }
    if (!res.ok) {
        serial.println("httpFetch " + url + " -> status " + res.status);
        return null;
    }

    var parts = res.body.split(",");
    if (parts.length !== 5) {
        serial.println("risposta malformata: " + res.body);
        return null;
    }

    var fix = {
        lat: parse_int(parts[0]),
        lon: parse_int(parts[1]),
        acc: parse_int(parts[2]),
        ts: parse_int(parts[3]),
        ageMs: parse_int(parts[4])
    };

    if (fix.ageMs > STALE_FIX_MS) {
        serial.println("fix vecchio di " + to_string(fix.ageMs) + "ms, salto il giro");
        return null;
    }

    return fix;
}

// Formato Wigle (WigleWifi-1.6), lo stesso del wardriving nativo di Bruce
// (src/modules/gps/wardriving.cpp): il file si carica cosi' com'e' su
// wigle.net. Un file nuovo per sessione, col nome dal timestamp del primo
// fix (yymmdd_hhmmss_wardriving.csv): niente file unico che cresce senza
// limite, e nessun bisogno di rileggere il passato per deduplicare.
var logPath = null; // creato al primo fix valido, serve l'orario per il nome

function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

// epoch ms -> { date: "YYYY-MM-DD HH:MM:SS", stamp: "yymmdd_hhmmss" } (UTC).
// Solo aritmetica (civil-from-days di Howard Hinnant): l'ESP32 non ha un
// orologio, l'unica ora affidabile e' quella del fix del telefono.
function utcParts(epochMs) {
    var secs = Math.floor(epochMs / 1000);
    var days = Math.floor(secs / 86400);
    var rem = secs - days * 86400;
    var z = days + 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y = y + 1;
    var hh = Math.floor(rem / 3600);
    var mi = Math.floor((rem - hh * 3600) / 60);
    var ss = rem - hh * 3600 - mi * 60;
    var time = pad2(hh) + ":" + pad2(mi) + ":" + pad2(ss);
    return {
        date: y + "-" + pad2(m) + "-" + pad2(d) + " " + time,
        stamp: pad2(y % 100) + pad2(m) + pad2(d) + "_" + pad2(hh) + pad2(mi) + pad2(ss)
    };
}

function openSessionLog(fix) {
    storage.mkdir({ fs: "sd", path: LOG_DIR });
    var when = utcParts(fix.ts);
    logPath = { fs: "sd", path: LOG_DIR + "/" + when.stamp + "_wardriving.csv" };
    storage.write(
        logPath,
        "WigleWifi-1.6,appRelease=wardriving-gps-bridge,model=T-Embed CC1101,release=1,device=ESP32-S3," +
        "display=,board=T-Embed,brand=LilyGo,star=Sol,body=4,subBody=1\n" +
        "MAC,SSID,AuthMode,FirstSeen,Channel,Frequency,RSSI,CurrentLatitude,CurrentLongitude," +
        "AltitudeMeters,AccuracyMeters,RCOIs,MfgrId,Type\n",
        "write"
    );
}

// SSID tra virgolette, con le virgolette interne raddoppiate (CSV standard):
// non serve scartare le virgole come nel vecchio formato.
function csvQuote(text) {
    return '"' + to_string(text).split('"').join('""') + '"';
}

// Dedup come in Bruce: set dei MAC visti in QUESTA sessione, svuotato del
// tutto quando arriva al tetto (heap limitato: meglio qualche doppione
// dopo lo svuotamento che esaurire la RAM). Chiave = MAC senza ':' (12
// caratteri invece di 17, meno RAM per chiave).
var seenMacs = {};
var seenCount = 0;

// Una riga per rete NUOVA (MAC non ancora visto in questa sessione), stesso
// fix per tutte. Ritorna quante righe ha scritto.
function logNetworks(nets, fix) {
    if (!logPath) openSessionLog(fix);

    var when = utcParts(fix.ts + fix.ageMs).date; // ora del telefono ~ adesso
    var lines = "";
    var newCount = 0;
    for (var i = 0; i < nets.length; i++) {
        var n = nets[i];
        var mac = to_string(n.MAC);
        var key = mac.split(":").join("");
        if (seenMacs[key]) continue;

        if (seenCount >= MAX_TRACKED_MACS) {
            seenMacs = {};
            seenCount = 0;
        }
        seenMacs[key] = true;
        seenCount++;
        newCount++;

        var ch = n.channel;
        lines += mac + "," +
            csvQuote(n.SSID) + ",[" + to_string(n.encryptionType) + "]," +
            when + "," +
            to_string(ch) + "," +
            to_string(ch === 14 ? 2484 : 2407 + ch * 5) + "," +
            to_string(n.RSSI) + "," +
            to_string(fix.lat) + "," + to_string(fix.lon) + ",0," +
            to_string(fix.acc) + ",,,WIFI\n";
    }
    if (lines.length > 0) {
        storage.write(logPath, lines, "append");
    }
    return newCount;
}

// ---- avvio ----

config = loadConfig();
if (!config) {
    config = runSetupWizard();
}

if (!config) {
    serial.println("Setup non completato, script interrotto.");
} else {
    serial.println("wardrive.js - telefono su " + config.phoneIp + ":" + PHONE_PORT);

    var totalLogged = 0;
    var stopRequested = false;

    // ESC non veniva mai controllato: lo script restava bloccato nel
    // loop per sempre, nessun modo di uscire se non spegnendo il
    // device. Il CSV e' gia' scritto riga per riga ad ogni giro
    // (storage.write "append" dentro logNetworks), quindi non serve
    // nessun salvataggio speciale all'uscita: i dati ci sono sempre,
    // basta interrompere il while in modo pulito.
    while (!stopRequested) {
        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }

        var fix = fetchGps();

        if (!fix) {
            dialog.info("In attesa di un fix GPS valido...");
            serial.println("...nessun fix valido, salto lo scan...");
        } else {
            // wifi.scan() puo' far cadere la STA per un istante (deciso
            // in PLAN.md): non serve gestirlo qui, il prossimo
            // fetchGps() la recupera da solo via ensureWifi().
            var nets = wifi.scan();
            var count = logNetworks(nets, fix);
            totalLogged += count;

            dialog.info(
                "Reti loggate: " + to_string(totalLogged) +
                " | ultimo fix " + to_string(fix.ageMs) + "ms fa"
            );
            serial.println(
                "loggate " + to_string(count) + " reti @ " +
                to_string(fix.lat) + "," + to_string(fix.lon)
            );
        }

        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }
        delay(LOOP_DELAY_MS);
    }

    if (stopRequested) {
        // wait=true: altrimenti il messaggio sparisce subito, sovrascritto
        // dal menu Scripts non appena lo script termina.
        dialog.success(
            "Wardriving fermato. " + to_string(totalLogged) +
            " reti salvate in " + (logPath ? logPath.path : "(nessun file, mai un fix)") + ".",
            true
        );
    }
}
