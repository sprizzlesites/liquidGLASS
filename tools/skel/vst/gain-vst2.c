/*
 * gain-vst2.c — minimal, complete VST2.4 gain (volume) effect built against
 * the vendored vestige.h ABI header. Compiles to a real, loadable Linux
 * VST2 .so with a single `make` inside the in-VM Alpine toolchain image
 * (see ../Makefile) — genuinely built on-device, not simulated.
 *
 * Behaviour: multiplies every sample of every channel by a single "gain"
 * parameter (param 0, default 0.5, linear 0..1 maps straight to the
 * multiplier so the default halves volume).
 */
#include <stdlib.h>
#include <string.h>
#include "vestige/vestige.h"

#define PLUGIN_UNIQUE_ID   0x53707a67 /* 'Spzg' -> "Sprizzle gain" */
#define PLUGIN_VERSION     1000       /* 1.0.0.0 */
#define NUM_PARAMS         1
#define NUM_PROGRAMS       1
#define NUM_INPUTS         2
#define NUM_OUTPUTS        2

typedef struct {
    audioMasterCallback hostCallback;
    float gain;              /* 0..1 */
    float sampleRate;
    int32_t blockSize;
    char programName[24];
} GainPlugin;

static GainPlugin* gp_create(audioMasterCallback hostCallback) {
    GainPlugin* p = (GainPlugin*)calloc(1, sizeof(GainPlugin));
    if (!p) return NULL;
    p->hostCallback = hostCallback;
    p->gain = 0.5f;
    p->sampleRate = 44100.0f;
    p->blockSize = 512;
    strncpy(p->programName, "Default", sizeof(p->programName) - 1);
    return p;
}

static void gp_destroy(GainPlugin* p) { free(p); }

/* ---- per-sample processing (processReplacing) ------------------------ */
static void gp_processReplacing(struct AEffect* effect, float** inputs,
                                 float** outputs, int32_t sampleFrames) {
    GainPlugin* p = (GainPlugin*)effect->object;
    int32_t ch, i;
    for (ch = 0; ch < effect->numOutputs; ch++) {
        const float* in = (ch < effect->numInputs) ? inputs[ch] : NULL;
        float* out = outputs[ch];
        if (in) {
            for (i = 0; i < sampleFrames; i++) out[i] = in[i] * p->gain;
        } else {
            for (i = 0; i < sampleFrames; i++) out[i] = 0.0f;
        }
    }
}

static void gp_setParameter(struct AEffect* effect, int32_t index, float value) {
    GainPlugin* p = (GainPlugin*)effect->object;
    if (index == 0) {
        if (value < 0.0f) value = 0.0f;
        if (value > 1.0f) value = 1.0f;
        p->gain = value;
    }
}

static float gp_getParameter(struct AEffect* effect, int32_t index) {
    GainPlugin* p = (GainPlugin*)effect->object;
    return (index == 0) ? p->gain : 0.0f;
}

