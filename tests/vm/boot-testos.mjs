// Node harness: boots vm/image/testos.img under the vendored v86 engine and
// verifies the full serial round-trip (banner out, echo-with-uppercase back).
// Run: node tests/vm/boot-testos.mjs   (exits 0 on pass)
import { V86 } from '../../vm/vendor/libv86.mjs';
import fs from 'node:fs';
import url from 'node:url';

const root = url.fileURLToPath(new URL('../../', import.meta.url));
const buf = p => fs.readFileSync(root + p).buffer;

const emulator = new V86({
  wasm_path: root + 'vm/vendor/v86.wasm',
  bios: { buffer: buf('vm/vendor/seabios.bin') },
  vga_bios: { buffer: buf('vm/vendor/vgabios.bin') },
  fda: { buffer: buf('vm/image/testos.img') },
  memory_size: 32 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
});

let out = '';
let sent = false;
const deadline = setTimeout(() => { console.error('FAIL: timeout. serial so far:', JSON.stringify(out)); process.exit(1); }, 60000);

emulator.add_listener('serial0-output-byte', (byte) => {
  out += String.fromCharCode(byte);
  if (!sent && out.includes('SPRZ-TESTOS READY')) {
    sent = true;
    console.log('banner received; sending probe "hello123"');
    emulator.serial0_send('hello123');
  }
  if (sent && out.includes('HELLO123')) {
    clearTimeout(deadline);
    console.log('PASS: banner + uppercased echo round-trip OK');
    emulator.destroy();
    process.exit(0);
  }
});
