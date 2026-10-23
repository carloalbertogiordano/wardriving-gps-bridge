# wardriving-gps-bridge

Bruce (T-Embed CC1101 Plus) non ha GPS a bordo. Questo progetto fa da ponte
con il GPS del telefono via WiFi, per fare wardriving senza comprare un
modulo GPS fisico.

Piano completo, decisioni e milestone: [`PLAN.md`](PLAN.md).

```
bruce/    script JS per Bruce (App Store / JS Interpreter)
phone/    app Android Kotlin (Pixel 9a, GrapheneOS)
```

Stato attuale: **M0** — app telefono minimale, valida che il GPS puro
(`LocationManager`, niente Play Services) funzioni bene su GrapheneOS.
Vedi [`phone/gps-bridge/README.md`](phone/gps-bridge/README.md) per build e
validazione.
