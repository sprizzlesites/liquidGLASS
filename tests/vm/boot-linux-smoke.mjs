// tests/vm/boot-linux-smoke.mjs
//
// Node harness that headlessly boots the Alpine i686 "linux9p" toolchain
// image under the vendored v86 engine, drives a real compile+run session
// over the serial console, and (on success) writes vm/image/manifest.json
// describing what was proven to work.
//
// Run standalone once the image assets exist (built by
// tools/build-image/build.sh, which needs Docker + network and therefore
// only runs in CI -- see .github/workflows/build-vm-image.yml):
//
//   node tests/vm/boot-linux-smoke.mjs
//
// Exit code 0 = all HARD requirements passed (booted to an autologin root
// shell, gcc and nasm are present, a compiled C program returns the
// expected exit code, and nasm can assemble 64-bit object files -- i.e. the
// core "asm32 native execution + toolchain presence" path). Exit code
// non-zero = a hard requirement failed; see stderr for the accumulated
// serial transcript.
//
// Two capabilities are recorded but do NOT cause a hard failure, because
// whether they work depends on things outside this image build's control
// (Alpine's binutils x86_64 emulation support, and a sibling agent
// workstream's tools/skel/vst/** landing on this branch):
//   caps.ld64  - whether `ld -m elf_x86_64` is available (link, not execute
//                -- v86 can never *run* 64-bit code, that's a hard emulator
//                limit, see docs/ORCHESTRATION.md section 5)
//   caps.vst2  - whether the VST2 sample plugin in /root/skel/vst builds
//
// CI-ONLY ASSUMPTION: this script is written to be runnable both in CI
// (paths default to the repo's real vm/image/* build outputs) and locally
// by a developer who has run tools/build-image/build.sh themselves. All
// tunables are overridable via environment variables so the calling
// workflow step can be explicit about paths without editing this file.
import { V86 } from '../../vm/vendor/libv86.mjs';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = url.fileURLToPath(new URL('../../', import.meta.url));
const resolve = (p) => path.isAbsolute(p) ? p : path.join(root, p);

// --- configuration (env-overridable) -------------------------------------
const BZIMAGE = resolve(process.env.VM_BZIMAGE || 'vm/image/bzimage.bin');
const INITRD = resolve(process.env.VM_INITRD || 'vm/image/initramfs.img');
const FSJSON = resolve(process.env.VM_FSJSON || 'vm/image/alpine-fs.json');
let BASEFS = resolve(process.env.VM_BASEFS || 'vm/image/alpine-rootfs-flat/');
if (!BASEFS.endsWith('/')) BASEFS += '/';
const CMDLINE = process.env.VM_CMDLINE ||
  'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose init=/sbin/init console=ttyS0 modules=virtio_pci tsc=reliable';
const PROMPT_REGEX = new RegExp(process.env.VM_PROMPT_REGEX || 'localhost:~#');
const BOOT_TIMEOUT_MS = Number(process.env.VM_BOOT_TIMEOUT_MS || 180000);
const CMD_TIMEOUT_MS = Number(process.env.VM_CMD_TIMEOUT_MS || 180000);
const MEMORY_MB = Number(process.env.VM_MEMORY_MB || 512);
const MANIFEST_PATH = resolve(process.env.VM_MANIFEST || 'vm/image/manifest.json');
const FALLBACK_IMG = 'vm/image/testos.img'; // relative path recorded in the manifest, not resolved

const DONE_MARKER = `SPRZ_SMOKE_DONE_${process.pid}`;

// --- preflight: assets must exist (they're built by CI, not this repo) ---
for (const [name, p] of [
  ['bzimage', BZIMAGE], ['initrd', INITRD], ['fsjson', FSJSON],
]) {
  if (!fs.existsSync(p)) {
    console.error(`FAIL: missing required asset for '${name}': ${p}`);
    console.error('This image is built by tools/build-image/build.sh (Docker + network required,');
    console.error('so normally only runs inside .github/workflows/build-vm-image.yml). Run that');
    console.error('script first if you are trying this locally.');
    process.exit(1);
  }
}
if (!fs.existsSync(BASEFS) || !fs.statSync(BASEFS).isDirectory()) {
  console.error(`FAIL: missing required asset directory 'basefs': ${BASEFS}`);
  process.exit(1);
}

const buf = (p) => fs.readFileSync(p).buffer;

console.log('booting linux9p image:');
console.log('  bzimage:', BZIMAGE);
console.log('  initrd: ', INITRD);
console.log('  fsjson: ', FSJSON);
console.log('  basefs: ', BASEFS);
console.log('  cmdline:', CMDLINE);

const emulator = new V86({
  wasm_path: path.join(root, 'vm/vendor/v86.wasm'),
  bios: { buffer: buf(path.join(root, 'vm/vendor/seabios.bin')) },
  vga_bios: { buffer: buf(path.join(root, 'vm/vendor/vgabios.bin')) },
  bzimage: { buffer: buf(BZIMAGE) },
  initrd: { buffer: buf(INITRD) },
  cmdline: CMDLINE,
  filesystem: { baseurl: BASEFS, basefs: FSJSON },
  memory_size: MEMORY_MB * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
});

let out = '';
let promptSeen = false;
let cmdSentAt = -1;
let finished = false;

