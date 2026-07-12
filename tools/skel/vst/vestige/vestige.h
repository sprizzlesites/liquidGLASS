/*
 * vestige.h — minimal, from-scratch reimplementation of the classic VST 2.4
 * plugin ABI, in the spirit of the well-known "vestige" single-header
 * projects used by open-source hosts/plugins to interoperate with the VST2
 * binary interface without depending on Steinberg's proprietary SDK headers
 * (the ABI/wire format itself is not copyrightable; only Steinberg's SDK
 * source text is). This is a from-scratch rewrite, not a copy of any
 * particular vestige.h distribution.
 *
 * Scope: just enough of the ABI to build a real, loadable VST2 effect
 * (non-synth) plugin — a gain/volume processor is the sample use case
 * (see ../gain-vst2.c). Not a complete VST2 SDK replacement.
 *
 * Baked into the in-VM Alpine toolchain image (see Agent D's
 * tools/build-image/ tree) so `make` inside the browser VM produces a real
 * ELF .so — a genuine, if minimal, in-IDE plugin compile.
 */
#ifndef VESTIGE_H
#define VESTIGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- magic / version ---------------------------------------------- */
#define kEffectMagic 0x56737450 /* 'VstP' */
#define kVstVersion  2400

struct AEffect;

/* ---- host -> plugin & plugin -> host callback signatures ----------- */
typedef intptr_t (*audioMasterCallback)(struct AEffect* effect, int32_t opcode,
                                         int32_t index, intptr_t value,
                                         void* ptr, float opt);

typedef intptr_t (*AEffectDispatcherProc)(struct AEffect* effect, int32_t opcode,
                                           int32_t index, intptr_t value,
                                           void* ptr, float opt);
typedef void (*AEffectProcessProc)(struct AEffect* effect, float** inputs,
                                    float** outputs, int32_t sampleFrames);
typedef void (*AEffectProcessDoubleProc)(struct AEffect* effect, double** inputs,
                                          double** outputs, int32_t sampleFrames);
typedef void (*AEffectSetParameterProc)(struct AEffect* effect, int32_t index,
                                         float parameter);
typedef float (*AEffectGetParameterProc)(struct AEffect* effect, int32_t index);

/* ---- flags (subset) -------------------------------------------------- */
enum {
    effFlagsHasEditor      = 1 << 0,
    effFlagsCanReplacing   = 1 << 4,
    effFlagsProgramChunks  = 1 << 5,
    effFlagsIsSynth        = 1 << 8,
    effFlagsNoSoundInStop  = 1 << 9,
    effFlagsCanDoubleReplacing = 1 << 12
};

/* ---- the plugin instance struct (matches the classic VST2.4 layout) -- */
struct AEffect {
    int32_t magic;                 /* kEffectMagic */
    AEffectDispatcherProc dispatcher;
    AEffectProcessProc process;    /* deprecated accumulating process, unused here */
    AEffectSetParameterProc setParameter;
    AEffectGetParameterProc getParameter;

    int32_t numPrograms;
    int32_t numParams;
    int32_t numInputs;
    int32_t numOutputs;

    int32_t flags;

    intptr_t resvd1;               /* host use only */
    intptr_t resvd2;               /* host use only */

    int32_t initialDelay;

    int32_t realQualities;         /* unused historically */
    int32_t offQualities;          /* unused historically */
    float   ioRatio;               /* unused historically */

    void* object;                  /* plugin's private data pointer */
    void* user;                    /* user-usable pointer */

    int32_t uniqueID;              /* 4-char plugin identifier */
    int32_t version;

    AEffectProcessProc processReplacing;
    AEffectProcessDoubleProc processDoubleReplacing;

    char future[56];               /* reserved, must be zeroed */
};