/* ---- dispatcher: handles the opcodes a minimal effect must answer ----- */
static intptr_t gp_dispatcher(struct AEffect* effect, int32_t opcode,
                               int32_t index, intptr_t value, void* ptr,
                               float opt) {
    GainPlugin* p = (GainPlugin*)effect->object;
    (void)index; (void)value; (void)opt;

    switch (opcode) {
        case effOpen:
            return 0;

        case effClose:
            gp_destroy(p);
            free(effect);
            return 0;

        case effSetProgramName:
            if (ptr) strncpy(p->programName, (const char*)ptr, sizeof(p->programName) - 1);
            return 0;

        case effGetProgramName:
            if (ptr) strncpy((char*)ptr, p->programName, 24);
            return 0;

        case effGetParamName:
            if (ptr && index == 0) strncpy((char*)ptr, "Gain", 8);
            return 0;

        case effGetParamLabel:
            if (ptr) strncpy((char*)ptr, "", 8);
            return 0;

        case effGetParamDisplay:
            if (ptr && index == 0) {
                /* simple 0-100% display */
                int pct = (int)(p->gain * 100.0f + 0.5f);
                char buf[8];
                int n = pct, pos = 0;
                char tmp[8];
                if (n == 0) { tmp[pos++] = '0'; }
                while (n > 0 && pos < 7) { tmp[pos++] = (char)('0' + (n % 10)); n /= 10; }
                {
                    int j;
                    for (j = 0; j < pos; j++) buf[j] = tmp[pos - 1 - j];
                    buf[pos] = '\0';
                }
                strncpy((char*)ptr, buf, 8);
            }
            return 0;

        case effSetSampleRate:
            p->sampleRate = opt;
            return 0;

        case effSetBlockSize:
            p->blockSize = (int32_t)value;
            return 0;

        case effMainsChanged:
            return 0;

        case effEditGetRect:
        case effEditOpen:
        case effEditClose:
        case effEditIdle:
            /* no GUI — hosts fall back to generic parameter sliders */
            return 0;

        case effGetChunk:
        case effSetChunk:
            return 0;

        case effProcessEvents:
            return 1; /* accepted, ignored (no MIDI handling needed for gain) */

        case effCanBeAutomated:
            return 1;

        case effGetInputProperties:
        case effGetOutputProperties:
            return 0;

        case effGetPlugCategory:
            return kPlugCategEffect;

        case effGetEffectName:
            if (ptr) strncpy((char*)ptr, "Sprizzle Gain", 32);
            return 1;

        case effGetVendorString:
            if (ptr) strncpy((char*)ptr, "SprizzleIDE", 64);
            return 1;

        case effGetProductString:
            if (ptr) strncpy((char*)ptr, "Sprizzle Gain VST2", 64);
            return 1;

        case effGetVendorVersion:
            return PLUGIN_VERSION;

        case effCanDo:
            /* We don't implement any of the optional "canDo" strings. */
            return 0;

        case effGetTailSize:
            return 0;

        case effGetVstVersion:
            return kVstVersion;

        default:
            return 0;
    }
}

/* ---- construction: the well-known VST2 entry point -------------------- */
struct AEffect* VSTPluginMain(audioMasterCallback audioMaster) {
    struct AEffect* effect;
    GainPlugin* plugin;

    effect = (struct AEffect*)calloc(1, sizeof(struct AEffect));
    if (!effect) return NULL;

    plugin = gp_create(audioMaster);
    if (!plugin) { free(effect); return NULL; }

    effect->magic = kEffectMagic;
    effect->dispatcher = gp_dispatcher;
    effect->process = NULL; /* deprecated accumulating variant unused */
    effect->setParameter = gp_setParameter;
    effect->getParameter = gp_getParameter;

    effect->numPrograms = NUM_PROGRAMS;
    effect->numParams = NUM_PARAMS;
    effect->numInputs = NUM_INPUTS;
    effect->numOutputs = NUM_OUTPUTS;

    effect->flags = effFlagsCanReplacing;

    effect->initialDelay = 0;
    effect->object = plugin;
    effect->user = NULL;

    effect->uniqueID = PLUGIN_UNIQUE_ID;
    effect->version = PLUGIN_VERSION;

    effect->processReplacing = gp_processReplacing;
    effect->processDoubleReplacing = NULL;

    return effect;
}

/*
 * Some non-Windows VST2 hosts historically look for the symbol "main"
 * instead of "VSTPluginMain" (a legacy quirk of the original Steinberg
 * SDK on Linux/macOS). Export both, aliasing "main" to avoid clashing
 * with a real C `main` (this file has none, so it's safe).
 */
#if !defined(_WIN32) && !defined(WIN32)
struct AEffect* main_plugin(audioMasterCallback audioMaster) asm("main");
struct AEffect* main_plugin(audioMasterCallback audioMaster) {
    return VSTPluginMain(audioMaster);
}
#endif
