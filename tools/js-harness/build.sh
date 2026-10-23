#!/usr/bin/env bash
# Costruisce un interprete mquickjs standalone (./build/mqjs) che riconosce
# davvero i nomi/arietà delle API di Bruce (wifi, dialog, storage, keyboard,
# serial, parse_int, ecc.) per una versione firmware specifica - non
# un motore generico.
#
# Non vendorizza il codice di Bruce (AGPL-3.0): lo scarica fresco ogni
# volta dentro build/ (ignorato da git) e genera solo gli stub nostri
# (gen_stubs.py) per farlo linkare fuori dall'ESP32.
#
# Uso: ./build.sh [versione_bruce]   (default: 1.16.1)
#
# Al termine: ./build/mqjs /path/al/tuo/script.js
set -euo pipefail

BRUCE_VERSION="${1:-1.16.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"

echo "== Bruce JS harness: versione firmware $BRUCE_VERSION =="
rm -rf "$BUILD"
mkdir -p "$BUILD"
cd "$BUILD"

echo "-- clono mquickjs 0.0.6 (il motore, vanilla, open source) --"
git clone --depth 1 --branch 0.0.6 https://github.com/BruceDevices/mquickjs.git engine >/dev/null 2>&1
cp engine/*.c engine/*.h engine/Makefile .

echo "-- scarico mqjs_stdlib.c di Bruce $BRUCE_VERSION (solo la tabella delle API, non il firmware) --"
curl -sL "https://raw.githubusercontent.com/pr3y/Bruce/$BRUCE_VERSION/src/modules/bjs_interpreter/mqjs_stdlib.c" -o mqjs_stdlib.c
curl -sL "https://raw.githubusercontent.com/pr3y/Bruce/$BRUCE_VERSION/src/modules/bjs_interpreter/user_classes_js.h" -o user_classes_js.h

if ! grep -q "JS_CFUNC_DEF" mqjs_stdlib.c; then
    echo "ERRORE: non sono riuscito a scaricare mqjs_stdlib.c per la versione $BRUCE_VERSION." >&2
    echo "Controlla che il tag esista: https://github.com/pr3y/Bruce/tags" >&2
    exit 1
fi

# angle-bracket include non trova il file locale
sed -i 's/#include <mquickjs_build.h>/#include "mquickjs_build.h"/' mqjs_stdlib.c

echo "-- primo tentativo di build (deve fallire: serve per elencare gli stub da generare) --"
sed -i '/#include "mqjs_stdlib.h"/i #include "user_classes_js.h"' mqjs.c
set +e
make mqjs MQJS_OBJS="mqjs.o readline_tty.o readline.o mquickjs.o dtoa.o libm.o cutils.o" \
    > first_attempt.log 2>&1
set -e

grep "undeclared here" first_attempt.log \
    | grep -oE "[‘'][a-zA-Z_][a-zA-Z0-9_]*[’']" \
    | tr -d "‘’'" \
    | sort -u > undeclared_symbols.txt

count=$(wc -l < undeclared_symbols.txt)
if [ "$count" -eq 0 ]; then
    echo "ERRORE: nessun simbolo mancante trovato - il primo tentativo doveva fallire." >&2
    echo "Guarda $BUILD/first_attempt.log" >&2
    exit 1
fi
echo "   $count simboli da stubbare"

echo "-- genero gli stub (gen_stubs.py, nostro, non di Bruce) --"
python3 -I "$HERE/gen_stubs.py" undeclared_symbols.txt .
sed -i '/#include "user_classes_js.h"/a #include "bruce_stub_decls.h"' mqjs.c

echo "-- build finale --"
make mqjs MQJS_OBJS="mqjs.o readline_tty.o readline.o mquickjs.o dtoa.o libm.o cutils.o bruce_stubs.o"

echo
echo "Fatto: $BUILD/mqjs"
echo "Uso:   $BUILD/mqjs /path/al/tuo/script.js"
