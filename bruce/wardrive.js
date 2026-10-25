// wardrive.js - Bruce JS Interpreter
//
// Wardriving with the phone's GPS: connects to the phone's hotspot, polls
// the GPS Bridge app for the current fix and logs every new Wi-Fi network
// found by wifi.scan() together with that fix.
//
// First run: guided setup (scan, pick the hotspot SSID, password, confirm
// the phone IP, verify the server answers) and the result is saved, so
// later runs start straight away.
//
// Phone protocol (PLAN.md): GET /gps -> plain text
// "lat,lon,acc,ts,age_ms,alt" (the trailing alt is optional, older app
// builds send five fields). 503 with no body = no fix on the phone yet,
// not an error. age_ms is computed by the phone itself
// (System.currentTimeMillis() - fix time): Bruce has no clock comparable
// to the phone's (millis() counts from boot, not epoch), so it must read
// the age ready-made and never subtract timestamps on its own.
//
// File layout - everything lives in a single folder, preferably on the SD
// card so LittleFS does not fill up with logs:
//
//   /BruceWardriving/PhoneGPS/config.txt                saved setup
//   /BruceWardriving/PhoneGPS/runs/<yymmdd_hhmmss>.csv  one Wigle file per run
//
// Each run gets its own file named after the time of its first valid fix.
// The format is the same WigleWifi-1.6 the stock Bruce wardriving module
// writes, so files upload to wigle.net as they are.

var wifi = require("wifi");
var dialog = require("dialog");
var storage = require("storage");
var serial = require("serial");
var keyboard = require("keyboard");

var BASE_DIR = "/BruceWardriving/PhoneGPS";
var RUNS_DIR = BASE_DIR + "/runs";
var CONFIG_FILE = BASE_DIR + "/config.txt";
var LEGACY_CONFIG_FILE = "/wardrive_config.txt"; // old LittleFS location
var MIN_LITTLEFS_FREE_KB = 100; // below this, refuse to log on LittleFS

var PHONE_PORT = 8080;
var WIFI_CONNECT_TIMEOUT_S = 20;
var LOOP_DELAY_MS = 2000;
var STALE_FIX_MS = 20000; // older than this, the fix is not trusted
var MAX_TRACKED_MACS = 1500; // cap of the dedup table, see below

// ---- storage: SD card first, LittleFS only as a fallback ----

var fsName = "littlefs"; // set by pickStorage()

function pickStorage() {
    try {
        if (storage.spaceSDCard().total > 0) return "sd";
    } catch (e) {
        // no card mounted
    }
    return "littlefs";
}

function pathOf(path) {
    return { fs: fsName, path: path };
}

// ---- config: read from file, or asked to the user on first run ----

var config = null; // { ssid, password, phoneIp }

function parseConfig(raw) {
    var lines = raw.split("\n");
    if (lines.length < 3) return null;
    return { ssid: lines[0], password: lines[1], phoneIp: lines[2] };
}

function saveConfig(cfg) {
    var data = cfg.ssid + "\n" + cfg.password + "\n" + cfg.phoneIp;
    storage.write(pathOf(CONFIG_FILE), data, "write"); // "write": the default is append!
}

function loadConfig() {
    try {
        return parseConfig(storage.read(pathOf(CONFIG_FILE)));
    } catch (e) {
        // normal on the very first run: no file yet
        // (catch variables must be unique per function on this engine)
    }

    // Migrate the config an older version left in the LittleFS root,
    // then delete it so nothing is left behind there.
    try {
        var cfg = parseConfig(storage.read(LEGACY_CONFIG_FILE));
        if (cfg) {
            saveConfig(cfg);
            storage.remove(LEGACY_CONFIG_FILE);
            serial.println("migrated config to " + CONFIG_FILE);
            return cfg;
        }
    } catch (e2) {
        // no legacy file either
    }
    return null;
}

// The last octet at '.1' is the usual gateway convention on consumer
// routers, but not on every Android hotspot (seen on a real device:
// phone on 10.48.104.130). It is only ever a suggestion the user
// confirms; Bruce has no gatewayIP().
function guessGatewayFromOwnIp(ip) {
    var parts = ip.split(".");
    if (parts.length !== 4) return null;
    return parts[0] + "." + parts[1] + "." + parts[2] + ".1";
}

