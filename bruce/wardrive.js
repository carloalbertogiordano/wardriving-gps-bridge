// wardrive.js - Bruce JS Interpreter
//
// Wardriving with the phone's GPS. The script connects to the phone's hotspot,
// scans Wi-Fi in a loop and sends every scan to the GPS Bridge app, which
// attaches the position, deduplicates by MAC and keeps the run as a Wigle file.
//
// Everything is driven from a menu, in Bruce's own theme (menu.show, dialogs
// and the main border come from the firmware, so colors and fonts follow the
// system theme):
//
//   Start wardriving      connect to the chosen phone and scan
//   Phone: <name>         pick one of the paired phones (no password asked)
//   Pair a new phone      scan, pick the hotspot, password, confirm the IP
//   Forget a phone        remove a paired phone
//   Help                  how the whole thing works
//
// Several phones can be paired; each remembers its password and IP.
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
//   /BruceWardriving/PhoneGPS/phones.json  paired phones (SSID, password, IP)
//   /BruceWardriving/PhoneGPS/spool.txt    scans waiting for the phone (usually absent)

var wifi = require("wifi");
var dialog = require("dialog");
var storage = require("storage");
var serial = require("serial");
var keyboard = require("keyboard");
var display = require("display");
var menu = require("menu");

var BASE_DIR = "/BruceWardriving/PhoneGPS";
var PHONES_FILE = BASE_DIR + "/phones.json";
var OLD_CONFIG_FILE = BASE_DIR + "/config.txt"; // single-phone format, 3 lines
var SPOOL_FILE = BASE_DIR + "/spool.txt";
var LEGACY_CONFIG_FILE = "/wardrive_config.txt"; // oldest location, LittleFS root
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

// ---- paired phones ----

// { current: index of the phone to use, nets: [{ssid, password, phoneIp}] }
var store = { current: -1, nets: [] };

// New format is JSON; the older single-phone files were three plain lines.
function parseStore(raw) {
    var data = null;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        data = null; // not JSON: maybe the old three-line format
    }
    if (data && data.nets) return data;

    var lines = raw.split("\n");
    if (lines.length >= 3 && lines[0].length > 0) {
        return { current: 0, nets: [{ ssid: lines[0], password: lines[1], phoneIp: lines[2] }] };
    }
    return null;
}

function saveStore() {
    // "write": the default is append!
    return storage.write(pathOf(PHONES_FILE), JSON.stringify(store), "write");
}

function readFileOrNull(file) {
    try {
        return storage.read(file);
    } catch (e) {
        return null; // no such file
    }
}

function loadStore() {
    var raw = readFileOrNull(pathOf(PHONES_FILE));
    if (raw !== null) {
        var loaded = parseStore(raw);
        if (loaded) store = loaded;
        return;
    }

    // Older versions kept one phone elsewhere: migrate it, then delete the
    // old file so nothing is left behind.
    var olderSd = readFileOrNull(pathOf(OLD_CONFIG_FILE));
    var olderLfs = readFileOrNull(LEGACY_CONFIG_FILE);
    var older = olderSd !== null ? olderSd : olderLfs;
    var migrated = older !== null ? parseStore(older) : null;
    if (migrated) {
        store = migrated;
        saveStore();
        if (olderSd !== null) storage.remove(pathOf(OLD_CONFIG_FILE));
        if (olderLfs !== null) storage.remove(LEGACY_CONFIG_FILE);
        serial.println("migrated the saved phone to " + PHONES_FILE);
    }
}

function selectedPhone() {
    if (store.current >= 0 && store.current < store.nets.length) return store.nets[store.current];
    return null;
}

function findPhone(ssid) {
    for (var i = 0; i < store.nets.length; i++) {
        if (store.nets[i].ssid === ssid) return i;
    }
    return -1;
}

// ---- connection helpers ----

var config = null; // the phone in use during a run: {ssid, password, phoneIp}

// The last octet at '.1' is the usual gateway convention on consumer
// routers, but not on every Android hotspot (seen on a real device:
// phone on 10.48.104.130). It is only ever a suggestion the user
// confirms; Bruce has no gatewayIP().
function guessGatewayFromOwnIp(ip) {
    var parts = ip.split(".");
    if (parts.length !== 4) return null;
    return parts[0] + "." + parts[1] + "." + parts[2] + ".1";
}

