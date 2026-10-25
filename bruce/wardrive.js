// wardrive.js - Bruce JS Interpreter
//
// Wardriving with the phone's GPS: connects to the phone's hotspot, scans
// Wi-Fi in a loop and sends every scan to the GPS Bridge app, which attaches
// the position, deduplicates by MAC and keeps the run as a Wigle file.
//
// The T-Embed does the radio work only. Position, deduplication and storage
// live on the phone, which has the RAM and the GPS; nothing but a small queue
// is written on this side.
//
// First run: guided setup (scan, pick the hotspot SSID, password, confirm
// the phone IP, verify the server answers) and the result is saved, so
// later runs start straight away.
//
// Protocol (PLAN.md): POST /scan?run=ID&ago=MS with a JSON body
// {"n":[{"m":mac,"s":ssid,"a":auth,"c":channel,"r":rssi}, ...]}.
//   200 "ok,added,improved,total"  stored
//   503                            the phone has no fix close to the scan time
//   no answer                      phone unreachable: the scan is queued
// `ago` is how long before the request the scan happened: the ESP32 has no
// clock comparable to the phone's (now() is millis since boot), so it only
// ever sends durations and the phone does the timekeeping.
//
// Queue: when the phone cannot be reached the scan goes to a small file and
// is replayed, with its original age, as soon as the phone answers again.
// The phone keeps about two hours of position history, so older entries
// cannot be placed and are dropped.
//
// File layout - everything lives in a single folder, preferably on the SD
// card so LittleFS does not fill up:
//
//   /BruceWardriving/PhoneGPS/config.txt   saved setup
//   /BruceWardriving/PhoneGPS/spool.txt    scans waiting for the phone (usually absent)

var wifi = require("wifi");
var dialog = require("dialog");
var storage = require("storage");
var serial = require("serial");
var keyboard = require("keyboard");
var display = require("display");

var BASE_DIR = "/BruceWardriving/PhoneGPS";
var CONFIG_FILE = BASE_DIR + "/config.txt";
var SPOOL_FILE = BASE_DIR + "/spool.txt";
var LEGACY_CONFIG_FILE = "/wardrive_config.txt"; // old LittleFS location
var MIN_LITTLEFS_FREE_KB = 100; // below this, refuse to queue on LittleFS

var PHONE_PORT = 8080;
var WIFI_CONNECT_TIMEOUT_S = 20;
var LOOP_DELAY_MS = 1000;
var MAX_SPOOL_BYTES = 128 * 1024; // beyond this, new scans are dropped
var MAX_REPLAYS_PER_ROUND = 3; // keeps the loop responsive while catching up
var HISTORY_LIMIT_MS = 7000000; // a bit under the phone's ~2h of fix history

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

// ---- sending scans ----

// One id per run: the phone starts a new file when it changes. now() is
// millis since boot, so the random part keeps ids apart across reboots.
var runId = to_string(now()) + "-" + to_string(Math.floor(Math.random() * 100000));

// Compact JSON of one scan: short keys, one object per network.
function buildScanBody(nets) {
    var list = [];
    for (var i = 0; i < nets.length; i++) {
        var n = nets[i];
        list.push({
            m: to_string(n.MAC),
            s: to_string(n.SSID),
            a: to_string(n.encryptionType),
            c: n.channel,
            r: n.RSSI
        });
    }
    return JSON.stringify({ n: list });
}

