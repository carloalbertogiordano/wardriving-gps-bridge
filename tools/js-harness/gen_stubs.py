#!/usr/bin/env python3
"""
Genera bruce_stub_decls.h e bruce_stubs.c a partire dalla lista di simboli
che mqjs_stdlib.c di Bruce richiede e che mquickjs (vanilla) non fornisce.

Non vendorizza niente di Bruce: lavora sull'output del primo tentativo di
build (fallito), che elenca ogni simbolo mancante come errore "undeclared
here". Questo script estrae quella lista e scrive gli stub: tutti
ritornano JS_UNDEFINED di default, tranne quelli listati in REAL_BEHAVIOR
qui sotto, scritti a mano perche' servono a far girare davvero la logica
dello script Bruce sotto test (require(), to_string(), parse_int(), e un
pugno di funzioni wifi/dialog/storage/serial con risposte finte ma
plausibili).

Uso: python3 gen_stubs.py <undeclared_symbols.txt> <output_dir>
"""
import sys

REAL_BEHAVIOR = {
    "native_require": '''JSValue native_require(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // comportamento reale: lookup sulla global, esattamente come in Bruce.
    // Senza questo require("wifi") ritornerebbe undefined e ogni wifi.X
    // fallirebbe per un motivo diverso da quello vero.
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
    // nonostante il nome, Bruce fa una ToNumber generica (gestisce i decimali)
    double d = 0;
    if (argc > 0) JS_ToNumber(ctx, &d, argv[0]);
    return JS_NewFloat64(ctx, d);
}''',
    "native_wifiScan": '''JSValue native_wifiScan(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    JSValue arr = JS_NewArray(ctx, 0);
    const char *ssids[] = {"CasaMia", "TelefonoDiCarlo", "VicinoFastidioso"};
    const char *macs[] = {"AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:03"};
    int encs[] = {3, 0, 3};
    for (int i = 0; i < 3; i++) {
        JSValue net = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, net, "SSID", JS_NewString(ctx, ssids[i]));
        JS_SetPropertyStr(ctx, net, "MAC", JS_NewString(ctx, macs[i]));
        JS_SetPropertyStr(ctx, net, "encryptionType", JS_NewInt32(ctx, encs[i]));
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
JSValue native_httpFetch(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    fetch_call_count++;
    JSValue res = JS_NewObject(ctx);
    // prima chiamata 503 (nessun fix), dalla seconda in poi 200 con un fix
    // finto, per esercitare sia il path "non pronto" sia il parsing vero.
    if (fetch_call_count == 1) {
        JS_SetPropertyStr(ctx, res, "status", JS_NewInt32(ctx, 503));
        JS_SetPropertyStr(ctx, res, "ok", JS_NewBool(0));
        JS_SetPropertyStr(ctx, res, "body", JS_NewString(ctx, ""));
    } else {
        JS_SetPropertyStr(ctx, res, "status", JS_NewInt32(ctx, 200));
        JS_SetPropertyStr(ctx, res, "ok", JS_NewBool(1));
        JS_SetPropertyStr(ctx, res, "body", JS_NewString(ctx, "45.464200,9.191400,8,1729690000000,1500"));
    }
    return res;
}''',
    "native_dialogChoice": '''JSValue native_dialogChoice(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    if (argc > 0) return JS_GetPropertyUint32(ctx, argv[0], 0);
    return JS_NewString(ctx, "");
}''',
    "native_keyboard": '''JSValue native_keyboard(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    return JS_NewString(ctx, "password_finta_123");
}''',
    "native_storageRead": '''JSValue native_storageRead(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    // simula 'nessuna config salvata ancora' (il vero storage.read lancia)
    return JS_ThrowTypeError(ctx, "storageRead: File does not exist (stub)");
}''',
    "native_storageWrite": '''JSValue native_storageWrite(JSContext *ctx, JSValue *this_val, int argc, JSValue *argv) {
    return JS_NewBool(1);
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
            "// Generato da gen_stubs.py - non e' codice di Bruce, solo stub per\n"
            "// collegare i simboli richiesti dalla sua tabella mqjs_stdlib reale.\n"
            "#include <stddef.h>\n#include <inttypes.h>\n#include <stdio.h>\n"
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

    print(f"generati: {len(normal)} funzioni ({len(REAL_BEHAVIOR)} con comportamento vero), "
          f"{len(finalizers)} finalizer, {len(classes)} macro classe (gia' da user_classes_js.h)")


if __name__ == "__main__":
    main()
