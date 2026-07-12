# tools/build-image/Dockerfile
#
# Builds the Alpine Linux i686 toolchain rootfs used as v86's 9p guest
# filesystem for SprizzleIDE's in-browser "VM" terminal (fullterminal work
# package 3.D, see docs/ORCHESTRATION.md).
#
# This follows the OFFICIAL v86 project recipe as closely as possible:
#   https://raw.githubusercontent.com/copy/v86/master/tools/docker/alpine/Dockerfile
#   https://raw.githubusercontent.com/copy/v86/master/tools/docker/alpine/Readme.md
# (docs/alpine.md does not exist upstream; tools/docker/alpine/* is the real,
# proven recipe -- fetched and inspected directly from raw.githubusercontent.com
# while writing this file). We swap upstream's default extra package
# (`nodejs`) for the compiler toolchain SprizzleIDE actually needs, and pin
# the base image tag requested by the orchestration plan (i386/alpine:3.19,
# vs. upstream's 3.21.0 default -- both are supported apk repos).
#
# CI-ONLY ASSUMPTION: this Dockerfile is only ever built with
# `docker build --platform linux/386 ...` on an x86_64 GitHub Actions runner.
# x86_64 CPUs execute 32-bit (i386/i686) machine code natively (IA-32
# compatibility mode), so no binfmt_misc/QEMU user-mode emulation is needed
# for the docker build itself -- that would only be required cross-family
# (e.g. building linux/386 on an arm64 runner, which we do not use).
ARG ALPINE_TAG=3.19
FROM i386/alpine:${ALPINE_TAG}

# "virt" kernel flavor is smaller than "lts" and is what upstream v86 uses.
ENV KERNEL=virt

# --no-cache: nothing persists into /var/cache/apk/* in this layer, so no
# separate `rm -rf /var/cache/apk/*` is needed for the apk cache itself.
#
#   alpine-base, openrc, agetty, alpine-conf   -> boot/init/login plumbing
#   linux-$KERNEL, linux-firmware-none         -> kernel + empty firmware set
#   bash, gcc, musl-dev, make, nasm, binutils,
#   busybox-extras                             -> the compile toolchain
RUN apk add --no-cache \
      alpine-base openrc agetty alpine-conf \
      linux-$KERNEL linux-firmware-none \
      bash gcc musl-dev make nasm binutils busybox-extras

# --- serial console autologin -------------------------------------------
# Alpine's stock init is BusyBox `init` reading /etc/inittab (there is no
# systemd here). alpine-base's default /etc/inittab already chains into
# OpenRC for the sysinit/boot/default/shutdown runlevels, e.g.:
#   ::sysinit:/sbin/openrc sysinit
#   ::wait:/sbin/openrc boot
#   ::wait:/sbin/openrc default
#   ::shutdown:/sbin/openrc shutdown
# OpenRC's own baselayout scripts (registered below via `rc-update`) mount
# /proc and /sys, bring up /dev via mdev, set the clock, load sysctl, etc.
#
# DECISION: we deliberately do NOT write a custom /sbin/init or hand-roll
# /etc/fstab proc/sys entries. Fighting or replacing that plumbing is a much
# bigger surface for a first-try CI build to get subtly wrong than reusing
# the vendor-supported "busybox init + inittab + OpenRC runlevels"
# combination, which is exactly what copy/v86's own proven Alpine Dockerfile
# does. We only touch the getty lines.
#
# We remove any stock ttyS0 inittab entry first (avoids two gettys racing
# for the same serial device) and add our own using the util-linux `agetty`
# package (installed above; NOT the busybox agetty applet), which supports
# GNU-style long options such as --autologin.
RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab \
 && sed -i '/^ttyS0::/d' /etc/inittab \
 && echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab \
 && echo 'root:' | chpasswd

RUN setup-hostname localhost

# Minimal OpenRC service set, per
# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for svc in devfs dmesg mdev hwdrivers; do rc-update add "$svc" sysinit; done \
 && for svc in hwclock modules sysctl hostname syslog bootmisc; do rc-update add "$svc" boot; done \
 && rc-update add killprocs shutdown

# --- project skeleton + sync convenience script --------------------------
# tools/skel/** (vestige.h, gain-vst2.c sample, Makefile -- owned by a
# sibling agent workstream, see docs/ORCHESTRATION.md work package 3.C) is
# staged into the Docker build context at ./skel by build.sh BEFORE `docker
# build` runs. build.sh guarantees ./skel always exists (creating an empty
# placeholder with a README if the real tools/skel/ is not present yet), so
# this COPY can never fail the image build regardless of build order
# relative to the sibling agent's work landing on this branch.
COPY skel/ /root/skel/
RUN mkdir -p /root/project

RUN printf '#!/bin/sh\n# Guest-side convenience: touch the marker file the host IDE polls for\n# to know it should pull /root/project back into S.files (see\n# docs/ORCHESTRATION.md section 2, "Project sync").\ntouch /root/project/.sprz-sync\n' > /usr/local/bin/sync-out \
 && chmod +x /usr/local/bin/sync-out

# --- initramfs with 9p + virtio modules ----------------------------------
# The "virt" kernel flavor builds almost everything as modules, so mounting
# the v86 9p root filesystem at boot (root=host9p rootflags=trans=virtio)
# requires those modules to be present in an early initramfs. mkinitfs
# (Alpine's own initramfs generator, part of alpine-conf) with the
# "base virtio 9p" feature set is exactly what copy/v86's own Alpine recipe
# uses; replicated verbatim here.
RUN mkinitfs -F "base virtio 9p" "$(cat /usr/share/kernel/$KERNEL/kernel.release)"

# --- trim for git-friendliness -------------------------------------------
# vm/image/* is committed to the repo when small enough (see build-vm-image
# workflow); every byte counts. None of this is needed at runtime.
RUN rm -rf /usr/share/man /usr/share/doc /usr/share/licenses /usr/share/i18n \
           /root/.cache /tmp/* 2>/dev/null || true