function fail(msg) {
  if (finished) return;
  finished = true;
  console.error(`FAIL: ${msg}`);
  console.error('--- accumulated serial transcript ---');
  console.error(out);
  console.error('--- end transcript ---');
  try { emulator.destroy(); } catch { /* best-effort */ }
  process.exit(1);
}

const bootDeadline = setTimeout(() => {
  fail(`timed out after ${BOOT_TIMEOUT_MS}ms waiting for autologin prompt matching ${PROMPT_REGEX}`);
}, BOOT_TIMEOUT_MS);

let cmdDeadlineTimer = null;

const COMMAND_SCRIPT = [
  'gcc --version',
  'nasm -v',
  "printf 'int main(){return 42;}' > t.c && gcc t.c -o t && ./t; echo RC=$?",
  "printf 'bits 64\\nmov rax,60\\nxor rdi,rdi\\nsyscall' > t64.asm && nasm -f elf64 t64.asm -o t64.o && echo A64=OK",
  'ld -m elf_x86_64 --version >/dev/null 2>&1 && echo LD64=YES || echo LD64=NO',
  'cd /root/skel/vst && make && echo VST2=OK',
  `echo ${DONE_MARKER}`,
].join('; ');

emulator.add_listener('serial0-output-byte', (byte) => {
  out += String.fromCharCode(byte);

  if (!promptSeen && PROMPT_REGEX.test(out)) {
    promptSeen = true;
    clearTimeout(bootDeadline);
    console.log('autologin prompt reached; driving compile/run session');
    cmdSentAt = out.length;
    emulator.serial0_send(COMMAND_SCRIPT + '\n');
    cmdDeadlineTimer = setTimeout(() => {
      fail(`timed out after ${CMD_TIMEOUT_MS}ms waiting for ${DONE_MARKER} (command script did not finish)`);
    }, CMD_TIMEOUT_MS);
    return;
  }

  if (promptSeen && !finished && out.includes(DONE_MARKER, cmdSentAt)) {
    clearTimeout(cmdDeadlineTimer);
    finished = true;
    const segment = out.slice(cmdSentAt);
    evaluate(segment);
  }
});

function evaluate(segment) {
  // Alpine's gcc package identifies itself as either "gcc (Alpine ...)" or
  // "cc (Alpine ...)" in `--version` output depending on how the driver
  // binary resolves its own program name; accept either, plus a generic
  // "gcc version N" fallback in case the banner format ever changes upstream.
  const hasGcc = /\b(?:gcc|cc)\s*\(Alpine[^)]*\)\s+\d+\.\d+/i.test(segment) ||
    /gcc version \d/i.test(segment);
  const hasNasm = /NASM version \d/i.test(segment);
  const rc42 = /\bRC=42\b/.test(segment);
  const asm64Ok = /\bA64=OK\b/.test(segment);
  const ld64 = /\bLD64=YES\b/.test(segment);
  const vst2 = /\bVST2=OK\b/.test(segment);

  console.log('--- results ---');
  console.log('gcc present:      ', hasGcc);
  console.log('nasm present:     ', hasNasm);
  console.log('C build+run RC=42:', rc42);
  console.log('nasm elf64 asm:   ', asm64Ok);
  console.log('ld -m elf_x86_64: ', ld64 ? 'YES' : 'NO (not a hard failure; recorded as caps.ld64)');
  console.log('VST2 sample build:', vst2 ? 'OK' : 'not OK (not a hard failure; recorded as caps.vst2)');

  const hardFailures = [];
  if (!hasGcc) hardFailures.push('gcc --version did not report a gcc version');
  if (!hasNasm) hardFailures.push('nasm -v did not report a NASM version');
  if (!rc42) hardFailures.push('compiled C program did not exit with code 42 (native 32-bit execution path broken)');
  if (!asm64Ok) hardFailures.push('nasm failed to assemble a 64-bit (elf64) object (documented as always expected to work on i686 nasm)');

  if (hardFailures.length) {
    fail('hard requirement(s) failed:\n  - ' + hardFailures.join('\n  - '));
    return;
  }

  const manifest = {
    mode: 'linux9p',
    kernel: 'vm/image/bzimage.bin',
    initrd: 'vm/image/initramfs.img',
    cmdline: CMDLINE,
    fsjson: 'vm/image/alpine-fs.json',
    basefs: 'vm/image/alpine-rootfs-flat/',
    // v86 can also auto-locate a kernel+initrd embedded inside the 9p
    // filesystem itself (see V86's `bzimage_initrd_from_filesystem` option
    // and get_bzimage_initrd_from_filesystem in vm/vendor/libv86.mjs, which
    // scans / and /boot/ for vmlinuz*/initramfs* names). We ship explicit
    // kernel/initrd fields above (matching the manifest contract in
    // docs/ORCHESTRATION.md section 2) and rely on that as the primary
    // boot path; this flag is left available as a documented fallback if
    // vmterm.js ever needs one, since the same files also exist at /boot/
    // inside alpine-rootfs-flat/alpine-fs.json.
    bzimage_initrd_from_filesystem: true,
    caps: { ld64, vst2 },
    fallback: FALLBACK_IMG,
    generatedBy: 'tests/vm/boot-linux-smoke.mjs',
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log('PASS: wrote', MANIFEST_PATH);
  console.log(JSON.stringify(manifest, null, 2));

  emulator.destroy();
  process.exit(0);
}
