# Wardriving with the phone's GPS — plan

The T-Embed CC1101 Plus (Bruce firmware) has no onboard GPS. The phone (Pixel
9a, GrapheneOS) does. The bridge works over Wi-Fi: the phone runs a hotspot,
the T-Embed joins it as a client, downloads the position over HTTP and scans
Wi-Fi in a loop.

## Architecture

```
[Pixel 9a GrapheneOS]                         [T-Embed CC1101 Plus]
  LocationManager (plain GPS_PROVIDER,           Bruce JS script (App Store)
  no Play Services needed)                       |- wifi.connect(hotspot)
       |                                         |- loop:
  Foreground service: fix history (~2 h)         |    wifi.scan() -> nearby networks
       |                                         |    POST /scan (the scan, as JSON)
  ServerSocket HTTP :port  <---- STA ------------+    queue on SD only if the phone
  POST /scan: position + dedup + Wigle file           is unreachable
```

## Fixed decisions

1. **Phone hotspot**, T-Embed as STA client. ~~No mDNS: IP and port are typed
   once in the Bruce script.~~ ~~Superseded: automatic deduction, last octet
   to '.1'.~~ **Superseded again**: on the real device the hotspot uses the
   `10.48.104.0/24` subnet with the phone on `.130`, not `.1` (verified with
   `adb shell ip addr` on the real hotspot interface, not assumed).
   `httpFetch` has no configurable timeout: a wrong, unreachable IP can block
   for a long time and trip the ESP32 watchdog (silent crash, no on-screen
   error, config never saved because the crash comes before `saveConfig()`).
   Now the deduced IP is only a suggestion shown to the user, who confirms or
   corrects it through `dialog.prompt()` BEFORE any network test. No more
   blind guess-and-hope.
2. **`wifi.scan()` while the STA connection is up**: the docs say it briefly
   interrupts the connection. Handled from the start in M2 with
   retry/reconnect (`wifi.connected()` check before each `httpFetch`), not
   deferred.
3. **Semi-automatic setup in the UI**, no hand-written config: the script
   scans the networks (`wifi.scan()`), lets the user pick the SSID
   (`dialog.choice()`), asks for the masked password (`dialog.prompt()`),
   connects, deduces and verifies the phone IP as in point 1, and saves
   everything so the setup is not repeated on later runs. `storage.write`
   appends by default: pass `"write"` explicitly or the config keeps growing
   on every run.
4. **Fix age computed by the phone, not by Bruce** (M4). The ESP32 has no
   clock comparable to the phone's: Bruce's `now()` is `millis()` since boot,
   the phone sends a real epoch. The protocol carries a fifth field,
   `age_ms` (`System.currentTimeMillis() - fix time`, computed phone-side on
   every answer), and Bruce uses it as is to decide whether a fix is too old
   (`STALE_FIX_MS`) - it never does the subtraction itself.
5. **The phone does position, dedup and storage; the T-Embed only scans.**
   The ESP32 sends each scan to the phone (`POST /scan`) and keeps nothing,
   except a small queue file when the phone cannot be reached. The phone has
   the GPS, the RAM and the battery budget, so it attaches the position,
   deduplicates by MAC and writes the Wigle file (`WigleWifi-1.6`, the same
   the stock Bruce module writes, one file per run named after the run's
   first fix, ready for wigle.net). Because the dedup is on the phone, there
   is no cap on tracked MACs, and for every MAC it keeps the sighting that
   places the access point best instead of the first one. "Best" is the
   lowest combined uncertainty, `hypot(GPS accuracy, distance from RSSI)`,
   with the distance from a rough log-distance path-loss model (-40 dBm at
   1 m, exponent 3). A closer sighting and a more precise fix both win, and
   neither does when it comes with a much worse value of the other (a
   -40 dBm sighting under a 200 m fix does not replace a -65 dBm one under a
   5 m fix). It is a heuristic to rank two sightings, not a range
   measurement.
