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

1. **Hotspot del telefono**, T-Embed come STA client. ~~Niente mDNS: IP e
   porta dell'hotspot si scrivono a mano una volta nello script Bruce.~~
   **Superato**: dato che ci si connette *solo* all'hotspot del telefono,
   il telefono e' sempre il gateway della sua sottorete. Bruce non espone
   un `gatewayIP()` (solo `ipAddress()`, il nostro IP), ma lo si deduce:
   si prende il proprio IP via `wifi.ipAddress()` e si sostituisce l'ultimo
   ottetto con `.1` (convenzione quasi universale per hotspot
   Android/router consumer). Si verifica provandolo dal vivo con una
   `httpFetch` reale, non per supposizione.
2. **`wifi.scan()` durante connessione STA attiva**: la doc dice che interrompe
   brevemente la connessione. Gestito da subito in M2 con retry/riconnessione
   (`wifi.connected()` check prima di ogni `httpFetch`), non rimandato.
3. **Setup semi-automatico in UI**, non piu' config scritta a mano: lo
   script scansiona le reti (`wifi.scan()`), fa scegliere l'SSID
   (`dialog.choice()`), chiede la password mascherata
   (`keyboard(title, maxSize, msg, true)`), si connette, deduce e
   verifica l'IP del telefono come al punto 1, e salva tutto in
   `/wardrive_config.txt` (LittleFS, default di `storage.write` quando il
   path e' una stringa semplice) per non rifare il setup ai run
   successivi. `storage.write` di default fa *append*: va passato
   `"write"` esplicito o la config si accumula ad ogni esecuzione.
4. **Eta' del fix calcolata dal telefono, non da Bruce** (M4). L'ESP32
   non ha un orologio comparabile a quello del telefono: `now()` di
   Bruce e' `millis()` da boot, il telefono manda un epoch reale. Il
   protocollo porta un quinto campo, `age_ms`
   (`System.currentTimeMillis() - orario del fix`, calcolato lato
   telefono ad ogni risposta), e Bruce lo usa cosi' com'e' per decidere
   se un fix e' troppo vecchio (`STALE_FIX_MS`) - non fa mai la
   sottrazione da solo.
5. **Log CSV su SD**, non LittleFS: `{fs:"sd", path:"/wardrive_log.csv"}`
   nello stesso file, un giro di `wifi.scan()` -> N righe (una per rete
   trovata), stesso fix per tutte. SSID con virgole: `split(",").join(";")`,
   niente `replace()`/regex (non garantiti su questo motore).
3. **Protocollo GPS tra i due device, bloccato dopo analisi del codice reale**:
   - `httpFetch()` di Bruce fa `http.setReuse(false)` (visto in `wifi_js.cpp`):
     niente keep-alive, mai, è hardcoded in C++. Costante fissa, non
     ottimizzabile senza ricompilare.
   - Collo di bottiglia reale è `wifi.scan()` (1-3s, limite hardware/driver),
     non il fetch GPS (10-40ms su LAN locale). Ottimizzare il protocollo non
     sposta il loop in modo percepibile, ma si fa comunque perché è gratis:
     - **IP diretto** nell'URL (`http://192.168.x.x:porta/gps`), niente
       hostname, salta la risoluzione DNS. Dedotto automaticamente (punto
       1 sopra), non piu' scritto a mano.
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
| **M1** ✅ | Server HTTP embedded (`ServerSocket`, zero librerie esterne) nel service, serve `GET /gps` -> `"lat,lon,acc,ts"` da cache | Fatto: `curl` via `adb forward` -> 503 senza fix (corretto), 404 su path sbagliato |
| **M2** | Script Bruce: connette al hotspot, `httpFetch` con IP diretto, retry/riconnessione se `wifi.scan()` ha droppato la STA, stampa a schermo | end-to-end verso M1 |
| **M3** ✅ | `wifi.scan()` nel loop, ogni rete unita al fix GPS corrente, CSV su SD (`/wardrive_log.csv`) | Da validare sul T-Embed |
| **M4** ✅ | Fix mancante/scaduto (>20s, `age_ms` dal telefono) non viene loggato, stato a schermo (reti totali, eta' ultimo fix) via `dialog.info()` | Da validare sul T-Embed |
| **M5** (dopo) | Export formato tipo Wigle, o upload diretto | Opzionale |

## Rischio principale (aggiornato due volte dopo test reali)

**Primo test**: col solo GPS puro, zero satelliti usati in fix indoor
(`dumpsys location` -> `sv status messages ... used in fix: 0`,
`last location=null`). Limite reale, non un bug.

**Secondo test**: l'utente non ha microG, ma il **Sandboxed Google Play**
di GrapheneOS (GMS reale, sandboxato). `LocationService` prova Fused
Location per primo via `GoogleApiAvailability`, che passa anche qui. Ma
`dumpsys`/logcat mostrano la richiesta rerouted su
`app.grapheneos.gmscompat.location.OsLocationProvider` — e per design
GrapheneOS, di default, **inoltra le richieste di Play al servizio
location del sistema ed emula il network location col solo GNSS**
(scelta di privacy: Play non riceve mai le reti WiFi/celle vicine).
Risultato: "Fused" su questo setup e' identico al GPS puro, nessun fix
indoor via WiFi.

Tre strade, nessuna automatica nel codice (sono scelte privacy
dell'utente):
1. Attivare la localizzazione di rete di Google in GrapheneOS (opt-in
   esplicito, manda WiFi/celle vicine a Google).
2. Continuare a testare solo all'aperto (nessun cambiamento software).
3. microG con backend NLP offline (es. DejaVu) — niente terzi, ma setup e
   database locale da costruire nel tempo.

## Struttura repo

```
wardriving-gps-bridge/
  bruce/    <- script JS per Bruce (M2, M3, M4)
  phone/    <- app Android Kotlin (M0, M1)
  PLAN.md
```
