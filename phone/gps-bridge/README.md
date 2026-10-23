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

## Come compilarla

Il wrapper Gradle non è incluso per intero (il jar binario non si scrive a
mano). Due modi:

1. **Android Studio** (più semplice): apri la cartella `gps-bridge/` come
   progetto esistente. Studio genera da solo il wrapper e sincronizza.
2. **Gradle da riga di comando**, se già installato: dentro `gps-bridge/`,
   `gradle wrapper --gradle-version 8.7`, poi `./gradlew assembleDebug`.

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
