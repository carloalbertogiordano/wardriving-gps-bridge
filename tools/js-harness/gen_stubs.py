#!/usr/bin/env python3
"""
Generates bruce_stub_decls.h and bruce_stubs.c from the list of symbols
that Bruce's mqjs_stdlib.c requires and that vanilla mquickjs does not
provide.

Nothing of Bruce is vendored: this works on the output of the first (failed)
build attempt, which lists every missing symbol as an "undeclared here"
error. This script extracts that list and writes the stubs: all of them
return JS_UNDEFINED by default, except the ones listed in REAL_BEHAVIOR
below, hand-written because they are needed to really run the logic of the
Bruce script under test (require(), to_string(), parse_int(), and a handful
of wifi/dialog/storage/serial functions with fake but plausible answers).

Usage: python3 gen_stubs.py <undeclared_symbols.txt> <output_dir>
"""
import sys

REAL_BEHAVIOR = {
    "native_getEscPress": '''static int esc_call_count = 0;
JSValue native_getEscPress(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // simulates ESC pressed after a few rounds, to exercise the clean exit
    // path of the loops - otherwise it would stay false forever and such a
    // test would never end (worth testing that too).
    esc_call_count++;
    return JS_NewBool(esc_call_count > 10);
}''',
    "native_require": '''JSValue native_require(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // real behavior: lookup on the global, exactly like Bruce. Without this
    // require("wifi") would return undefined and every wifi.X would fail
    // for a different reason than the real one.
    if (argc < 1) return JS_UNDEFINED;
    JSCStringBuf name_buf;
    const char *name = JS_ToCString(ctx, argv[0], &name_buf);
    if (!name) return JS_EXCEPTION;
    JSValue global = JS_GetGlobalObject(ctx);
    return JS_GetPropertyStr(ctx, global, name);
}''',
    "native_to_string": '''JSValue native_to_string(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    if (argc > 0) return JS_ToString(ctx, argv[0]);
    return JS_NewString(ctx, "");
}''',
    "native_parse_int": '''JSValue native_parse_int(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // despite the name, Bruce does a generic ToNumber (handles decimals)
    double d = 0;
    if (argc > 0) JS_ToNumber(ctx, &d, argv[0]);
    return JS_NewFloat64(ctx, d);
}''',
    "native_wifiScan": '''JSValue native_wifiScan(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    JSValue arr = JS_NewArray(ctx, 0);
    const char *ssids[] = {"HomeNet", "PhoneHotspot", "NoisyNeighbour"};
    const char *macs[] = {"AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:03"};
    int encs[] = {3, 0, 3};
    for (int i = 0; i < 3; i++) {
        JSValue net = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, net, "SSID", JS_NewString(ctx, ssids[i]));
        JS_SetPropertyStr(ctx, net, "MAC", JS_NewString(ctx, macs[i]));
        JS_SetPropertyStr(ctx, net, "encryptionType", JS_NewString(ctx, encs[i] ? "WPA2_PSK" : "OPEN"));
        JS_SetPropertyStr(ctx, net, "RSSI", JS_NewInt32(ctx, -50 - 10 * i));
        JS_SetPropertyStr(ctx, net, "channel", JS_NewInt32(ctx, 1 + 5 * i));
        JS_SetPropertyUint32(ctx, arr, i, net);
    }
    return arr;
}''',
    "native_wifiConnect": '''JSValue native_wifiConnect(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    return JS_NewBool(1);
}''',
    "native_wifiConnected": '''JSValue native_wifiConnected(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    return JS_NewBool(1);
}''',
    "native_ipAddress": '''JSValue native_ipAddress(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    return JS_NewString(ctx, "192.168.43.25");
}''',
    "native_httpFetch": '''static int fetch_call_count = 0;
static int scan_call_count = 0;
JSValue native_httpFetch(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    fetch_call_count++;
    JSCStringBuf ub;
    const char *url = argc > 0 ? JS_ToCString(ctx, argv[0], &ub) : "";
    JSValue res = JS_NewObject(ctx);
    if (url && strstr(url, "/scan")) {
        // Scripted phone: scan 1 -> no fix yet (503), scans 3-5 -> phone
        // unreachable (exception, like the real httpFetch), the rest -> ok.
        // Exercises the three outcomes and the queue replay in one run.
        scan_call_count++;
        if (scan_call_count >= 3 && scan_call_count <= 5)
            return JS_ThrowInternalError(ctx, "stub: phone unreachable");
        if (scan_call_count == 1) {
            JS_SetPropertyStr(ctx, res, "status", JS_NewInt32(ctx, 503));
            JS_SetPropertyStr(ctx, res, "ok", JS_NewBool(0));
            JS_SetPropertyStr(ctx, res, "body", JS_NewString(ctx, ""));
        } else {
            JS_SetPropertyStr(ctx, res, "status", JS_NewInt32(ctx, 200));
            JS_SetPropertyStr(ctx, res, "ok", JS_NewBool(1));
            JS_SetPropertyStr(ctx, res, "body", JS_NewString(ctx, "ok,3,0,3"));
        }
        printf("[stub] POST scan #%d %s\\n", scan_call_count, url);
        return res;
    }
    // GET /gps (setup check): any answer means the phone is reachable
    JS_SetPropertyStr(ctx, res, "status", JS_NewInt32(ctx, 503));
    JS_SetPropertyStr(ctx, res, "ok", JS_NewBool(0));
    JS_SetPropertyStr(ctx, res, "body", JS_NewString(ctx, ""));
    return res;
}''',
    "native_dialogChoice": '''JSValue native_dialogChoice(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    if (argc > 0) return JS_GetPropertyUint32(ctx, argv[0], 0);
    return JS_NewString(ctx, "");
}''',
    "native_keyboard": '''JSValue native_keyboard(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // empty answer: the same stub serves the password prompt and the phone IP
    // prompt, and an empty IP means "accept the suggested one".
    return JS_NewString(ctx, "");
}''',
    "native_storageRead": '''#define STUB_FILES 6
static char stub_paths[STUB_FILES][96];
static char *stub_data[STUB_FILES];
static int stub_slot(JSContext *ctx, JSValue arg, int create) {
    // accepts "path" or { fs, path }; the fs is ignored, one namespace is enough
    JSCStringBuf pb;
    JSValue pv = JS_IsString(ctx, arg) ? arg : JS_GetPropertyStr(ctx, arg, "path");
    const char *path = JS_ToCString(ctx, pv, &pb);
    if (!path) return -1;
    int free_slot = -1;
    for (int i = 0; i < STUB_FILES; i++) {
        if (stub_data[i] && strcmp(stub_paths[i], path) == 0) return i;
        if (!stub_data[i] && free_slot < 0) free_slot = i;
    }
    if (!create || free_slot < 0) return -1;
    strncpy(stub_paths[free_slot], path, sizeof(stub_paths[0]) - 1);
    stub_data[free_slot] = strdup("");
    return free_slot;
}
JSValue native_storageRead(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // in-memory files: "no config yet" on the first run, real content after
    // a write (the real storage.read throws when the file does not exist)
    int i = argc > 0 ? stub_slot(ctx, argv[0], 0) : -1;
    if (i < 0) return JS_ThrowTypeError(ctx, "storageRead: File does not exist (stub)");
    return JS_NewString(ctx, stub_data[i]);
}''',
    "native_storageWrite": '''JSValue native_storageWrite(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    int i = argc > 1 ? stub_slot(ctx, argv[0], 1) : -1;
    if (i < 0) return JS_NewBool(0);
    JSCStringBuf db, mb;
    const char *data = JS_ToCString(ctx, argv[1], &db);
    const char *mode = argc > 2 ? JS_ToCString(ctx, argv[2], &mb) : "append";
    if (!data) return JS_NewBool(0);
    if (mode && mode[0] == 'w') {
        free(stub_data[i]);
        stub_data[i] = strdup(data);
    } else {
        size_t n = strlen(stub_data[i]) + strlen(data) + 1;
        char *joined = malloc(n);
        strcpy(joined, stub_data[i]);
        strcat(joined, data);
        free(stub_data[i]);
        stub_data[i] = joined;
    }
    return JS_NewBool(1);
}''',
    "native_storageRemove": '''JSValue native_storageRemove(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    int i = argc > 0 ? stub_slot(ctx, argv[0], 0) : -1;
    if (i < 0) return JS_ThrowTypeError(ctx, "storageRemove: File does not exist (stub)");
    free(stub_data[i]);
    stub_data[i] = NULL;
    return JS_NewBool(1);
}''',
    "native_now": '''JSValue native_now(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // fake millis since boot: advances 2.5 s per call so ages are non-zero
    static double t = 100000;
    t += 2500;
    return JS_NewFloat64(ctx, t);
}''',
    "native_storageSpaceSDCard": '''JSValue native_storageSpaceSDCard(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "total", JS_NewUint32(ctx, 8 * 1024 * 1024));
    JS_SetPropertyStr(ctx, obj, "used", JS_NewUint32(ctx, 1024));
    JS_SetPropertyStr(ctx, obj, "free", JS_NewUint32(ctx, 8 * 1024 * 1024 - 1024));
    return obj;
}''',
    "native_storageSpaceLittleFS": '''JSValue native_storageSpaceLittleFS(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "total", JS_NewUint32(ctx, 1400));
    JS_SetPropertyStr(ctx, obj, "used", JS_NewUint32(ctx, 200));
    JS_SetPropertyStr(ctx, obj, "free", JS_NewUint32(ctx, 1200));
    return obj;
}''',
    "native_serialPrintln": '''JSValue native_serialPrintln(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    for (int i = 0; i < argc; i++) {
        JSCStringBuf sb;
        const char *s = JS_ToCString(ctx, argv[i], &sb);
        if (s) printf("%s", s);
    }
    printf("\\n");
    return JS_UNDEFINED;
}''',
}


