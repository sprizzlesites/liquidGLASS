#!/usr/bin/env bash
# tools/build-image/build.sh
#
# Builds the Alpine i686 toolchain rootfs, the standalone kernel/initramfs
# pair, and the v86 9p filesystem artifacts (alpine-fs.json + a flat,
# content-addressed chunk directory) that vm/vmterm.js boots in "linux9p"
# mode. Designed to run unattended inside .github/workflows/build-vm-image.yml
# on a GitHub-hosted ubuntu-latest runner (which has open network + Docker),
# but every step is a plain shell/python invocation so a developer with
# Docker + network can also run this locally:
#
#   ./tools/build-image/build.sh
#
# It CANNOT run in this project's dev sandbox: the sandbox's network policy
# blocks the Alpine CDN (dl-cdn.alpinelinux.org) that `apk add` needs. That is
# precisely why this whole build is delegated to CI (see docs/ORCHESTRATION.md
# section 2 "Locked architecture").
#
# Outputs (relative to repo root, i.e. $OUT below):
#   vm/image/bzimage.bin           standalone Linux kernel (bzImage format)
#   vm/image/initramfs.img         standalone initramfs (9p+virtio modules)
#   vm/image/alpine-fs.json        v86 9p filesystem mapping (fs2json.py)
#   vm/image/alpine-rootfs-flat/   sha256-named, deduplicated file blobs
#                                  (copy-to-sha256.py) -- this is the
#                                  `baseurl` v86 fetches file contents from
#                                  on demand.
#
# It does NOT commit/push/publish anything or run the boot smoke test --
# that is orchestrated by the calling workflow (build-vm-image.yml), which
# runs `node tests/vm/boot-linux-smoke.mjs` against these outputs afterwards
# and only then decides how to publish vm/image/*.
set -euo pipefail

# --- locate repo root & fixed paths --------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="$REPO_ROOT/vm/image"
CONTEXT_DIR="$SCRIPT_DIR/_context"     # transient docker build context, gitignored-by-convention (not committed; recreated every run)
SKEL_SRC="$REPO_ROOT/tools/skel"       # owned by a sibling agent workstream; may not exist yet
V86_REF_DIR="${V86_REF_DIR:-$SCRIPT_DIR/_v86-ref}"  # clone of copy/v86, for tools/fs2json.py + tools/copy-to-sha256.py
ALPINE_TAG="${ALPINE_TAG:-3.19}"
IMAGE_NAME="sprz-alpine-v86-toolchain"
CONTAINER_NAME="sprz-alpine-v86-toolchain-ctr"

mkdir -p "$OUT_DIR"

echo "== [1/7] staging tools/skel/ into the docker build context =="
rm -rf "$CONTEXT_DIR"
mkdir -p "$CONTEXT_DIR/skel"
if [ -d "$SKEL_SRC" ]; then
  cp -a "$SKEL_SRC"/. "$CONTEXT_DIR/skel"/
  echo "staged $(find "$CONTEXT_DIR/skel" -type f | wc -l) file(s) from tools/skel/"
else
  cat > "$CONTEXT_DIR/skel/README.txt" <<'EOF'
Placeholder: tools/skel/ did not exist in the repo at build time.
(It is owned by a sibling agent workstream -- see docs/ORCHESTRATION.md
work package 3.C -- and is expected to contain a VST2 sample plugin project,
vestige.h, and a Makefile.) The image still builds without it; the
"cd /root/skel/vst && make" step of the boot smoke test will simply fail
non-fatally and record caps.vst2=false in vm/image/manifest.json until that
work lands and this workflow re-runs.
EOF
fi

echo "== [2/7] docker build (linux/386, i386/alpine:$ALPINE_TAG) =="
docker build \
  --platform linux/386 \
  --build-arg ALPINE_TAG="$ALPINE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile" \
  -t "$IMAGE_NAME" \
  "$CONTEXT_DIR"

echo "== [3/7] docker export -> rootfs tar =="
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME" >/dev/null
ROOTFS_TAR="$OUT_DIR/.alpine-rootfs.tar"   # transient; not committed (see .gitignore note below)
docker export "$CONTAINER_NAME" -o "$ROOTFS_TAR"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# NB: we deliberately do NOT run `tar --delete .dockerenv` here. `docker
# export` archives carry PAX/GNU extended headers, and GNU tar's --delete
# rewrites the archive in a way that mangles those headers -- every later
# `tar` read then fails with "tar: Skipping to next header / Exiting with
# failure status" (exit 2), which killed the [4/7] extraction. The stray
# zero-byte /.dockerenv it was trying to remove is completely harmless inside
# the guest, so we simply leave it rather than touch the archive at all.

