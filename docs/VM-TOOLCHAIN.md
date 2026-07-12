# VM Toolchain — what you can build & run inside SprizzleIDE's VM tab

This document describes the real, in-browser Linux toolchain that boots
inside the "VM" panel (v86 emulator, see `docs/ORCHESTRATION.md` for the
overall architecture). It is written for end users of the IDE and assumes
the VM tab has already booted in **linux9p** mode (real Alpine Linux — see
"Boot modes" below).

## Boot modes: real toolchain vs. offline fallback

The VM tab reads `vm/image/manifest.json` to decide what to boot:

- **`linux9p`** — the real Alpine Linux i686 toolchain image described in
  this document (gcc, nasm, binutils, make, bash, a VST2 sample project).
  Built by `.github/workflows/build-vm-image.yml` (see below); only exists
  once that workflow has run successfully at least once on this branch.
- **`floppy`** (fallback) — `vm/image/testos.img`, a tiny hand-assembled
  test OS that only proves the terminal/serial pipeline works. **No
  compilers, no shell utilities.** If you see this, the linux9p image
  hasn't been built yet (or its assets 404'd) — see "Building the image"
  below, or check the Actions tab for the latest `Build VM Toolchain Image`
  run.

Everything below assumes `linux9p` mode.

## Building the image (maintainers only)

The image **cannot be built from a local dev sandbox that blocks the
Alpine CDN** — `apk add` needs `dl-cdn.alpinelinux.org`. It is built by
GitHub Actions instead:

- Workflow: `.github/workflows/build-vm-image.yml`
- Triggers: manual (`workflow_dispatch`) or automatically on push to
  `tools/build-image/**` on the `fullterminal` branch.
- What it does: `tools/build-image/build.sh` builds a `docker run
  --platform linux/386 i386/alpine:3.19` rootfs with the toolchain baked
  in, exports it, and converts it into v86's 9p filesystem format
  (`vm/image/alpine-fs.json` + `vm/image/alpine-rootfs-flat/`) using the
  **official v86 project's own conversion scripts**
  (`tools/fs2json.py` / `tools/copy-to-sha256.py`, cloned fresh from
  `github.com/copy/v86` at build time — not vendored in this repo).
  `tests/vm/boot-linux-smoke.mjs` then boots the freshly built image
  **headlessly in Node** (no browser needed) and drives a real
  compile-and-run session over the emulated serial console before the
  image is trusted/published. If that smoke test fails, nothing is
  published and the VM tab keeps using the floppy fallback.
- Publishing: if the built assets are small enough, they're committed
  directly to `vm/image/` on this same branch (commit message contains
  `[skip ci]`). If the 9p chunk directory is too large for git, it's
  instead packed into a single `alpine-rootfs.tar.zst` file attached to the
  `vm-image-latest` GitHub Release, and `vm/image/manifest.json` is marked
  `"mode": "linux9p-packed"` with a `notes` field explaining that vmterm.js
  needs to fetch+unpack that asset before booting (see the workflow file
  for the exact logic).
- To build locally (needs Docker + open network): `tools/build-image/build.sh`
  followed by `node tests/vm/boot-linux-smoke.mjs`.

Run `node tests/vm/boot-testos.mjs` any time to confirm the floppy fallback
path itself (proven working, no network required) is still intact.

## C programs

```sh
# inside the VM shell (autologin as root over serial)
cat > hello.c <<'EOF'
#include <stdio.h>
int main(void) { printf("hello from the VM\n"); return 0; }
EOF
gcc hello.c -o hello
./hello
```

This is `gcc`/`musl-dev` targeting i686 (the only architecture v86 can
execute) — a genuine compile in a genuine (emulated) Linux kernel, not a
simulation.

## Assembly — 32-bit (assemble, link, AND run — all in-VM)

```sh
cat > hello32.asm <<'EOF'
    global _start
    section .text
_start:
    mov eax, 1          ; sys_write
    mov ebx, 1          ; fd 1 (stdout)
    mov ecx, msg
    mov edx, msg_len
    int 0x80
    mov eax, 1          ; sys_exit
    xor ebx, ebx
    int 0x80
    section .data
msg:     db "hello from nasm (32-bit)", 10
msg_len: equ $ - msg
EOF
nasm -f elf32 hello32.asm -o hello32.o
ld -m elf_i386 hello32.o -o hello32
./hello32
```

32-bit assembly is the one path that is genuinely assembled, linked, AND
**executed** entirely client-side, because v86 is an x86 (32-bit-capable)
emulator.

## Assembly — 64-bit (assemble in-VM; link + run via the cloud workflow)

**v86 emulates a 32-bit-capable x86 CPU — it cannot execute 64-bit (long
mode) machine code. This is a hard limit of the emulator, not a missing
feature.** `nasm` itself is architecture-agnostic and happily assembles
64-bit object files on the i686 guest:

```sh
cat > hello64.asm <<'EOF'
    bits 64
    global _start
    section .text
_start:
    mov rax, 1          ; sys_write
    mov rdi, 1
    mov rsi, msg
    mov rdx, msg_len
    syscall
    mov rax, 60         ; sys_exit
    xor rdi, rdi
    syscall
    section .data
msg:     db "hello from nasm (64-bit)", 10
msg_len: equ $ - msg
EOF
nasm -f elf64 hello64.asm -o hello64.o
```