def main():
    symbols_file, out_dir = sys.argv[1], sys.argv[2]
    names = [l.strip() for l in open(symbols_file) if l.strip()]
    classes = [n for n in names if n.startswith("JS_CLASS")]
    funcs = [n for n in names if not n.startswith("JS_CLASS")]
    finalizers = [n for n in funcs if n.endswith("_finalizer")]
    normal = [n for n in funcs if not n.endswith("_finalizer")]

    with open(f"{out_dir}/bruce_stub_decls.h", "w") as f:
        f.write("#ifndef __BRUCE_STUB_DECLS_H__\n#define __BRUCE_STUB_DECLS_H__\n")
        for n in normal:
            f.write(f"JSValue {n}(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv);\n")
        for n in finalizers:
            f.write(f"void {n}(JSContext *ctx, void *opaque);\n")
        f.write("#endif\n")

    with open(f"{out_dir}/bruce_stubs.c", "w") as f:
        f.write(
            "// Generated by gen_stubs.py - not Bruce code, just stubs to link the\n"
            "// symbols required by its real mqjs_stdlib table.\n"
            "#include <stddef.h>\n#include <inttypes.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n"
            '#include "mquickjs.h"\n#include "mquickjs_build.h"\n\n'
        )
        for n in normal:
            if n in REAL_BEHAVIOR:
                f.write(REAL_BEHAVIOR[n] + "\n")
            else:
                f.write(f"JSValue {n}(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {{ return JS_UNDEFINED; }}\n")
        f.write("\n")
        for n in finalizers:
            f.write(f"void {n}(JSContext *ctx, void *opaque) {{ (void)ctx; (void)opaque; }}\n")

    print(f"generated: {len(normal)} functions ({len(REAL_BEHAVIOR)} with real behavior), "
          f"{len(finalizers)} finalizers, {len(classes)} class macros (already from user_classes_js.h)")


if __name__ == "__main__":
    main()