function subnetOf(ip) {
    var parts = ip.split(".");
    return parts.length === 4 ? parts[0] + "." + parts[1] + "." + parts[2] : "";
}

function isValidIp(ip) {
    return !!ip && ip.split(".").length === 4;
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

// Joins the phone's hotspot. Returns true on success; on failure the user
// chooses between retrying and going back.
function joinHotspot(phone) {
    while (true) {
        dialog.info("Connecting to " + phone.ssid + "...");
        if (wifi.connect(phone.ssid, WIFI_CONNECT_TIMEOUT_S, phone.password)) {
            return true;
        }
        var choice = menu.show("Cannot join " + phone.ssid, ["Retry", "Back"]);
        if (choice !== 0) return false;
    }
}

// Asks for the phone's IP. httpFetch has no configurable timeout: against an
// unreachable IP it can block long enough to trip the ESP32 watchdog (silent
// crash), so the user confirms or corrects the IP BEFORE any blind network
// test. Returns the IP or null if the user backs out.
function askPhoneIp(suggestion) {
    var typed = dialog.prompt(
        "Phone IP",
        15,
        suggestion ? "Empty = " + suggestion : "E.g. 10.48.104.130"
    );
    var ip = typed ? typed : suggestion;
    if (!isValidIp(ip)) {
        dialog.error("Not a valid IP: " + to_string(ip), true);
        return null;
    }
    return ip;
}

// Joins the hotspot and checks the GPS Bridge server answers. Fixes a wrong
// IP on the spot. Returns true when the phone is ready for a run.
function connectAndVerify(phone) {
    if (!joinHotspot(phone)) return false;

    // A saved IP from another subnet would send httpFetch into the void:
    // ask again instead of risking the watchdog.
    var myIp = wifi.getIPAddress();
    if (subnetOf(myIp) !== subnetOf(phone.phoneIp)) {
        dialog.info("The hotspot changed address. Confirm the phone IP.", true);
        var fresh = askPhoneIp(guessGatewayFromOwnIp(myIp));
        if (!fresh) return false;
        phone.phoneIp = fresh;
        saveStore();
    }

    while (true) {
        dialog.info("Looking for GPS Bridge on " + phone.phoneIp + "...");
        if (canReachPhone(phone.phoneIp)) return true;

        var choice = menu.show("No answer on " + phone.phoneIp, ["Retry", "Change IP", "Back"]);
        if (choice === 0) continue;
        if (choice === 1) {
            var changed = askPhoneIp(guessGatewayFromOwnIp(myIp));
            if (changed) {
                phone.phoneIp = changed;
                saveStore();
            }
            continue;
        }
        return false;
    }
}

// ---- pairing a phone from scratch ----

var PAIR_HELP =
    "1. On the phone, turn on the Wi-Fi hotspot.\n" +
    "2. Open GPS Bridge and tap Start.\n" +
    "3. Come back here and scan: pick the hotspot's name.\n" +
    "4. Type its password and confirm the phone's IP.\n\n" +
    "A paired phone is remembered: next time just pick it.";

// Returns the list of distinct SSIDs seen by a scan.
function scanSsids() {
    dialog.info("Scanning Wi-Fi networks...");
    var nets = wifi.scan();
    var seen = {};
    var list = [];
    for (var i = 0; i < nets.length; i++) {
        var ssid = nets[i].SSID;
        if (ssid && !seen[ssid]) {
            seen[ssid] = true;
            list.push(ssid);
        }
    }
    return list;
}

// Pairs a phone and makes it the current one. Returns true when done.
function pairNewPhone() {
    dialog.viewText(PAIR_HELP, "Pair a phone");

    var ssid = null;
    while (ssid === null) {
        var found = scanSsids();
        var labels = found.concat(["Scan again", "Back"]);
        var pick = menu.show("Phone hotspot", labels);
        if (pick < 0 || pick === labels.length - 1) return false; // back
        if (pick === labels.length - 2) continue; // scan again
        ssid = found[pick];
    }

    // A phone paired before keeps its password: no typing twice.
    var known = findPhone(ssid);
    var password = known >= 0 ? store.nets[known].password : "";
    if (known < 0) {
        password = dialog.prompt("Wi-Fi password", 63, "Password for " + ssid, true);
    }

    var phone = { ssid: ssid, password: password, phoneIp: "" };
    if (!joinHotspot(phone)) return false;

    var guessed = guessGatewayFromOwnIp(wifi.getIPAddress());
    if (known >= 0 && store.nets[known].phoneIp) guessed = store.nets[known].phoneIp;
    dialog.info("Next: confirm the phone IP (see GPS Bridge on the phone).", true);
    var ip = askPhoneIp(guessed);
    if (!ip) return false;
    phone.phoneIp = ip;

    dialog.info("Looking for GPS Bridge on " + ip + "...");
    if (!canReachPhone(ip)) {
        dialog.error("No answer on " + ip + ". Is GPS Bridge started on the phone?", true);
        return false;
    }

    if (known >= 0) {
        store.nets[known] = phone;
        store.current = known;
    } else {
        store.nets.push(phone);
        store.current = store.nets.length - 1;
    }
    if (!saveStore()) {
        dialog.error("Paired, but the settings could not be saved.", true);
    } else {
        dialog.success("Paired with " + ssid + ".", true);
    }
    return true;
}

// Picks which paired phone to use. No password is asked: it is saved.
function choosePhone() {
    var names = [];
    for (var i = 0; i < store.nets.length; i++) names.push(store.nets[i].ssid);
    var labels = names.concat(["Pair a new phone", "Back"]);
    var pick = menu.show("Choose a phone", labels);
    if (pick < 0 || pick === labels.length - 1) return;
    if (pick === labels.length - 2) {
        pairNewPhone();
        return;
    }
    store.current = pick;
    saveStore();
}

function forgetPhone() {
    if (store.nets.length === 0) {
        dialog.info("No paired phones.", true);
        return;
    }
    var names = [];
    for (var i = 0; i < store.nets.length; i++) names.push(store.nets[i].ssid);
    var labels = names.concat(["Back"]);
    var pick = menu.show("Forget which phone?", labels);
    if (pick < 0 || pick === labels.length - 1) return;

    var sure = menu.show("Forget " + names[pick] + "?", ["Forget", "Cancel"]);
    if (sure !== 0) return;
    store.nets.splice(pick, 1);
    if (store.current === pick) store.current = store.nets.length > 0 ? 0 : -1;
    else if (store.current > pick) store.current--;
    saveStore();
}

// ---- sending scans ----

// One id per run: the phone starts a new file when it changes. now() is
// millis since boot, so the random part keeps ids apart across reboots.
var runId = "";

function newRunId() {
    return to_string(now()) + "-" + to_string(Math.floor(Math.random() * 100000));
}

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

// ---- run screen ----

// Drawn with the firmware's own helpers: the main border, title and subtitle
// use the colors of the theme chosen in Bruce, and plain text drawn after
// them inherits the same colors, so the screen follows the system theme.
// state: "ok" | "nofix" | "away" | "empty"
function drawStatus(state, total, added, queuedCount) {
    var h = display.height() || 170;
    var label = state === "ok" ? "GPS fix OK" :
        state === "empty" ? "No networks in range" :
        state === "nofix" ? "Waiting for a GPS fix" : "Phone unreachable";

    menu.showMainBorderWithTitle("Wardriving");
    menu.printSubtitle(label);

    display.setTextSize(4);
    display.setCursor(12, 46);
    display.print(to_string(total));

    display.setTextSize(1);
    display.setCursor(12, 82);
    display.print("networks in this run");
    display.setCursor(12, 98);
    display.print("Last scan: +" + to_string(added) + " new");
    display.setCursor(12, 110);
    display.print(queuedCount > 0 ? "Queued for the phone: " + to_string(queuedCount) : "Nothing queued");
    display.setCursor(12, h - 20);
    display.print("[ESC] stop and sync");
}

// ---- one run ----

function runWardriving(phone) {
    config = phone;
    runId = newRunId();
    loadSpoolState();

    var phoneTotal = 0; // networks in this run, as last reported by the phone
    var stopRequested = false;
    var failed = false;

    drawStatus("nofix", 0, 0, queued);

    // Nothing is held here that would be lost on exit: every scan is either
    // delivered or sitting in the queue file. ESC is polled twice per round
    // (a scan itself takes a few seconds, so a press may need a moment).
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
                drawStatus("ok", phoneTotal, r.added, queued);
                serial.println("sent " + to_string(nets.length) + " networks, +" + to_string(r.added));
            } else if (r.state === "nofix") {
                drawStatus("nofix", phoneTotal, 0, queued);
            } else if (r.state === "unreachable") {
                if (fsName === "littlefs" && storage.spaceLittleFS().free < MIN_LITTLEFS_FREE_KB) {
                    dialog.error("Phone unreachable and storage almost full: stopping.", true);
                    failed = true;
                } else if (spoolScan(scanBody, t0 + half)) {
                    drawStatus("away", phoneTotal, 0, queued);
                } else {
                    dialog.warning("Phone unreachable and the queue is full: scan dropped.");
                }
            } else {
                dialog.warning("Unexpected answer from the phone.");
            }
        }

        if (keyboard.getEscPress()) {
            stopRequested = true;
            break;
        }
        delay(LOOP_DELAY_MS);
    }

    // Final sync: deliver whatever is still queued, as many rounds as it
    // takes, giving up as soon as a round makes no progress.
    dialog.info("Stopping: syncing with the phone...");
    var guard = 0;
    while (queued > 0 && guard < 100) {
        var before = queued;
        var rest = replaySpool(MAX_REPLAYS_PER_ROUND);
        if (rest >= 0) phoneTotal = rest;
        if (queued >= before) break; // no progress: phone still away
        guard++;
    }

    // wait=true: otherwise the message vanishes immediately.
    if (queued > 0) {
        dialog.warning(
            to_string(phoneTotal) + " networks on the phone. " +
            to_string(queued) + " scans are still queued on this device.",
            true
        );
    } else {
        dialog.success(to_string(phoneTotal) + " networks saved on the phone.", true);
    }
}