6. **The T-Embed sends durations, never timestamps.** It has no clock
   comparable to the phone's (`now()` is millis since boot), so a scan
   carries `ago`, how long before the request it happened (half of the scan
   duration for a live scan). The phone keeps about two hours of fix history
   and looks up the position at `now - ago`; a fix further than 20 s from
   that moment is not trusted and the request gets a 503 ("no fix"), which
   the script shows as "waiting for a GPS fix". Same rule for live and queued
   scans, which is what makes the queue usable.
7. **Queue instead of loss.** When the phone cannot be reached (hotspot
   dropped, phone asleep, out of range) the scan goes to
   `/BruceWardriving/PhoneGPS/spool.txt` with its mid-scan `now()`, and is
   replayed, a few per round, as soon as the phone answers, with the age
   recomputed. The SD card is preferred, LittleFS is only a fallback with a
   free-space guard, and the queue is capped at 128 KB. Entries older than
   the phone's history, or from before a reboot (negative age), cannot be
   placed and are dropped. Pressing ESC runs a final sync and reports how
   many networks the phone holds and how many scans are still queued.
8. **Storage layout on the T-Embed**: only `/BruceWardriving/PhoneGPS/` with
   `config.txt` and, when needed, `spool.txt`. A config left by an older
   version in the LittleFS root is migrated to the new location and deleted.
9. **Protocol, locked after analysing the real code**:
   - Bruce's `httpFetch()` does `http.setReuse(false)` (seen in
     `wifi_js.cpp`): no keep-alive, ever. It supports `method` and `body`,
     which is what makes the POST possible, and it opens the Wi-Fi connect
     menu by itself if the STA is down, so the script always checks
     `wifi.connected()` first.
   - The real bottleneck is `wifi.scan()` (1-3 s, hardware/driver limit).
     Moving the position lookup to the phone removes the second request per
     round (the old `GET /gps`), so there is one POST per scan.
   - **Direct IP** in the URL, no hostname, skips DNS. Request:
     `POST /scan?run=ID&ago=MS` with
     `{"n":[{"m":mac,"s":ssid,"a":auth,"c":channel,"r":rssi}, ...]}`.
     Answer: `200 ok,added,improved,total`, `503` no fix, `400` malformed.
   - `GET /gps` stays on the phone as a debugging endpoint
     (`lat,lon,acc,ts,age_ms,alt`) and as the connectivity check of the
     setup wizard; the script no longer polls it.

## Why not a native C module?

Stock Bruce already has a native wardriving module
(`src/modules/gps/wardriving.cpp`), and a C port was considered. Rejected:

- The JS API has no way to launch a native module, and that module reads a
  GPS over a UART (`GPSserial` + TinyGPS++). Feeding it the phone's position
  means forking and reflashing the firmware with a new GPS source.
- It would not be faster where it matters: the loop is dominated by
  `wifi.scan()` (1-3 s) and `httpFetch` is native either way. The JS parsing
  and CSV formatting cost milliseconds.
- The script is a plain file on the SD card, validated offline by the harness
  below; a firmware fork would have to be rebuilt on every Bruce update.

What was borrowed instead is its design: the Wigle format, one file per run
and session-only MAC dedup - moved to the phone, where it needs no cap.

## Milestones

