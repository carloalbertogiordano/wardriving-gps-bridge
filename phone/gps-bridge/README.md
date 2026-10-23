# GPS Bridge — app telefono (M0)

App Android Kotlin minimale, zero dipendenze esterne (no AndroidX, no Play
Services — `android.useAndroidX=false` in `gradle.properties` di proposito).
Pensata per girare su GrapheneOS: usa solo `LocationManager` con
`GPS_PROVIDER` diretto.

## Cosa fa adesso (M0)

- Bottone Avvia/Ferma nella UI.
- `LocationService` in foreground, richiede update GPS, mostra l'ultimo fix
  in notifica e logga su logcat (`tag: LocationService`).
- `LocationService.lastFix` (companion object) tiene l'ultimo fix in cache:
  è il punto da cui M1 leggerà per rispondere a Bruce senza mai fare una
  lettura GPS sincrona per richiesta.

## Come compilarla (testato su Fedora 44)

Fedora 44 ha tolto JDK 17/21 dai repo (solo `java-25-openjdk` e
`java-latest-openjdk`), e Gradle 8.7 non gira su JDK 25
(`Unsupported class file major version 69`). Soluzione: un JDK 21 portatile,
senza toccare i pacchetti di sistema.

```bash
# 1. JDK 21 portatile (Temurin), non tocca il sistema
mkdir -p ~/.jdks && cd ~/.jdks
curl -L -o temurin21.tar.gz \
  "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
tar xzf temurin21.tar.gz && rm temurin21.tar.gz

# 2. Dillo a Gradle, globalmente per il tuo utente
mkdir -p ~/.gradle
echo "org.gradle.java.home=$(ls -d ~/.jdks/jdk-21* | head -1)" >> ~/.gradle/gradle.properties

# 3. Android SDK command-line tools, se non li hai già (es. da Android Studio)
mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools
curl -L -o cmdtools.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-11479570_latest.zip"
unzip -q cmdtools.zip && mv cmdline-tools latest && rm cmdtools.zip
JAVA_HOME=$(ls -d ~/.jdks/jdk-21* | head -1) \
  ~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=~/Android/Sdk \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"
echo "sdk.dir=$HOME/Android/Sdk" > /path/a/gps-bridge/local.properties

# 4. Build
cd /path/a/gps-bridge
./gradlew assembleDebug
```

Se hai già Android Studio installato, il passo 3 è probabilmente superfluo:
controlla se `~/Android/Sdk` esiste già, in tal caso basta il file
`local.properties` che ci punta.

## Permessi richiesti al primo avvio

- Posizione precisa (`ACCESS_FINE_LOCATION`)
- Notifiche (`POST_NOTIFICATIONS`, solo Android 13+)

GrapheneOS li chiede normalmente come qualsiasi app, nessuna configurazione
speciale.

## Validazione M0

All'aperto, premi Avvia, aspetta il primo fix (può volerci 30s-2min: niente
rete-assistita senza Play Services). Controlla che:

- la notifica mostri lat/lon con un'accuratezza sensata (sotto i 20-30m
  all'aperto);
- il fix si aggiorni muovendosi;
- `adb logcat -s LocationService` mostri un fix ogni ~1s mentre ci si muove.

Se il fix non arriva mai o resta impreciso per minuti, fermati qui: significa
che GPS puro su GrapheneOS non basta per questo progetto, e va ripensata
l'architettura prima di passare a M1.
