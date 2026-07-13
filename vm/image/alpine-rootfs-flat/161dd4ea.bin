# Makefile for the in-VM VST2 gain plugin sample (see gain-vst2.c).
# Baked into the Alpine i686 toolchain image (Agent D) at /root/skel/vst so
# it can be built for real, entirely inside the browser VM, via:
#
#   cd /root/project/vst   (or wherever the skel is copied/synced)
#   make
#
# Produces gain.so — a real, loadable Linux VST2 effect binary.

CC      ?= gcc
CFLAGS  ?= -O2 -fPIC -Wall -Wextra -I.
TARGET  := gain.so
SRC     := gain-vst2.c
HEADER  := vestige/vestige.h

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SRC) $(HEADER)
	$(CC) -shared -fPIC -o $(TARGET) $(SRC) $(CFLAGS)

clean:
	rm -f $(TARGET)