echo "== [4/7] extracting standalone kernel + initramfs =="
# Also embedded at /boot/ inside the 9p rootfs itself (so vmterm.js could
# alternatively use v86's `bzimage_initrd_from_filesystem: true` autodetection
# -- see docs/VM-TOOLCHAIN.md and the manifest.json this build produces),
# but the orchestration plan's manifest contract expects standalone
# "kernel"/cmdline fields, so we always extract real files for that too.
# List the archive ONCE into a variable. Piping `tar -tf` straight into
# `head` makes head close the pipe early, SIGPIPE-killing tar mid-scan (noisy
# under `set -o pipefail`); grepping a plain string afterwards avoids that.
ROOTFS_MEMBERS="$(tar -tf "$ROOTFS_TAR")"
BZIMAGE_MEMBER="$(printf '%s\n' "$ROOTFS_MEMBERS" | grep -E '^(\./)?boot/vmlinuz-[^/]+$' | head -n1 || true)"
INITRD_MEMBER="$(printf '%s\n' "$ROOTFS_MEMBERS" | grep -E '^(\./)?boot/initramfs-[^/]+$' | head -n1 || true)"

if [ -z "$BZIMAGE_MEMBER" ] || [ -z "$INITRD_MEMBER" ]; then
  echo "FATAL: could not find boot/vmlinuz-* and/or boot/initramfs-* in the exported rootfs tar." >&2
  echo "Found under boot/:" >&2
  printf '%s\n' "$ROOTFS_MEMBERS" | grep -E '^(\./)?boot/' >&2 || true
  exit 1
fi

tar -xf "$ROOTFS_TAR" -O "$BZIMAGE_MEMBER" > "$OUT_DIR/bzimage.bin"
tar -xf "$ROOTFS_TAR" -O "$INITRD_MEMBER" > "$OUT_DIR/initramfs.img"
echo "kernel:   $BZIMAGE_MEMBER -> vm/image/bzimage.bin ($(du -h "$OUT_DIR/bzimage.bin" | cut -f1))"
echo "initramfs: $INITRD_MEMBER -> vm/image/initramfs.img ($(du -h "$OUT_DIR/initramfs.img" | cut -f1))"

echo "== [5/7] fetching v86's tools/fs2json.py + tools/copy-to-sha256.py =="
# These are reference conversion scripts from the v86 project itself (BSD-2,
# same license as the vendored engine under vm/vendor/). They are not
# vendored into this repo -- fetched fresh at build time, matching the task
# instruction to "clone copy/v86 (depth 1)". Exact CLI usage was confirmed by
# reading both scripts' argparse definitions and the upstream
# tools/docker/alpine/build.sh before writing this file:
#   fs2json.py [--exclude path]... --out OUT.json [--zstd] <path-or-tar>
#   copy-to-sha256.py [--zstd] <path-or-tar> <out-dir>
# Both scripts accept a *tar file* directly (no need to extract it to a
# directory first), which is what we use below.
if [ ! -d "$V86_REF_DIR/.git" ]; then
  rm -rf "$V86_REF_DIR"
  git clone --depth 1 https://github.com/copy/v86 "$V86_REF_DIR"
else
  echo "reusing existing checkout at $V86_REF_DIR"
fi

echo "== [6/7] fs2json.py -> alpine-fs.json =="
# NOTE: deliberately NOT using --zstd here. v86 does support zstd-compressed
# 9p chunks/json (verified by reading vm/vendor/libv86.mjs), but --zstd
# requires the `zstandard` pip package (or Python >=3.14's builtin
# `compression.zstd`) to be present, which is one more thing that can fail a
# first CI run for a size optimization that isn't required to hit the
# <90MB-per-file / ~300MB-total targets once the rootfs is trimmed (see
# Dockerfile). If a future size crunch needs it, add
# `pip install zstandard` to the workflow and pass --zstd to both commands
# below plus set filesystem.basefs/baseurl consumers to expect .bin.zst.
python3 "$V86_REF_DIR/tools/fs2json.py" --out "$OUT_DIR/alpine-fs.json" "$ROOTFS_TAR"

echo "== [7/7] copy-to-sha256.py -> alpine-rootfs-flat/ =="
mkdir -p "$OUT_DIR/alpine-rootfs-flat"
python3 "$V86_REF_DIR/tools/copy-to-sha256.py" "$ROOTFS_TAR" "$OUT_DIR/alpine-rootfs-flat"

rm -f "$ROOTFS_TAR"

echo
echo "== size report =="
du -sh "$OUT_DIR"/bzimage.bin "$OUT_DIR"/initramfs.img "$OUT_DIR"/alpine-fs.json "$OUT_DIR"/alpine-rootfs-flat 2>/dev/null || true
echo "flat dir file count: $(find "$OUT_DIR/alpine-rootfs-flat" -type f | wc -l)"
echo "largest single file: $(find "$OUT_DIR" -type f -printf '%s %p\n' 2>/dev/null | sort -rn | head -n1)"
echo
echo "Build complete. Next: node tests/vm/boot-linux-smoke.mjs"