// POST one scan. Returns {state: "ok", added, improved, total},
// {state: "nofix"}, {state: "unreachable"} or {state: "error"}.
// ensureWifi() first: httpFetch opens the Wi-Fi connect menu by itself if the
// STA is down (wifi.scan() can drop it), which would block the loop.
function postScan(body, agoMs) {
    if (!ensureWifi()) {
        return { state: "unreachable" };
    }
    var url = "http://" + config.phoneIp + ":" + PHONE_PORT + "/scan?run=" + runId +
        "&ago=" + to_string(Math.floor(agoMs));
    var res;
    try {
        res = wifi.httpFetch(url, { method: "POST", body: body });
    } catch (e) {
        return { state: "unreachable" };
    }

    if (res.status === 503) {
        return { state: "nofix" };
    }
    if (!res.ok) {
        serial.println("POST " + url + " -> status " + res.status);
        return { state: "error" };
    }

    var p = res.body.split(",");
    if (p.length < 4 || p[0] !== "ok") {
        serial.println("unexpected answer: " + res.body);
        return { state: "error" };
    }
    return {
        state: "ok",
        added: parse_int(p[1]),
        improved: parse_int(p[2]),
        total: parse_int(p[3])
    };
}

// ---- queue for scans the phone could not take ----

var queued = 0; // scans waiting in the spool file
var spoolBytes = 0;

function readSpool() {
    try {
        return storage.read(pathOf(SPOOL_FILE));
    } catch (e) {
        return "";
    }
}

function loadSpoolState() {
    var raw = readSpool();
    spoolBytes = raw.length;
    queued = raw.length > 0 ? raw.split("\n").length - 1 : 0;
}

// midMillis = now() at the middle of the scan. The age is recomputed from
// it at replay time, so it stays right however long the phone stays away.
function spoolScan(body, midMillis) {
    var line = to_string(Math.floor(midMillis)) + "|" + body + "\n";
    if (spoolBytes + line.length > MAX_SPOOL_BYTES) {
        return false;
    }
    if (!storage.write(pathOf(SPOOL_FILE), line, "append")) {
        return false;
    }
    spoolBytes += line.length;
    queued++;
    return true;
}

// Replays up to `max` queued scans, oldest first. Stops at the first
// unreachable answer and keeps everything not yet delivered. Returns the
// total on the phone after the last delivery, or -1 if none was delivered.
function replaySpool(max) {
    var lines = readSpool().split("\n");
    var done = 0;
    var total = -1;
    while (done < lines.length && done < max) {
        var line = lines[done];
        if (line.length === 0) { done++; continue; }

        var sep = line.indexOf("|");
        var mid = parse_int(line.substring(0, sep));
        var ago = now() - mid;
        // Negative age = the device rebooted since (now() restarted from
        // zero); too old = outside the phone's history. Either way the scan
        // cannot be placed any more.
        if (ago >= 0 && ago <= HISTORY_LIMIT_MS) {
            var r = postScan(line.substring(sep + 1), ago);
            if (r.state === "unreachable") break;
            if (r.state === "ok") total = r.total;
        }
        done++;
    }

    var rest = lines.slice(done).join("\n");
    if (rest.length === 0 || rest === "\n") {
        storage.remove(pathOf(SPOOL_FILE));
        spoolBytes = 0;
        queued = 0;
    } else {
        storage.write(pathOf(SPOOL_FILE), rest, "write");
        spoolBytes = rest.length;
        queued = rest.split("\n").length - 1;
    }
    return total;
}

// ---- status screen ----

// The T-Embed screen is small (about 320x170), so the run is shown as one big
// number with a colored header that doubles as a link indicator, instead of
// a text dialog redrawn every round. Drawn with plain rectangles and text
// only: cheap enough for the ESP32 and nothing here needs a sprite.
var COLOR_OK = display.color(46, 160, 67);
var COLOR_WAIT = display.color(210, 153, 34);
var COLOR_AWAY = display.color(218, 54, 51);
var COLOR_BG = display.color(13, 17, 23);
var COLOR_TEXT = display.color(230, 237, 243);
var COLOR_DIM = display.color(125, 133, 144);