// Try to reach /gps on the given IP. True if the phone answers (even a 503
// "no fix yet" counts: the host is the right one), false if the connection
// fails altogether. httpFetch throws a JS exception when it cannot connect
// at all, it does not just return ok:false, hence the try/catch.
function canReachPhone(ip) {
    try {
        wifi.httpFetch("http://" + ip + ":" + PHONE_PORT + "/gps");
        return true;
    } catch (e) {
        return false;
    }
}

// Scan, pick the SSID, ask the password, connect, confirm the phone IP and
// check the server. Returns the config on success, null if the user cancels
// or something fails (the error has already been shown on screen).
function runSetupWizard() {
    dialog.info("Scanning Wi-Fi networks...");
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
        dialog.error("No networks found. Is the phone hotspot on?");
        return null;
    }

    var chosenSsid = dialog.choice(ssidList);
    if (!chosenSsid) {
        return null; // cancelled
    }

    // Bare keyboard() does not exist in 1.16.1 (checked against the real
    // mqjs_stdlib.c): it is dialog.prompt(title, maxSize, msg, mask).
    var password = dialog.prompt("Wi-Fi password", 63, "Password for " + chosenSsid, true);

    dialog.info("Connecting to " + chosenSsid + "...");
    var connected = wifi.connect(chosenSsid, WIFI_CONNECT_TIMEOUT_S, password);
    if (!connected) {
        dialog.error("Connection to " + chosenSsid + " failed.");
        return null;
    }

    var myIp = wifi.getIPAddress();
    var guessedIp = guessGatewayFromOwnIp(myIp);

    // httpFetch has no configurable timeout: against an unreachable IP it
    // can block long enough to trip the ESP32 watchdog (silent crash, no
    // on-screen error, config never saved). So the user confirms or
    // corrects the IP BEFORE any blind network test.
    dialog.info(
        "Guessed IP: " + (guessedIp ? guessedIp : "none") +
        ". On the next screen confirm or correct it " +
        "(check the phone app if unsure).",
        true // wait for a key press so the user reads it before the keyboard
    );

    var typedIp = dialog.prompt(
        "Phone IP",
        15,
        guessedIp ? ("Leave empty for " + guessedIp) : "E.g. 10.48.104.130"
    );
    var phoneIp = typedIp ? typedIp : guessedIp;

    if (!phoneIp || phoneIp.split(".").length !== 4) {
        dialog.error("Invalid IP: " + to_string(phoneIp));
        return null;
    }

    dialog.info("Looking for the server on the phone (" + phoneIp + ")...");
    if (!canReachPhone(phoneIp)) {
        dialog.error(
            "Phone not found on " + phoneIp +
            ". Is the GPS Bridge app running? Is the IP correct?"
        );
        return null;
    }

    dialog.success("Connected. Phone found on " + phoneIp + ".");

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
        serial.println("Reconnecting to " + config.ssid + " failed.");
    }
    return ok;
}

// Returns {lat, lon, acc, ts, ageMs, alt} for a FRESH fix, null if there is
// none yet (503, normal), if it is stale (better no row than a row with old
// coordinates) or if something went wrong (logged, not thrown: a loop must
// not stop because one fetch failed).
function fetchGps() {
    if (!ensureWifi()) {
        return null;
    }

    var url = "http://" + config.phoneIp + ":" + PHONE_PORT + "/gps";
    var res;
    try {
        res = wifi.httpFetch(url);
    } catch (e) {
        serial.println("phone unreachable on " + config.phoneIp);
        return null;
    }

    if (res.status === 503) {
        return null; // no fix on the phone yet, not an error
    }
    if (!res.ok) {
        serial.println("httpFetch " + url + " -> status " + res.status);
        return null;
    }

    var parts = res.body.split(",");
    if (parts.length < 5) {
        serial.println("malformed response: " + res.body);
        return null;
    }

    var fix = {
        lat: parse_int(parts[0]),
        lon: parse_int(parts[1]),
        acc: parse_int(parts[2]),
        ts: parse_int(parts[3]),
        ageMs: parse_int(parts[4]),
        alt: parts.length > 5 ? parse_int(parts[5]) : 0
    };

    if (fix.ageMs > STALE_FIX_MS) {
        serial.println("fix is " + to_string(fix.ageMs) + "ms old, skipping this round");
        return null;
    }

    return fix;
}

// ---- run log (Wigle format) ----

var logPath = null; // created at the first valid fix: the file name needs its time

function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

// epoch ms -> { date: "YYYY-MM-DD HH:MM:SS", stamp: "yymmdd_hhmmss" } (UTC).
// Plain arithmetic (Howard Hinnant's civil-from-days): the ESP32 has no
// clock, the only reliable time is the phone's fix time.
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

