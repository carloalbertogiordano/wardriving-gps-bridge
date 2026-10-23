# JS harness per Bruce

Interprete `mquickjs` standalone che riconosce davvero i nomi/arietà delle
API di Bruce (`wifi`, `dialog`, `storage`, `keyboard`, `serial`,
`parse_int`, `require`, ecc.) per una versione firmware specifica — non
un motore JS generico. Trova i veri `TypeError: not a function` prima di
caricare lo script sul T-Embed.

## Perché serve

`require()` ritorna oggetti con metodi che hanno nomi/arietà decisi dalla
versione esatta del firmware — main branch su GitHub non sempre coincide
con quello che hai flashato (es. `wifi.ipAddress()` su main vs
`wifi.getIPAddress()` su 1.16.1, o bare `keyboard()` che su 1.16.1 non
esiste, solo `dialog.prompt()`). L'unico modo per saperlo con certezza è
leggere la tabella reale della versione installata — o farci girare lo
script sopra per davvero.

## Come si usa

```bash
# scopri la versione installata: WebUI del T-Embed -> /systeminfo
# (richiede login, vedi admin/bruce o quello che hai impostato)

./build.sh 1.16.1          # costruisce ./build/mqjs per quella versione
./build/mqjs ../../bruce/wardrive.js
```

Il primo argomento di `build.sh` è il tag di Bruce da usare (default
`1.16.1`); deve esistere su https://github.com/pr3y/Bruce/tags.

## Cosa trova e cosa no

**Trova**: errori di sintassi, nomi/arietà sbagliati (`dialog.error` vs
`dialog.err`), `require()` di moduli inesistenti, logica rotta nel tuo
codice (variabili non definite, loop infiniti ovvi, ecc.) — tutto quello
che il vero motore rifiuta a tempo di parsing o esecuzione.

**Non trova**: niente che dipenda da hardware reale (schermo, GPS, SD,
WiFi reale) — `wifi.scan()`, `wifi.httpFetch()`, `storage.read/write`,
`dialog.choice`, `keyboard`/`dialog.prompt` ritornano dati finti ma
plausibili (vedi `gen_stubs.py`, sezione `REAL_BEHAVIOR`), non quello che
succederebbe davvero sul tuo hotspot/SD. Serve comunque un test reale sul
T-Embed per quello.

## Come funziona (nessun codice di Bruce vendorizzato)

`build.sh` scarica `mqjs_stdlib.c` (la tabella delle API) dalla versione
di Bruce che gli dici, fresco ogni volta in `build/` (ignorato da git —
Bruce è AGPL-3.0, non lo teniamo nel nostro repo). Il primo tentativo di
build fallisce apposta: dall'elenco dei simboli mancanti, `gen_stubs.py`
(questo sì, nostro) genera gli stub che fanno collimare il link. Build
finale, fatto.

Se Bruce cambia ancora i nomi delle API in una versione futura, basta
`./build.sh <nuova_versione>` — nessuna manutenzione manuale della lista
di simboli, si rigenera da sola.