| # | What | Validates |
|---|---|---|
| **M0** | Minimal Kotlin app: Start/Stop button, foreground service, two phases - Fused Location (Play Services/microG) if available, otherwise plain `LocationManager` GPS - notification with last fix and active source, logcat logging | Which of the two phases really starts on this device, fix times of both |
| **M1** ✅ | Embedded HTTP server (`ServerSocket`, no external libraries) in the service, serves `GET /gps` from the cache | Done: `curl` through `adb forward` -> 503 with no fix (correct), 404 on a wrong path |
| **M2** ✅ | Bruce script: connects to the hotspot, `httpFetch` with direct IP, retry/reconnect if `wifi.scan()` dropped the STA, prints to screen | End to end against M1: the T-Embed polls `/gps` every ~2.2 s (seen in the phone's logcat) |
| **M3** ✅ | `wifi.scan()` in the loop, every network joined to the current fix, CSV on SD | Done: a real run wrote networks with coordinates to the SD CSV |
| **M4** | Missing/stale fix (>20 s, phone-side `age_ms`) is not logged, on-screen status (total networks, last fix age) | Implemented; the skip path still has to be seen on the T-Embed with a real stale fix |
| **M5** | Wigle-format export (one file per run), altitude from the phone | Passes in the harness; first outdoor run still pending |
| **M6** | Phone-side dedup and storage, `POST /scan`, position by `ago`, queue on SD, setup checklist in the app | Harness runs the 503 / unreachable / queue-replay paths; the phone side builds, live test pending |

## Main risk (updated after real tests)

**First test**: with plain GPS only, zero satellites used in the fix indoors
(`dumpsys location` -> `sv status messages ... used in fix: 0`,
`last location=null`). A real limit, not a bug.

**Second test**: the user does not have microG but GrapheneOS's **Sandboxed
Google Play** (real GMS, sandboxed). `LocationService` tries Fused Location
first through `GoogleApiAvailability`, which passes here too. But
`dumpsys`/logcat show the request rerouted to
`app.grapheneos.gmscompat.location.OsLocationProvider` - and by GrapheneOS
design, by default, it **forwards Play's requests to the system location
service and emulates network location with GNSS only** (a privacy choice:
Play never receives the nearby Wi-Fi networks/cells). Result: "Fused" on this
setup is identical to plain GPS, no indoor fix via Wi-Fi.

Three paths, none automatic in the code (they are the user's privacy
choices):
1. Enable Google's network location in GrapheneOS (explicit opt-in, sends
   nearby Wi-Fi/cells to Google).
2. Keep testing outdoors only (no software change).
3. microG with an offline NLP backend (e.g. DejaVu) - no third parties, but a
   local database to build over time.

**Third test (screen on, USB attached, indoors)**: the HTTP path is healthy -
the T-Embed polls `/gps` every ~2.2 s with no gaps - but the phone produces
no fix (`sv status messages processed: 0`), so Bruce correctly skips every
round as stale. Indoors that is expected.

**Standby hypothesis**: without a wake lock the CPU suspends with the screen
off, and neither the GNSS callbacks nor the HTTP `accept()` run. The service
now holds a `PARTIAL_WAKE_LOCK` and logs one line per request with the fix
age. To be confirmed by an outdoor run with the screen off.

## Repo structure

```
wardriving-gps-bridge/
  bruce/    <- Bruce JS script (M2, M3, M4, M5)
  phone/    <- Android Kotlin app (M0, M1)
  tools/js-harness/  <- standalone mquickjs interpreter to validate the
                        Bruce script before loading it (see below)
  PLAN.md
```

## JS verification harness (after three bugs found only on the T-Embed)

The first real run on the T-Embed gave `TypeError: not a function` twice.
Cause: the installed firmware is **1.16.1**, and its real API table
(`mqjs_stdlib.c`) does not always match the main branch on GitHub. Three bugs
confirmed by reading the exact code of that version:

1. `wifi.ipAddress()` does not exist -> it is `wifi.getIPAddress()`.
2. bare `keyboard(...)` does not exist -> it is `dialog.prompt(...)` (same
   `native_keyboard` inside, different names).
3. bare `println(...)` does not exist -> it only exists inside modules
   (`serial.println`, `display.println`, `badusb.println`).

Investigating one bug at a time through scattered greps does not scale: I
built `tools/js-harness/`, a **real** mquickjs interpreter (the one Bruce
actually uses, `BruceDevices/mquickjs`) linked to the **exact** API table of
the installed version, with stubs for the native functions (a handful with
fake but plausible behavior - wifi.scan/connect/httpFetch,
dialog.choice/prompt, storage.read/write, serial.println - the other ~200
just return `undefined`, our script does not need them). It does not vendor
Bruce's code (AGPL-3.0): it downloads it fresh every time.

From now on: `./tools/js-harness/build.sh && ./tools/js-harness/build/mqjs bruce/wardrive.js`
before every upload to the device, not after.

One more engine quirk found this way: a function cannot declare two
`catch (e)` with the same variable name (`SyntaxError: catch variable already
exists`) - the harness catches that offline.
