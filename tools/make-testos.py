#!/usr/bin/env python3
"""Generate vm/image/testos.img — a 512-byte real-mode boot sector used to
E2E-test the SprizzleIDE VM terminal pipeline without a full Linux image.

Behaviour when booted (v86 / any PC with a 16550 UART at 0x3F8):
  1. prints "SPRZ-TESTOS READY\r\n" to COM1
  2. echoes every byte received on COM1 back, uppercasing a-z so the test
     can distinguish a genuine guest round-trip from local terminal echo.

Assembled by hand (two-pass) so the repo needs no external assembler.
"""
import struct, sys, os

ORG = 0x7C00

def assemble():
    labels = {}
    # two passes: first records label offsets, second emits with them resolved
    for _pass in (1, 2):
        b = bytearray()
        def label(name):
            labels[name] = len(b)
        def emit(*xs):
            b.extend(xs)
        def rel8(target, at_end):
            # rel from end of instruction (at_end = len after emitting operand)
            return (labels.get(target, 0) - at_end) & 0xFF
        def rel16(target, at_end):
            return (labels.get(target, 0) - at_end) & 0xFFFF
        def imm16(target):
            return (ORG + labels.get(target, 0)) & 0xFFFF

        emit(0xFA)                                  # cli
        emit(0x31, 0xC0)                            # xor ax,ax
        emit(0x8E, 0xD8)                            # mov ds,ax
        emit(0x8E, 0xD0)                            # mov ss,ax
        emit(0xBC, 0x00, 0x7C)                      # mov sp,0x7C00
        emit(0xFB)                                  # sti
        v = imm16('msg');  emit(0xBE, v & 0xFF, v >> 8)   # mov si,msg
        label('next')
        emit(0xAC)                                  # lodsb
        emit(0x84, 0xC0)                            # test al,al
        emit(0x74, rel8('echo', len(b) + 1)); b[-1] = rel8('echo', len(b))  # jz echo
        emit(0x88, 0xC3)                            # mov bl,al
        v = rel16('putc', len(b) + 3); emit(0xE8, v & 0xFF, v >> 8)          # call putc
        emit(0xEB, rel8('next', len(b) + 1)); b[-1] = rel8('next', len(b))  # jmp next

        label('putc')                               # char in bl -> COM1
        label('putc_wait')
        emit(0xBA, 0xFD, 0x03)                      # mov dx,0x3FD (LSR)
        emit(0xEC)                                  # in al,dx
        emit(0xA8, 0x20)                            # test al,0x20 (THR empty)
        emit(0x74, rel8('putc_wait', len(b) + 1)); b[-1] = rel8('putc_wait', len(b))  # jz putc_wait
        emit(0xBA, 0xF8, 0x03)                      # mov dx,0x3F8 (THR)
        emit(0x88, 0xD8)                            # mov al,bl
        emit(0xEE)                                  # out dx,al
        emit(0xC3)                                  # ret

        label('echo')
        emit(0xBA, 0xFD, 0x03)                      # mov dx,0x3FD
        emit(0xEC)                                  # in al,dx
        emit(0xA8, 0x01)                            # test al,0x01 (data ready)
        emit(0x74, rel8('echo', len(b) + 1)); b[-1] = rel8('echo', len(b))  # jz echo
        emit(0xBA, 0xF8, 0x03)                      # mov dx,0x3F8 (RBR)
        emit(0xEC)                                  # in al,dx
        # uppercase a-z so the echo provably came from guest code
        emit(0x3C, 0x61)                            # cmp al,'a'
        emit(0x72, rel8('send', len(b) + 1)); b[-1] = rel8('send', len(b))  # jb send
        emit(0x3C, 0x7B)                            # cmp al,'z'+1
        emit(0x73, rel8('send', len(b) + 1)); b[-1] = rel8('send', len(b))  # jae send
        emit(0x2C, 0x20)                            # sub al,0x20
        label('send')
        emit(0x88, 0xC3)                            # mov bl,al
        v = rel16('putc', len(b) + 3); emit(0xE8, v & 0xFF, v >> 8)          # call putc
        emit(0xEB, rel8('echo', len(b) + 1)); b[-1] = rel8('echo', len(b))  # jmp echo

        label('msg')
        b.extend(b"SPRZ-TESTOS READY\r\n\x00")
    assert len(b) <= 510, f"boot sector too big: {len(b)}"
    b.extend(b"\x00" * (510 - len(b)))
    b.extend(b"\x55\xAA")
    # pad to a standard 1.44MB floppy: v86/SeaBIOS derive floppy geometry from
    # a table of known sizes, so a bare 512-byte image won't boot
    b.extend(b"\x00" * (1474560 - len(b)))
    return bytes(b)

if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'vm', 'image', 'testos.img')
    data = assemble()
    with open(out, 'wb') as f:
        f.write(data)
    print(f"wrote {out} ({len(data)} bytes)")
