// vm/vmterm.js — classic script (no modules), loaded lazily by SprizzleIDE.html
// on first activation of the VM panel tab. Binds xterm.js to a v86 emulator's
// serial0 line. Boot payload is chosen from vm/image/manifest.json (fetched
// relative to the page): 'linux9p' (real Alpine toolchain, built by CI — see
// docs/ORCHESTRATION.md) or 'floppy' (vendored testos.img, always available,
// used offline/in CI sandboxes with no network). Sync-in/out are STUBS here —
// Agent B (project-sync work package) replaces them; all 9p filesystem access
// must route through VMTerm._fs so tests can inject a stub without booting a
// real emulator.
(function(){
  const CHAR_W = 7.8, CHAR_H = 17; // approx cell metrics for fontSize:13 monospace — no fit addon vendored
  let _mobileNoticeShown = false;

  function setStatus(state, text){
    const dot = document.getElementById('vm-status-dot');
    const txt = document.getElementById('vm-status');
    if (dot) dot.style.background = state === 'ok' ? 'var(--green)' : state === 'err' ? 'var(--red)' : 'var(--text-2)';
    if (txt) txt.textContent = text;
  }

  function writeErr(term, msg){
    if (!term) return;
    term.write('\r\n\x1b[31m' + msg + '\x1b[0m\r\n');
  }

  const VMTerm = {
    _emulator: null,
    _fs: null,   // Agent B: route all 9p filesystem calls through this so tests can stub it
    _term: null,
    _mount: null,
    _booting: false,

    init(mount){
      if (this._term) return; // already initialized (tab re-activated)
      this._mount = mount;
      const term = new Terminal({
        cols: 80, rows: 24, fontSize: 13, convertEol: false,
        theme: { background: '#0a0a0e', foreground: '#d0d0d8', cursor: '#6c7fff' }
      });
      term.open(mount);
      term.write('SprizzleIDE VM Terminal — v86 x86 emulator (Boot to start)\r\n');
      this._term = term;

      if (typeof isMobileDevice === 'function' && isMobileDevice() && !_mobileNoticeShown) {
        _mobileNoticeShown = true;
        term.write('\x1b[33m[system] The VM needs significant memory (32-256MB) and works best on desktop.\r\n         Mobile browsers (especially iOS Safari) may kill the tab.\x1b[0m\r\n');
      }

      term.onData(d => { if (this._emulator) this._emulator.serial0_send(d); });
      window.addEventListener('resize', () => this._fit());
      this._fit();
    },

    _fit(){
      if (!this._term || !this._mount) return;
      try {
        const w = this._mount.clientWidth, h = this._mount.clientHeight;
        if (!w || !h) return;
        const cols = Math.max(20, Math.floor(w / CHAR_W));
        const rows = Math.max(10, Math.floor(h / CHAR_H));
        if (cols !== this._term.cols || rows !== this._term.rows) this._term.resize(cols, rows);
      } catch (e) { /* manual fit is best-effort; ignore failures */ }
    },

    isRunning(){ return !!(this._emulator && this._emulator.is_running && this._emulator.is_running()); },

    async boot(){
      if (this._booting || this.isRunning()) return; // ignore double-boot
      this._booting = true;
      const term = this._term;
      setStatus('', 'booting…');
      try {
        let manifest = null;
        try {
          const r = await fetch('vm/image/manifest.json');
          if (r.ok) manifest = await r.json();
        } catch (e) { /* no manifest — floppy fallback */ }

        const opts = {
          wasm_path: 'vm/vendor/v86.wasm',
          bios: { url: 'vm/vendor/seabios.bin' },
          vga_bios: { url: 'vm/vendor/vgabios.bin' },
          autostart: true,
          disable_keyboard: true, // v86's own PS/2 keyboard is disabled — xterm feeds the serial line instead
        };

        if (manifest && manifest.mode === 'linux9p') {
          opts.bzimage = { url: manifest.kernel };
          opts.cmdline = manifest.cmdline;
          opts.filesystem = { basefs: manifest.fsjson, baseurl: manifest.basefs };
          opts.memory_size = 256 * 1024 * 1024;
          term.write('\r\n[vmterm] booting Linux (9p) image…\r\n');
        } else {
          const fdaResp = await fetch('vm/image/testos.img');
          if (!fdaResp.ok) throw new Error('could not fetch vm/image/testos.img (HTTP ' + fdaResp.status + ')');
          const buffer = await fdaResp.arrayBuffer();
          opts.fda = { buffer };
          opts.memory_size = 64 * 1024 * 1024;
          if (manifest && manifest.mode === 'linux9p') {
            term.write('\r\n[vmterm] Linux image unavailable — falling back to floppy test OS.\r\n');
          } else {
            term.write('\r\n[vmterm] booting floppy test OS…\r\n');
          }
        }

        const emulator = new V86(opts);
        this._emulator = emulator;
        if (manifest && manifest.filesystem) this._fs = emulator.fs9p || null;

        emulator.add_listener('serial0-output-byte', byte => term.write(Uint8Array.of(byte)));
        emulator.add_listener('emulator-started', () => setStatus('ok', 'running'));
        emulator.add_listener('emulator-stopped', () => setStatus('', 'stopped'));
      } catch (e) {
        setStatus('err', 'boot failed');
        writeErr(term, '[vmterm] boot failed: ' + (e && e.message ? e.message : e));
        this._emulator = null;
      } finally {
        this._booting = false;
      }
    },

    stop(){
      if (!this._emulator) return;
      try { this._emulator.destroy(); } catch (e) { /* already gone */ }
      this._emulator = null;
      this._fs = null;
      setStatus('', 'stopped');
    },

    // STUBS — Agent B (project sync bridge) replaces these with real S.files <-> 9p sync.
    syncIn(){
      if (this._term) this._term.write('\r\n\x1b[33m[sync not yet implemented — Agent B]\x1b[0m\r\n');
      return false;
    },
    syncOut(){
      if (this._term) this._term.write('\r\n\x1b[33m[sync not yet implemented — Agent B]\x1b[0m\r\n');
      return false;
    },
  };

  window.VMTerm = VMTerm;
})();
