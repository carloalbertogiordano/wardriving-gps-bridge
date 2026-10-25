# wardriving-gps-bridge

The **Lilygo T-Embed CC1101 Plus** running the [Bruce](https://github.com/pr3y/Bruce)
firmware has no onboard GPS. This project bridges a **phone's GPS to the T-Embed
over Wi-Fi**, so you can wardrive (log nearby Wi-Fi networks with coordinates)
without buying a dedicated GPS module.

> Wardriving here means passive Wi-Fi mapping (SSID/BSSID + position), the same
> kind of data Wigle collects. Everything runs on hardware I own.

---

## How it works

```
[Pixel 9a / GrapheneOS]                          [T-Embed CC1101 Plus / Bruce]
  LocationManager (pure GNSS) /                    Bruce JS script
  Fused Location when available                      |- wifi.connect(hotspot)
       |                                             |- loop:
  Foreground service: fix history                    |    wifi.scan()  -> nearby APs
       |                                             |    POST /scan   -> the scan as JSON
  Embedded HTTP server :port   <---- STA ------------+    queue on SD only if the phone is away
  POST /scan: position + dedup + Wigle file
```

The phone runs a Wi-Fi hotspot and an embedded HTTP server. The T-Embed joins
as a client, scans Wi-Fi in a loop and posts every scan to the phone. The phone
attaches the position (looked up in its fix history at the moment of the
scan), deduplicates by MAC keeping the strongest signal, and writes a Wigle
file. If the phone cannot be reached, the scans wait in a small queue on the
T-Embed's SD card and are delivered as soon as it answers again.

## Components

| Path | What |
|---|---|
| `phone/` | Android **Kotlin** app (foreground service, fix history, HTTP server, dedup and Wigle files) |
| `bruce/` | **Bruce JS** script (connect, scan loop, send scans to the phone, queue) |
| `tools/js-harness/` | A standalone **mquickjs** interpreter to validate Bruce scripts *before* flashing them to the device |

## Status

A working, iteratively-built project (see [`PLAN.md`](PLAN.md) for the full
design log). Milestones M0–M6 are implemented — phone GPS service, HTTP server, the
scan loop, phone-side dedup with Wigle files and the delivery queue — with on-device validation
in progress (the HTTP path is verified end to end; the outdoor, screen-off run
is still pending).

## Files

On the T-Embed, only a config and, when the phone was unreachable, a queue:

```
/BruceWardriving/PhoneGPS/config.txt   saved setup (SSID, password, phone IP)
/BruceWardriving/PhoneGPS/spool.txt    scans waiting for the phone (usually absent)
```

On the phone, one `WigleWifi-1.6` file per run in the app's private storage,
named after the run's first fix (`yymmdd_hhmmss.csv`), uploadable to
wigle.net as it is.

## Engineering highlights

The interesting part is everything that only shows up on real hardware, and how
it was pinned down rather than guessed:

- **Hotspot subnet is not what you assume.** The real device hotspot used
  `10.48.104.0/24` with the phone at `.130`, not the textbook `.1` — verified
  with `adb shell ip addr`, not supposed. The script now *proposes* the deduced
  IP and lets the user confirm/correct it via a prompt before any network call.
- **`httpFetch()` has no timeout.** A wrong, unreachable IP can hang long enough
  to trip the ESP32 watchdog — a silent crash before `saveConfig()` ever runs.
  Hence the confirm-before-connect flow above.
- **`wifi.scan()` briefly drops the STA connection**, so every fetch is guarded
  by a `wifi.connected()` check with reconnect.
- **Firmware API drift → a real validation harness.** The installed Bruce build
  (1.16.1) exposes a different API surface than the GitHub main branch
  (`wifi.getIPAddress()` not `ipAddress()`, `dialog.prompt()` not bare
  `keyboard()`, etc.). Instead of debugging one `TypeError` at a time on the
  device, `tools/js-harness/` builds the **actual `mquickjs` engine Bruce uses**,
  bound to the exact API table of the installed version with plausible stubs for
  the native calls — so scripts are validated offline first. It downloads
  Bruce's AGPL-3.0 source fresh rather than vendoring it.
- **GrapheneOS location privacy is a real constraint.** By design, Play's
  network-location requests are rerouted to a GNSS-only provider (Wi-Fi/cell
  data never leaves the device), so "Fused" behaves like pure GPS here — no
  indoor fix without an explicit opt-in. Documented with the three options
  (enable Google network location, outdoor-only, or microG + offline NLP).

## Build

- Phone app: [`phone/gps-bridge/README.md`](phone/gps-bridge/README.md)
  (Kotlin, Gradle; includes a portable JDK 21 setup for recent Fedora).
- JS harness: [`tools/js-harness/README.md`](tools/js-harness/README.md).

## License

See [`LICENSE`](LICENSE). The validation harness builds against Bruce
(AGPL-3.0) by fetching it at build time; it does not redistribute Bruce's code.
