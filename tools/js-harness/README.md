# JS harness for Bruce

A standalone `mquickjs` interpreter that really knows the names/arities of
Bruce's APIs (`wifi`, `dialog`, `storage`, `keyboard`, `serial`, `parse_int`,
`require`, ...) for a specific firmware version — not a generic JS engine. It
finds the real `TypeError: not a function` before you load the script onto
the T-Embed.

## Why it is needed

`require()` returns objects whose method names/arities are decided by the exact
firmware version — the main branch on GitHub does not always match what you
flashed (e.g. `wifi.ipAddress()` on main vs `wifi.getIPAddress()` on 1.16.1, or
bare `keyboard()`, which does not exist on 1.16.1, only `dialog.prompt()`). The
only way to know for sure is to read the real table of the installed version —
or to actually run the script on top of it.

## How to use it

```bash
# find the installed version: T-Embed WebUI -> /systeminfo
# (needs login, see the credentials you configured)

./build.sh 1.16.1          # builds ./build/mqjs for that version
./build/mqjs ../../bruce/wardrive.js
```

The first argument of `build.sh` is the Bruce tag to use (default `1.16.1`); it
must exist at https://github.com/pr3y/Bruce/tags.

## What it finds and what it does not

**Finds**: syntax errors, wrong names/arities (`dialog.error` vs
`dialog.err`), `require()` of non-existent modules, broken logic in your code
(undefined variables, obvious infinite loops, duplicate `catch` variable names
in one function, ...) — everything the real engine rejects at parse or run
time.

**Does not find**: anything that depends on real hardware (screen, GPS, SD, real
Wi-Fi) — `wifi.scan()`, `wifi.httpFetch()`, `storage.read/write`,
`dialog.choice`, `keyboard`/`dialog.prompt` return fake but plausible data (see
`gen_stubs.py`, `REAL_BEHAVIOR` section), not what would really happen on your
hotspot/SD. A real test on the T-Embed is still needed for that.

With the current stubs `./build/mqjs ../../bruce/wardrive.js` goes through the
whole script: setup wizard, config, the scan/log loop and the dedup (the first
round logs three networks, the following ones none), until the simulated ESC.

## How it works (no Bruce code vendored)

`build.sh` downloads `mqjs_stdlib.c` (the API table) for the Bruce version you
name, fresh every time in `build/` (git-ignored — Bruce is AGPL-3.0, we do not
keep it in our repo). The first build attempt fails on purpose: from the list of
missing symbols, `gen_stubs.py` (this one is ours) generates the stubs that
make the link succeed. Final build, done.

If Bruce renames the APIs again in a future version, just run
`./build.sh <new_version>` — no manual maintenance of the symbol list, it
regenerates itself.