That `.o` file is a real ELF64 object. Whether you can **link** it
in-VM too depends on whether Alpine's `binutils` build on this image
includes the `elf_x86_64` linker emulation — check
`vm/image/manifest.json` → `caps.ld64`:

- `caps.ld64 == true`: `ld -m elf_x86_64 hello64.o -o hello64` works
  in-VM, producing a real 64-bit ELF executable — but **running it must
  still happen outside v86** (see below).
- `caps.ld64 == false`: link the object file elsewhere (see below); the
  assemble step above still works regardless.

**Running 64-bit output**: this always requires leaving the browser-VM
sandbox — either download the `.o`/executable and run it on your own
64-bit machine, or use a GitHub Actions workflow (the same cloud-build
mechanism used for VST3, see below) to link + execute it and report the
result back. There is no way to execute 64-bit machine code inside v86
itself; a future in-browser 64-bit usermode emulator (e.g. something
blink-like) is noted in `docs/ORCHESTRATION.md` as a stretch goal, not
implemented here.

## VST plugins

Two honest, separately-scoped paths (see `docs/ORCHESTRATION.md` section 2
for the full rationale):

### (a) In-VM VST2 sample — real binary, Linux-only, 32-bit

The image ships a minimal VST2 sample plugin skeleton at
`/root/skel/vst` (vendored from `tools/skel/vst/**` in this repo — the
`vestige.h` single-header VST2 ABI reimplementation plus a `gain-vst2.c`
sample and a `Makefile`):

```sh
cd /root/skel/vst
make
# produces gain.so (a real, loadable Linux VST2 plugin binary, i686)
```

Check `vm/image/manifest.json` → `caps.vst2` to see whether this build
succeeded on the currently published image (it is compiled as part of the
CI boot smoke test, before publishing). **This `.so` only loads in a
Linux, 32-bit-capable VST2 host** — it is not something you can drop into
a macOS/Windows DAW. Download it via the VM's "⬆ Pull from VM" sync and
treat it as a proof-of-concept / Linux-only build artifact.

### (b) "VST3 Cloud Build" — real Win/macOS/Linux binaries, built off-device

For a plugin you can actually load in your real DAW, use the **VST3 Cloud
Build** menu item (Run menu → "VST Cloud Build…", implemented in
`vst/vstcloud.js`). It writes a JUCE/CMake project + a GitHub Actions
workflow into your project, builds real VST3 binaries for Windows/macOS/
Linux on GitHub's runners, and lets you download the results from a
Release. **This is the only path that produces a VST3 (or a non-Linux
VST2) binary** — nothing client-side in a browser tab can cross-compile or
codesign for macOS/Windows.

## Adding packages — the image is OFFLINE

**The VM has no network access by default** (v86's network device is not
wired up in this build — see `docs/ORCHESTRATION.md` section 2 "Locked
architecture" and the upstream `docs/networking.md` this project
deliberately does not enable). `apk add <anything>` inside the VM will fail
with a DNS/connection error — this is expected, not a bug.

What's preinstalled (see `tools/build-image/Dockerfile` for the exact
`apk add` list):

- `alpine-base`, `openrc`, `agetty`, `alpine-conf` — boot/init/login
- `linux-virt` + generated initramfs — the kernel itself
- `bash`, `busybox-extras` — shell + extra userland utilities
- `gcc`, `musl-dev`, `make` — C toolchain
- `nasm`, `binutils` — assembler + linker/binutils

If you need another package, you have two options, in order of
preference:
1. **Extend the image**: edit `tools/build-image/Dockerfile`'s `apk add`
   line and push to `tools/build-image/**` on this branch — the CI
   workflow rebuilds and republishes automatically (see "Building the
   image" above). This is the supported path since the runner has open
   network at build time.
2. **Bring your own offline `.apk` files**: not implemented in this image.
   If this becomes a common need, the standard Alpine offline-install
   pattern is `apk add --no-network --repositories-file /dev/null
   /path/to/*.apk` against locally-present `.apk` files — a future
   iteration could ship a small local mirror of the ~20 most-requested
   `-dev` packages inside the image for this, sized against the same
   git-friendliness budget documented in the build workflow. Not done
   here to keep the first image build small and simple; open a follow-up
   if you hit this wall.

**Future networking**: real outbound networking from inside the VM (e.g.
via a WISP/relay websocket proxy, which v86 supports upstream — see
`network_relay_url` in `docs/networking.md` on the v86 project) is **not
included** in this build. It's a plausible follow-up, not a promise.

## Where these numbers/paths come from

`vm/image/manifest.json` (generated by `tests/vm/boot-linux-smoke.mjs`,
committed by the CI workflow) is the single source of truth for exactly
which image is currently live, its boot `cmdline`, and the `caps.ld64` /
`caps.vst2` flags referenced above. If something in this document and the
manifest disagree, trust the manifest — it's regenerated every successful
build, this file is hand-maintained.
