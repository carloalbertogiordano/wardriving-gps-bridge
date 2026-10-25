#!/usr/bin/env bash
# Builds a standalone mquickjs interpreter (./build/mqjs) that really knows
# the names/arities of Bruce's APIs (wifi, dialog, storage, keyboard,
# serial, parse_int, ...) for a specific firmware version - not a generic
# engine.
#
# Bruce's code (AGPL-3.0) is not vendored: it is downloaded fresh every
# time into build/ (git-ignored) and only our own stubs (gen_stubs.py) are
# generated so that it links outside the ESP32.
#
# Usage: ./build.sh [bruce_version]   (default: 1.16.1)
#
# When done: ./build/mqjs /path/to/your/script.js
set -euo pipefail

BRUCE_VERSION="${1:-1.16.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"

echo "== Bruce JS harness: firmware version $BRUCE_VERSION =="
rm -rf "$BUILD"
mkdir -p "$BUILD"
cd "$BUILD"

echo "-- cloning mquickjs 0.0.6 (the vanilla open source engine) --"
git clone --depth 1 --branch 0.0.6 https://github.com/BruceDevices/mquickjs.git engine >/dev/null 2>&1
cp engine/*.c engine/*.h engine/Makefile .

echo "-- downloading Bruce $BRUCE_VERSION mqjs_stdlib.c (only the API table, not the firmware) --"
curl -sL "https://raw.githubusercontent.com/pr3y/Bruce/$BRUCE_VERSION/src/modules/bjs_interpreter/mqjs_stdlib.c" -o mqjs_stdlib.c
curl -sL "https://raw.githubusercontent.com/pr3y/Bruce/$BRUCE_VERSION/src/modules/bjs_interpreter/user_classes_js.h" -o user_classes_js.h

if ! grep -q "JS_CFUNC_DEF" mqjs_stdlib.c; then
    echo "ERROR: could not download mqjs_stdlib.c for version $BRUCE_VERSION." >&2
    echo "Check that the tag exists: https://github.com/pr3y/Bruce/tags" >&2
    exit 1
fi

# the angle-bracket include does not find the local file
sed -i 's/#include <mquickjs_build.h>/#include "mquickjs_build.h"/' mqjs_stdlib.c

echo "-- first build attempt (must fail: it lists the stubs to generate) --"
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
    echo "ERROR: no missing symbol found - the first attempt was supposed to fail." >&2
    echo "See $BUILD/first_attempt.log" >&2
    exit 1
fi
echo "   $count symbols to stub"

echo "-- generating the stubs (gen_stubs.py, ours, not Bruce's) --"
python3 -I "$HERE/gen_stubs.py" undeclared_symbols.txt .
sed -i '/#include "user_classes_js.h"/a #include "bruce_stub_decls.h"' mqjs.c

echo "-- final build --"
make mqjs MQJS_OBJS="mqjs.o readline_tty.o readline.o mquickjs.o dtoa.o libm.o cutils.o bruce_stubs.o"

echo
echo "Done: $BUILD/mqjs"
echo "Usage: $BUILD/mqjs /path/to/your/script.js"
