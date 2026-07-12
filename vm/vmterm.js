// vm/vmterm.js — classic script (no modules), loaded lazily by SprizzleIDE.html
// on first activation of the VM panel tab. Binds xterm.js to a v86 emulator's
// serial0 line. Boot payload is chosen from vm/image/manifest.json (fetched
// relative to the page): 'linux9p' (real Alpine toolchain, built by CI — see
// docs/ORCHESTRATION.md) or 'floppy' (vendored testos.img, always available,
// used offline/in CI sandboxes with no network). syncIn/syncOut implement the
// two-way S.files <-> guest /root/project bridge (Agent B); all 9p filesystem
// access is routed through VMTerm._fs (see makeFs9pFs() below) so tests can
// inject a stub without booting a real emulator.
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

  // ── Project sync bridge (Agent B) ────────────────────────────────────────
  // VMTerm._fs is a small filesystem-agnostic wrapper exposing
  // {mkdir(path), write(path,bytes), read(path)->bytes|null, readdir(path)->
  // [{name,isDir}]} — real implementation below is backed by v86's 9p
  // filesystem (emulator.fs9p, a Filesystem instance; see vm/vendor/libv86.mjs).
  // Routing everything through this shape (rather than calling fs9p methods
  // directly from syncIn/syncOut) lets node tests inject a fake in-memory
  // stub without booting a real emulator.
  //
  // Verified public/low-level 9p API (grepped from vm/vendor/libv86.mjs):
  //   emulator.create_file(path, data)   — async; REJECTS if the parent dir
  //                                         doesn't already exist (no mkdir -p)
  //   emulator.read_file(path)           — async; REJECTS if missing
  //   emulator.fs9p                      — the Filesystem instance, also has:
  //     fs9p.SearchPath(path)  -> {id,parentid,name,forward_path} (id===-1 if
  //                               not found; SearchPath('') is the root, id 0)
  //     fs9p.CreateDirectory(name, parentId) -> new inode id (sync)
  //     fs9p.CreateBinaryFile(name, parentId, bytes) -> new inode id (async)
  //     fs9p.read_file(path) -> bytes|null (path-based, resolves null — does
  //                              NOT reject — if missing; differs from the
  //                              emulator.read_file convenience wrapper)
  //     fs9p.GetInode(id) -> {size, mode, direntries:Map<name,id>, ...}
  //     fs9p.IsDirectory(id) -> bool
  //     fs9p.DeleteNode(path) -> removes a file, or recursively a directory
  //   None of the above auto-create parent directories, so mkdir() below
  //   walks the path segment by segment creating any that are missing.
  function makeFs9pFs(fs9p){
    return {
      async mkdir(path){
        const parts = String(path).split('/').filter(Boolean);
        let cur = '', parentId = 0; // 0 == filesystem root inode
        for (const part of parts) {
          cur = cur ? cur + '/' + part : part;
          const info = fs9p.SearchPath(cur);
          parentId = info.id !== -1 ? info.id : fs9p.CreateDirectory(part, parentId);
        }
        return parentId;
      },
      async write(path, bytes){
        const parts = String(path).split('/').filter(Boolean);
        const name = parts.pop();
        const dirPath = parts.join('/');
        const parentId = dirPath ? await this.mkdir(dirPath) : 0;
        const existing = fs9p.SearchPath(path);
        if (existing.id !== -1) fs9p.DeleteNode(path); // overwrite: drop stale inode first
        await fs9p.CreateBinaryFile(name, parentId, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      },
      async read(path){
        const data = await fs9p.read_file(path);
        if (!data) return null;
        return data instanceof Uint8Array ? data : new Uint8Array(data);
      },
      async readdir(path){
        const info = fs9p.SearchPath(path);
        if (info.id === -1) return [];
        const inode = fs9p.GetInode(info.id);
        const out = [];
        if (!inode || !inode.direntries) return out;
        for (const [name, id] of inode.direntries) {
          if (name === '.' || name === '..') continue;
          out.push({ name, isDir: fs9p.IsDirectory(id) });
        }
        return out;
      },
    };
  }

  // Recursively walk a directory through the _fs wrapper contract, collecting
  // {path (relative to `dir`), bytes} for every plain file found.
  async function walkFs(fsObj, dir, relPrefix, out){
    const entries = await fsObj.readdir(dir);
    for (const entry of entries) {
      const full = dir + '/' + entry.name;
      const rel = relPrefix ? relPrefix + '/' + entry.name : entry.name;
      if (entry.isDir) {
        await walkFs(fsObj, full, rel, out);
      } else {
        const bytes = await fsObj.read(full);
        out.push({ path: rel, bytes: bytes || new Uint8Array(0) });
      }
    }
  }

  const VMTerm = {
    _emulator: null,
    _fs: null,     // routed 9p wrapper — see makeFs9pFs() above; tests inject a stub here
    _mode: null,   // 'linux9p' | 'floppy' — which boot payload is actually running
    _term: null,
    _mount: null,
    _booting: false,
    _markerPoll: null,     // setInterval handle for the .sprz-sync marker watcher
    _markerSeen: null,     // last-seen marker content fingerprint (string) or null

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
          // The Alpine "virt" kernel is modular: 9p/virtio live in the initrd,
          // so root=host9p cannot mount without one (Agent D contract).
          if (manifest.initrd) opts.initrd = { url: manifest.initrd };
          if (manifest.bzimage_initrd_from_filesystem) opts.bzimage_initrd_from_filesystem = true;
          opts.memory_size = (manifest.memory_mb ? manifest.memory_mb : 256) * 1024 * 1024;
          this._mode = 'linux9p';
          term.write('\r\n[vmterm] booting Linux (9p) image…\r\n');
        } else {
          const fdaResp = await fetch('vm/image/testos.img');
          if (!fdaResp.ok) throw new Error('could not fetch vm/image/testos.img (HTTP ' + fdaResp.status + ')');
          const buffer = await fdaResp.arrayBuffer();
          opts.fda = { buffer };
          opts.memory_size = 64 * 1024 * 1024;
          this._mode = 'floppy';
          if (manifest && manifest.mode === 'linux9p') {
            term.write('\r\n[vmterm] Linux image unavailable — falling back to floppy test OS.\r\n');
          } else {
            term.write('\r\n[vmterm] booting floppy test OS…\r\n');
          }
        }

        const emulator = new V86(opts);
        this._emulator = emulator;
        this._fs = (this._mode === 'linux9p' && emulator.fs9p) ? makeFs9pFs(emulator.fs9p) : null;

        emulator.add_listener('serial0-output-byte', byte => term.write(Uint8Array.of(byte)));
        emulator.add_listener('emulator-started', () => { setStatus('ok', 'running'); this._startMarkerPoll(); });
        emulator.add_listener('emulator-stopped', () => { setStatus('', 'stopped'); this._stopMarkerPoll(); });
      } catch (e) {
        setStatus('err', 'boot failed');
        writeErr(term, '[vmterm] boot failed: ' + (e && e.message ? e.message : e));
        this._emulator = null;
      } finally {
        this._booting = false;
      }
    },

    stop(){
      this._stopMarkerPoll();
      if (!this._emulator) { this._fs = null; return; }
      try { this._emulator.destroy(); } catch (e) { /* already gone */ }
      this._emulator = null;
      this._fs = null;
      setStatus('', 'stopped');
    },

    // Walk S.files -> write bytes into /root/project inside the guest, creating
    // parent directories as needed. S, fileGetBytes, tw, and addGitChange are
    // SprizzleIDE.html globals (classic scripts share one global scope).
    async syncIn(){
      const term = this._term;
      if (!this._fs) {
        writeErr(term, this._mode === 'linux9p'
          ? '[sync] filesystem is not ready yet — wait for boot to finish and try again.'
          : '[sync] sync requires the Linux VM image (this session is running the floppy/test-OS fallback, which has no project filesystem — see docs/ORCHESTRATION.md).');
        return false;
      }
      const paths = typeof S !== 'undefined' ? Object.keys(S.files) : [];
      if (!paths.length) {
        if (term) term.write('\r\n[sync] project is empty — nothing to sync in.\r\n');
        return true;
      }
      if (term) term.write(`\r\n[sync] → VM: syncing ${paths.length} file(s) to /root/project ...\r\n`);
      try {
        await this._fs.mkdir('project');
        for (const p of paths) {
          const bytes = fileGetBytes(p);
          await this._fs.write('project/' + p, bytes);
          if (term) term.write(`  → ${p} (${bytes.length}B)\r\n`);
        }
        if (term) term.write(`[sync] done — ${paths.length} file(s) written to /root/project\r\n`);
        if (typeof tw === 'function') tw(`Synced ${paths.length} file(s) to VM`, 'info');
        return true;
      } catch (e) {
        writeErr(term, '[sync] syncIn failed: ' + (e && e.message ? e.message : e));
        return false;
      }
    },

    // Recursively read /root/project back out of the guest into S.files,
    // skipping the .sprz-sync marker file (that's plumbing, not a project
    // file). Binary-safe via fileSetBytes (SprizzleIDE.html global).
    async syncOut(){
      const term = this._term;
      if (!this._fs) {
        writeErr(term, this._mode === 'linux9p'
          ? '[sync] filesystem is not ready yet — wait for boot to finish and try again.'
          : '[sync] sync requires the Linux VM image (this session is running the floppy/test-OS fallback, which has no project filesystem — see docs/ORCHESTRATION.md).');
        return false;
      }
      try {
        const found = [];
        await walkFs(this._fs, 'project', '', found);
        let count = 0;
        for (const { path, bytes } of found) {
          if (path === '.sprz-sync') continue;
          const existed = typeof S !== 'undefined' && !!S.files[path];
          fileSetBytes(path, bytes);
          if (typeof addGitChange === 'function') addGitChange(path, existed ? 'M' : 'A');
          count++;
        }
        if (typeof renderTree === 'function') renderTree();
        if (typeof renderTabs === 'function') renderTabs();
        if (term) term.write(`\r\n[sync] ← VM: pulled ${count} file(s) from /root/project\r\n`);
        if (typeof tw === 'function') tw(`Synced ${count} file(s) from VM`, 'info');
        return true;
      } catch (e) {
        writeErr(term, '[sync] syncOut failed: ' + (e && e.message ? e.message : e));
        return false;
      }
    },

    // Poll guest-touched /root/project/.sprz-sync every 2s (only while linux9p
    // is actually running) — the guest convenience script `sync-out` touches
    // this marker after writing build artifacts; when its content changes we
    // auto-pull and clear it so the same change doesn't re-trigger. Skips work
    // while the VM mount is hidden (offsetParent null) so a background tab
    // doesn't burn cycles reading the guest fs on a timer.
    _startMarkerPoll(){
      this._stopMarkerPoll();
      if (this._mode !== 'linux9p') return;
      this._markerSeen = null;
      this._markerPoll = setInterval(async () => {
        if (!this._fs || !this.isRunning()) return;
        if (this._mount && this._mount.offsetParent === null) return; // VM tab not visible
        try {
          const data = await this._fs.read('project/.sprz-sync');
          const fingerprint = data ? Array.from(data).join(',') : null;
          if (fingerprint !== null && fingerprint !== this._markerSeen) {
            this._markerSeen = fingerprint;
            await this.syncOut();
            try { await this._fs.write('project/.sprz-sync', new Uint8Array(0)); this._markerSeen = ''; } catch (e) { /* best-effort clear */ }
          }
        } catch (e) { /* transient fs error mid-boot — ignore, retry next tick */ }
      }, 2000);
    },
    _stopMarkerPoll(){
      if (this._markerPoll) { clearInterval(this._markerPoll); this._markerPoll = null; }
      this._markerSeen = null;
    },
  };

  window.VMTerm = VMTerm;
})();