// Connects to the chosen phone, confirms, and runs.
function startWardriving() {
    var phone = selectedPhone();
    if (!phone) {
        dialog.info("No phone paired yet: let's pair one.", true);
        if (!pairNewPhone()) return;
        phone = selectedPhone();
        if (!phone) return;
    }

    if (!connectAndVerify(phone)) return;

    var ready = menu.show("Ready: " + phone.ssid, ["Start (ESC stops)", "Back"]);
    if (ready !== 0) return;
    runWardriving(phone);
}

// ---- help ----

var HELP =
    "Your phone supplies the GPS; this device scans Wi-Fi and sends every " +
    "scan to the GPS Bridge app, which adds the position and keeps the run " +
    "as a Wigle file.\n\n" +
    "BEFORE YOU GO\n" +
    "- Phone: hotspot on, GPS Bridge started, location allowed.\n" +
    "- Wait for a GPS fix outdoors.\n\n" +
    "WHILE RUNNING\n" +
    "- Press ESC to stop. It may take a few seconds, a scan is in progress.\n" +
    "- If the phone goes out of range, scans are queued on the SD card and " +
    "delivered when it is back.\n\n" +
    "AFTER\n" +
    "- Open GPS Bridge > Saved runs to see the map, share the file or " +
    "upload it to wigle.net.";

