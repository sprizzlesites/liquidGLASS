#!/usr/bin/env python3
"""tools/build-image/mark_packed_manifest.py

Rewrites vm/image/manifest.json (already written by
tests/vm/boot-linux-smoke.mjs) to record that the bulky 9p chunk directory
(alpine-rootfs-flat/) was too large to commit directly to git and was
instead packed into a single 'alpine-rootfs.tar.zst' asset on a GitHub
Release. Used by the "Publish - Release asset" step of
.github/workflows/build-vm-image.yml.

Kept as a standalone script (rather than an inline `python3 - <<EOF` in the
workflow YAML) so it can be indented/edited/tested independently of YAML
block-scalar quirks, and so `python3 -m py_compile` / running it locally is
straightforward.

Usage: python3 tools/build-image/mark_packed_manifest.py [path-to-manifest]
(defaults to vm/image/manifest.json relative to the current working
directory, which the calling workflow step always sets to the repo root).
"""
import json
import sys

MANIFEST_PATH = sys.argv[1] if len(sys.argv) > 1 else "vm/image/manifest.json"

NOTES = (
    "alpine-rootfs-flat/ exceeded the git-friendly size threshold, so it was "
    "packed into a single 'alpine-rootfs.tar.zst' asset on the "
    "'vm-image-latest' GitHub Release instead of being committed as "
    "individual files. vmterm.js must download and unpack that asset into "
    "vm/image/alpine-rootfs-flat/ (or otherwise serve its members at the "
    "'baseurl' v86 expects) before booting in linux9p mode. The small "
    "metadata files (kernel, initrd, fsjson, manifest itself) ARE committed "
    "to vm/image/ as usual -- only the bulk per-file chunk directory moved "
    "to the Release. Until vmterm.js implements that unpack step, boot in "
    "floppy mode using `fallback` instead."
)


def main():
    with open(MANIFEST_PATH) as f:
        manifest = json.load(f)

    manifest["mode"] = "linux9p-packed"
    manifest["notes"] = NOTES
    manifest["release"] = {"tag": "vm-image-latest", "asset": "alpine-rootfs.tar.zst"}

    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"updated {MANIFEST_PATH}: mode=linux9p-packed")


if __name__ == "__main__":
    main()