function openRunLog(fix) {
    var when = utcParts(fix.ts);
    logPath = pathOf(RUNS_DIR + "/" + when.stamp + ".csv");
    // storage.write creates the missing parent folders (open with create=true)
    return storage.write(
        logPath,
        "WigleWifi-1.6,appRelease=wardriving-gps-bridge,model=T-Embed CC1101,release=1,device=ESP32-S3," +
        "display=,board=T-Embed,brand=LilyGo,star=Sol,body=4,subBody=1\n" +
        "MAC,SSID,AuthMode,FirstSeen,Channel,Frequency,RSSI,CurrentLatitude,CurrentLongitude," +
        "AltitudeMeters,AccuracyMeters,RCOIs,MfgrId,Type\n",
        "write"
    );
}

// SSID in double quotes, inner quotes doubled (standard CSV): commas in an
// SSID need no special handling. No replace()/regex on this engine, so
// split+join.
function csvQuote(text) {
    return '"' + to_string(text).split('"').join('""') + '"';
}

// Dedup like stock Bruce: a set of the MACs seen in THIS run, cleared
// entirely when it reaches the cap (limited heap: better a few duplicates
// after a clear than running out of RAM). The key is the MAC without ':'
// (12 chars instead of 17, less RAM per key). Not persisted across runs:
// every run has its own file, so there is nothing to re-read.
var seenMacs = {};
var seenCount = 0;

// One row per NEW network (MAC not seen yet in this run), same fix for all.
// Returns how many rows it wrote, or -1 if the file cannot be written.
function logNetworks(nets, fix) {
    if (!logPath && !openRunLog(fix)) {
        return -1;
    }

    var when = utcParts(fix.ts + fix.ageMs).date; // phone time ~ now
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
            to_string(fix.lat) + "," + to_string(fix.lon) + "," +
            to_string(fix.alt) + "," + to_string(fix.acc) + ",,,WIFI\n";
    }
    if (lines.length > 0 && !storage.write(logPath, lines, "append")) {
        return -1;
    }
    return newCount;
}

// ---- start ----

fsName = pickStorage();
if (fsName !== "sd") {
    dialog.info("No SD card found: using internal storage (LittleFS), space is limited.", true);
}

config = loadConfig();
if (!config) {
    config = runSetupWizard();
}

if (!config) {
    serial.println("Setup not completed, script stopped.");
} else {
    serial.println("wardrive.js - phone on " + config.phoneIp + ":" + PHONE_PORT + ", storage: " + fsName);

    var totalLogged = 0;
    var stopRequested = false;
    var failed = false;

    // The CSV is appended to on every round (storage.write "append" inside
    // logNetworks), so nothing special is needed on exit: the data is always
    // there, the while loop just has to end cleanly. ESC is polled twice per
    // round, otherwise the script would run until the device is switched off.
    while (!stopRequested && !failed) {
        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }

        var fix = fetchGps();

        if (!fix) {
            dialog.info("Waiting for a valid GPS fix...");
            serial.println("...no valid fix, skipping the scan...");
        } else if (fsName === "littlefs" && storage.spaceLittleFS().free < MIN_LITTLEFS_FREE_KB) {
            dialog.error("Internal storage almost full, stopping.");
            failed = true;
        } else {
            // wifi.scan() can drop the STA connection for a moment (see
            // PLAN.md): nothing to handle here, the next fetchGps()
            // reconnects through ensureWifi().
            var nets = wifi.scan();
            var count = logNetworks(nets, fix);
            if (count < 0) {
                dialog.error("Cannot write the log file, stopping.");
                failed = true;
            } else {
                totalLogged += count;
                dialog.info(
                    "Networks logged: " + to_string(totalLogged) +
                    " | last fix " + to_string(fix.ageMs) + "ms ago"
                );
                serial.println(
                    "logged " + to_string(count) + " networks @ " +
                    to_string(fix.lat) + "," + to_string(fix.lon)
                );
            }
        }

        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }
        delay(LOOP_DELAY_MS);
    }

    if (stopRequested) {
        // wait=true: otherwise the message vanishes immediately, overwritten
        // by the Scripts menu as soon as the script ends.
        dialog.success(
            "Wardriving stopped. " + to_string(totalLogged) +
            " networks saved in " + (logPath ? logPath.path : "(no file, never got a fix)") + ".",
            true
        );
    }
}