/* ---- effect opcodes (subset needed for open/close + a simple effect) - */
enum AEffectOpcodes {
    effOpen = 0,
    effClose,
    effSetProgram,
    effGetProgram,
    effSetProgramName,
    effGetProgramName,
    effGetParamLabel,
    effGetParamDisplay,
    effGetParamName,
    effGetVu,                 /* deprecated */
    effSetSampleRate,         /* 10 */
    effSetBlockSize,
    effMainsChanged,
    effEditGetRect,
    effEditOpen,
    effEditClose,
    effEditDraw,              /* deprecated */
    effEditMouse,             /* deprecated */
    effEditKey,               /* deprecated */
    effEditIdle,
    effEditTop,               /* deprecated, 20 */
    effEditSleep,             /* deprecated */
    effIdentify,              /* deprecated */
    effGetChunk,
    effSetChunk,
    effProcessEvents,
    effCanBeAutomated,
    effString2Parameter,
    effGetNumProgramCategories, /* deprecated */
    effGetProgramNameIndexed,
    effCopyProgram,           /* deprecated, 30 */
    effConnectInput,          /* deprecated */
    effConnectOutput,         /* deprecated */
    effGetInputProperties,
    effGetOutputProperties,
    effGetPlugCategory,
    effGetCurrentPosition,    /* deprecated */
    effGetDestinationBuffer,  /* deprecated */
    effOfflineNotify,
    effOfflinePrepare,
    effOfflineRun,            /* 40 */
    effProcessVarIo,
    effSetSpeakerArrangement,
    effSetBlockSizeAndSampleRate, /* deprecated */
    effSetBypass,
    effGetEffectName,
    effGetErrorText,          /* deprecated */
    effGetVendorString,
    effGetProductString,
    effGetVendorVersion,
    effVendorSpecific,        /* 50 */
    effCanDo,
    effGetTailSize,
    effIdle,                  /* deprecated */
    effGetIcon,               /* deprecated */
    effSetViewPosition,       /* deprecated */
    effGetParameterProperties,
    effKeysRequired,          /* deprecated */
    effGetVstVersion,
    effEditKeyDown,
    effEditKeyUp,             /* 60 */
    effSetEditKnobMode,
    effGetMidiProgramName,
    effGetCurrentMidiProgram,
    effGetMidiProgramCategory,
    effHasMidiProgramsChanged,
    effGetMidiKeyName,
    effBeginSetProgram,
    effEndSetProgram,
    effGetSpeakerArrangement,
    effShellGetNextPlugin,    /* 70 */
    effStartProcess,
    effStopProcess,
    effSetTotalSampleToProcess,
    effSetPanLaw,
    effBeginLoadBank,
    effBeginLoadProgram,
    effSetProcessPrecision,
    effGetNumMidiInputChannels,
    effGetNumMidiOutputChannels
};

/* Plug categories (subset) used by effGetPlugCategory. */
enum VstPlugCategory {
    kPlugCategUnknown = 0,
    kPlugCategEffect,
    kPlugCategSynth,
    kPlugCategAnalysis,
    kPlugCategMastering,
    kPlugCategSpacializer,
    kPlugCategRoomFx,
    kPlugSurroundFx,
    kPlugCategRestoration,
    kPlugCategOfflineProcess,
    kPlugCategShell,
    kPlugCategGenerator
};

/* ---- minimal MIDI event plumbing (effProcessEvents) ------------------ */
enum VstEventTypes { kVstMidiType = 1, kVstAudioType, kVstVideoType,
                      kVstParameterType, kVstTriggerType, kVstSysExType };

struct VstEvent {
    int32_t type;
    int32_t byteSize;
    int32_t deltaFrames;
    int32_t flags;
    char    data[16];
};

struct VstMidiEvent {
    int32_t type;
    int32_t byteSize;
    int32_t deltaFrames;
    int32_t flags;
    int32_t noteLength;
    int32_t noteOffset;
    char    midiData[4];
    char    detune;
    char    noteOffVelocity;
    char    reserved1;
    char    reserved2;
};

struct VstEvents {
    int32_t numEvents;
    intptr_t reserved;
    struct VstEvent* events[2]; /* variable-length in real hosts; 2 is the
                                   minimum placeholder array size used by
                                   the original SDK headers too. */
};

/* ---- the well-known plugin entry point symbol ------------------------ */
typedef struct AEffect* (*vstPluginMain)(audioMasterCallback audioMaster);

#ifdef __cplusplus
}
#endif

#endif /* VESTIGE_H */