// ---- main menu ----

function mainMenu() {
    var backPresses = 0;
    while (true) {
        var phone = selectedPhone();
        var options = [
            "Start wardriving",
            "Phone: " + (phone ? phone.ssid : "none paired"),
            "Pair a new phone",
            "Forget a phone",
            "Help",
            "Exit"
        ];
        var pick = menu.show("Wardriving", options);
        serial.println("main menu -> " + to_string(pick));

        // -1 is the back key. Leaving needs the Exit entry or a second back
        // press in a row, so a stray key press left over from launching the
        // script cannot close it before the menu has even been read.
        if (pick < 0) {
            backPresses++;
            if (backPresses >= 2) return;
            continue;
        }
        backPresses = 0;

        if (pick === 0) startWardriving();
        else if (pick === 1) {
            if (store.nets.length === 0) pairNewPhone();
            else choosePhone();
        }
        else if (pick === 2) pairNewPhone();
        else if (pick === 3) forgetPhone();
        else if (pick === 4) dialog.viewText(HELP, "Help");
        else return; // Exit
    }
}

// ---- start ----

fsName = pickStorage();
if (fsName !== "sd") {
    dialog.warning("No SD card: using internal storage, space is limited.", true);
}

// An uncaught error would end the script silently, the screen just going back
// to Bruce's menu: show it and log it instead.
try {
    loadStore();
    mainMenu();
} catch (err) {
    serial.println("wardrive.js error: " + to_string(err));
    dialog.error("Script error: " + to_string(err), true);
}