// state: "ok" | "nofix" | "away" | "empty"
function drawStatus(state, total, added, queuedCount) {
    var w = display.width() || 320;
    var h = display.height() || 170;
    var headerColor = state === "ok" || state === "empty" ? COLOR_OK :
        state === "nofix" ? COLOR_WAIT : COLOR_AWAY;
    var label = state === "ok" ? "GPS FIX OK" :
        state === "empty" ? "NO NETWORKS HERE" :
        state === "nofix" ? "WAITING FOR GPS FIX" : "PHONE UNREACHABLE";

    display.fill(COLOR_BG);
    display.drawFillRect(0, 0, w, 24, headerColor);
    display.setTextAlign(0);
    display.setTextColor(COLOR_TEXT);
    display.setTextSize(2);
    display.drawText(label, 8, 5);

    display.setTextColor(COLOR_TEXT);
    display.setTextSize(5);
    display.drawText(to_string(total), 12, 40);

    display.setTextColor(COLOR_DIM);
    display.setTextSize(2);
    display.drawText("networks", 12, 88);
    if (added > 0) {
        display.setTextColor(COLOR_OK);
        display.drawText("+" + to_string(added), w - 80, 52);
    }

    display.setTextColor(queuedCount > 0 ? COLOR_WAIT : COLOR_DIM);
    display.setTextSize(1);
    display.drawText(queuedCount > 0 ? "Queued scans: " + to_string(queuedCount) : "Queue empty", 12, h - 34);
    display.setTextColor(COLOR_DIM);
    display.drawText("ESC: stop and sync", 12, h - 18);
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
    loadSpoolState();

    var phoneTotal = 0; // networks in this run, as last reported by the phone
    var sentScans = 0;
    var stopRequested = false;
    var failed = false;

    // Nothing is held here that would be lost on exit: every scan is either
    // delivered or sitting in the queue file. ESC is polled twice per round,
    // otherwise the script would run until the device is switched off.
    while (!stopRequested && !failed) {
        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }

        if (queued > 0) {
            var replayed = replaySpool(MAX_REPLAYS_PER_ROUND);
            if (replayed >= 0) phoneTotal = replayed;
        }

        var t0 = now();
        var nets = wifi.scan();
        var t1 = now();
        var half = (t1 - t0) / 2;

        if (nets.length === 0) {
            drawStatus("empty", phoneTotal, 0, queued);
        } else {
            var scanBody = buildScanBody(nets);
            var r = postScan(scanBody, half);

            if (r.state === "ok") {
                phoneTotal = r.total;
                sentScans++;
                drawStatus("ok", phoneTotal, r.added, queued);
                serial.println("sent " + to_string(nets.length) + " networks, +" + to_string(r.added));
            } else if (r.state === "nofix") {
                drawStatus("nofix", phoneTotal, 0, queued);
            } else if (r.state === "unreachable") {
                if (fsName === "littlefs" && storage.spaceLittleFS().free < MIN_LITTLEFS_FREE_KB) {
                    dialog.error("Phone unreachable and storage almost full, stopping.");
                    failed = true;
                } else if (spoolScan(scanBody, t0 + half)) {
                    drawStatus("away", phoneTotal, 0, queued);
                } else {
                    dialog.info("Phone unreachable, queue full: scan dropped.");
                }
            } else {
                dialog.info("Unexpected answer from the phone.");
            }
        }

        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }
        delay(LOOP_DELAY_MS);
    }

    if (stopRequested) {
        // Final sync: deliver whatever is still queued, as many rounds as it
        // takes, giving up at the first unreachable answer.
        var guard = 0;
        while (queued > 0 && guard < 100) {
            var before = queued;
            var rest = replaySpool(MAX_REPLAYS_PER_ROUND);
            if (rest >= 0) phoneTotal = rest;
            if (queued >= before) break; // no progress: phone still away
            guard++;
        }

        // wait=true: otherwise the message vanishes immediately, overwritten
        // by the Scripts menu as soon as the script ends.
        if (queued > 0) {
            dialog.warning(
                "Stopped. " + to_string(phoneTotal) + " networks on the phone, " +
                to_string(queued) + " scans still queued on this device.",
                true
            );
        } else {
            dialog.success(
                "Wardriving stopped. " + to_string(phoneTotal) + " networks saved on the phone.",
                true
            );
        }
    }
}
