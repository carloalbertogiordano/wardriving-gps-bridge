# Wardriving via GPS del telefono — piano

T-Embed CC1101 Plus (firmware Bruce) non ha GPS a bordo. Il telefono (Pixel 9a,
GrapheneOS) sì. Si fa da ponte via WiFi: il telefono fa hotspot, il T-Embed si
collega come client, scarica la posizione via HTTP e fa lo scan WiFi in loop.

## Architettura

```
[Pixel 9a GrapheneOS]                         [T-Embed CC1101 Plus]
  LocationManager (GPS_PROVIDER puro,            script JS via App Store
  niente Play Services)                          |- wifi.connect(hotspot)
       |                                         |- loop:
  Foreground Service (cache ultimo fix)          |    wifi.scan() -> reti vicine
       |                                         |    wifi.httpFetch(IP:porta/gps)
  ServerSocket HTTP :porta  <---- STA -----------+    storage.write -> CSV su SD
  GET /gps -> testo CSV "lat,lon,acc,ts"
```

## Decisioni fissate

1. **Hotspot del telefono**, T-Embed come STA client. Niente mDNS: IP e porta
   dell'hotspot si scrivono a mano una volta nello script Bruce.
2. **`wifi.scan()` durante connessione STA attiva**: la doc dice che interrompe
   brevemente la connessione. Gestito da subito in M2 con retry/riconnessione
   (`wifi.connected()` check prima di ogni `httpFetch`), non rimandato.
3. **Protocollo GPS tra i due device, bloccato dopo analisi del codice reale**:
   - `httpFetch()` di Bruce fa `http.setReuse(false)` (visto in `wifi_js.cpp`):
     niente keep-alive, mai, è hardcoded in C++. Costante fissa, non
     ottimizzabile senza ricompilare.
   - Collo di bottiglia reale è `wifi.scan()` (1-3s, limite hardware/driver),
     non il fetch GPS (10-40ms su LAN locale). Ottimizzare il protocollo non
     sposta il loop in modo percepibile, ma si fa comunque perché è gratis:
     - **IP diretto** nell'URL (`http://192.168.x.x:porta/gps`), niente
       hostname, salta la risoluzione DNS.
     - **Risposta testo semplice**, non JSON: `"lat,lon,acc,ts"`. JSON.parse/
       stringify esistono nel motore (confermato in `mqjs_stdlib`), ma per
       questo payload il parsing testo è comunque più leggero e si fa subito.
     - **Telefono risponde sempre da cache** (`LocationManager` aggiorna un
       valore in memoria in continuo), mai una letture GPS sincrona per
       richiesta: lato telefono il tempo di risposta resta vicino a zero
       quanto quello di Bruce.

## Milestone

| # | Cosa | Valida |
|---|---|---|
| **M0** | App Kotlin minimale: bottone Start/Stop, foreground service, due fasi — Fused Location (Play Services/microG) se disponibile, altrimenti `LocationManager` GPS puro — notifica con ultimo fix e sorgente attiva, log su logcat | Quale delle due fasi parte davvero su questo device, tempi di fix di entrambe |
| **M1** | Server HTTP embedded (`ServerSocket`, zero librerie esterne) nel service, serve `GET /gps` -> `"lat,lon,acc,ts"` da cache | `curl` da PC via hotspot |
| **M2** | Script Bruce: connette al hotspot, `httpFetch` con IP diretto, retry/riconnessione se `wifi.scan()` ha droppato la STA, stampa a schermo | end-to-end verso M1 |
| **M3** | Aggiungi `wifi.scan()` al loop, unisci con GPS, scrivi CSV su SD | File leggibile, coordinate sensate |
| **M4** | Config persistita (SSID/password), stato a schermo, gestione fix mancante/scaduto | Uso reale senza babysitting |
| **M5** (dopo) | Export formato tipo Wigle, o upload diretto | Opzionale |

## Rischio principale (aggiornato dopo il test reale)

GrapheneOS non ha Google Play Services, ma l'utente ha microG installato,
che implementa la stessa API (`FusedLocationProviderClient`) spacciandosi
per una versione sempre aggiornata di Play Services — passa il check
ufficiale `GoogleApiAvailability.isGooglePlayServicesAvailable()`.

`LocationService` prova prima Fused (via microG), e usa `GPS_PROVIDER`
puro solo come fallback se quel check fallisce. Verificato sul device:
col solo GPS puro, zero satelliti usati in fix indoor (`dumpsys location`
-> `sv status messages ... used in fix: 0`, `last location=null`) —
limite reale, non un bug. Da qui la doppia fase.

## Struttura repo

```
wardriving-gps-bridge/
  bruce/    <- script JS per Bruce (M2, M3, M4)
  phone/    <- app Android Kotlin (M0, M1)
  PLAN.md
```
