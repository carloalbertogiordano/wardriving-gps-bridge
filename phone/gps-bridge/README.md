# GPS Bridge — phone app

Kotlin Android app for GrapheneOS, in two phases:

1. **Fused Location** (`play-services-location`), if the device has a valid
   implementation — on GrapheneOS either microG, which poses as an
   always up-to-date Play Services to pass the official check, or the
   sandboxed Google Play (rerouted to the system GNSS, see `PLAN.md`).
2. **Fallback to plain `LocationManager.GPS_PROVIDER`**, if phase 1 is not
   available. Outdoors only, no network assistance.

This pulls AndroidX in as a transitive dependency — it is no longer "zero
dependencies" like the very first version, a deliberate choice to have Fused
Location.

## What it does

- Start/Stop button in the UI.
- `LocationService` in the foreground: on start it checks with
  `GoogleApiAvailability` whether Fused Location is available, picks the
  phase, shows which one is active in the notification and in the UI, and
  logs to logcat (`tag: LocationService`). It holds a `PARTIAL_WAKE_LOCK`
  while running so the CPU does not suspend with the screen off.
- `LocationService.lastFix` (companion object) caches the last fix, including
  its `source` (FUSED or GPS_ONLY) and the altitude. The embedded HTTP server
  answers Bruce from it, never with a synchronous GPS read per request.
- `GET /gps` on port 8080 answers `lat,lon,acc,ts,age_ms,alt` (503 with no
  body when there is no fix yet). One logcat line per request
  (`tag: HttpGpsServer`) with the fix age.

## How to build it (tested on Fedora 44)

Fedora 44 dropped JDK 17/21 from the repos (only `java-25-openjdk` and
`java-latest-openjdk`), and Gradle 8.7 does not run on JDK 25
(`Unsupported class file major version 69`). Solution: a portable JDK 21,
without touching the system packages.

```bash
# 1. Portable JDK 21 (Temurin), does not touch the system
mkdir -p ~/.jdks && cd ~/.jdks
curl -L -o temurin21.tar.gz \
  "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
tar xzf temurin21.tar.gz && rm temurin21.tar.gz

# 2. Tell Gradle, globally for your user
mkdir -p ~/.gradle
echo "org.gradle.java.home=$(ls -d ~/.jdks/jdk-21* | head -1)" >> ~/.gradle/gradle.properties

# 3. Android SDK command-line tools, if you do not have them yet (e.g. from Android Studio)
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -L -o cmdtools.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-11479570_latest.zip"
unzip -q cmdtools.zip && mv cmdline-tools latest && rm cmdtools.zip
JAVA_HOME=$(ls -d ~/.jdks/jdk-21* | head -1) \
  ~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=~/Android/Sdk \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"
echo "sdk.dir=$HOME/Android/Sdk" > /path/to/gps-bridge/local.properties

# 4. Build
cd /path/to/gps-bridge
./gradlew assembleDebug
```

If Android Studio is already installed, step 3 is probably unnecessary: check
whether `~/Android/Sdk` already exists, in which case the `local.properties`
file pointing to it is enough.

## Permissions asked on first start

- Precise location (`ACCESS_FINE_LOCATION`)
- Notifications (`POST_NOTIFICATIONS`, Android 13+ only)

GrapheneOS asks for them normally like any app, no special configuration.
For long runs with the screen off, also set the app's battery usage to
"Unrestricted" in the system settings.

## Validation

Outdoors, press Start and wait for the first fix (it can take 30 s-2 min: no
network assistance without Play Services). Check that:

- the notification shows lat/lon with a sensible accuracy (under 20-30 m
  outdoors);
- the fix updates while moving;
- `adb logcat -s LocationService HttpGpsServer` shows a fix about every second
  while moving and one `GET /gps` line per request from the T-Embed.

If the fix never arrives or stays imprecise for minutes, stop here: it means
plain GPS on GrapheneOS is not enough for this project, and the architecture
has to be rethought.
