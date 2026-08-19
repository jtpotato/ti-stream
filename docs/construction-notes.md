# Construction notes

How this TI-Nspire CX II screen-streaming app was built, and the lessons that
were hard to learn. Protocol reference lives in
[`nspire-cx2-webusb-research.md`](./nspire-cx2-webusb-research.md); this file
is the engineering log.

## Stack

- TypeScript + Vite + React, running in Chrome/Edge over **WebUSB**.
- The protocol is **NNSE** (the CX II's USB framing) carrying **NavNet**
  packets (the logical link layer). No native code, no WASM — everything is a
  port of `libnspire` / Firebird emulator behaviour.
- One bulk IN endpoint, one bulk OUT endpoint, 64-byte-aligned packet sizes.

## The three bugs that ate the time

### 1. NNSE checksum validation is not a pure RFC1071 check

The 16-bit checksum is the standard sum-of-big-endian-words with end-around
carry, **stored complemented so the whole packet sums to `0xFFFF`** (not
`0x0000`). Verify with `internetChecksum(raw) === 0xffff`. A self-round-trip
test of serialize→parse is not enough; verify against the reference algorithm
(port of `compute_checksum` in `Vogtinator/libnspire` `src/cx2.cpp`, including
the `while (acc >> 16)` carry fold).

### 2. The CX II pads any packet whose length is a multiple of 64

The calculator firmware does `if (size & 0x3F == 0) ++size;` on send, so a
1472-byte NNSE packet arrives as **1473 bytes** (a trailing `0x00`). If you
slice exactly the declared `length` field off your receive buffer, the padding
byte stays behind and **shifts every subsequent packet by one byte**, producing
"NNSE checksum mismatch" on the *next* packet — not the padded one.

Fix: after consuming `length` bytes, also drop one more byte whenever
`length % 64 === 0`.

### 3. WebUSB `transferIn` has no timeout — and only one transfer per endpoint

Chrome's `transferIn` resolves when the device sends a short packet or the
buffer fills; if the device goes silent it blocks **forever**. A request/response
loop then freezes on the first lost packet. On top of that, WebUSB allows only
one in-flight transfer per endpoint — issuing a second `transferIn` while one is
pending hangs the tab until the cable is unplugged.

Consequences baked into the code:

- Every `transferIn` races a timeout (5 s steady-state, 30 s during handshake).
- After a timeout you **cannot** just retry — the abandoned transfer still owns
  the endpoint. The only clean recovery is `device.close()` (which aborts the
  pending transfer) and reopen.
- Never `device.reset()`: Chrome treats a USB reset as a disconnect and the
  WebUSB connection breaks.

## Architecture: the UDP-style streaming model

The first design was strict request→response: send a screenshot request, then
await *that specific* header and chunk stream. That meant one dropped packet =
5 s stall = forced reconnect = the calc left in a dirty NavNet state where the
reconnect handshake also failed ("Handshake with the calculator failed"). The
whole stream died at a random frame count.

The fix is to stop caring about individual responses:

1. **A pinger** fires a screenshot request on a timer (`SCREENSHOT_INTERVAL_MS`)
   and never waits for an answer. Fire-and-forget at the NNSE level too (write
   the request, don't block on its ACK).
2. **A reader loop** continuously assembles whatever comes back: a header packet
   (command `0x01`) starts a new frame; chunk packets (command `0x02`) fill it;
   when filled, decode and post it via `onFrame`. A new header simply abandons
   any partial frame — you always show the latest complete one.
3. **Reconnect is the backstop, not the norm.** Only total USB silence
   (transferIn timeout) triggers close+reopen. A lost/corrupted frame is silent
   and harmless because the next request yields a fresh one.

This mirrors the user's "just keep asking, show whatever comes back" model and
eliminates the stall-on-one-packet failure mode.

## Other hard-won details

- **Writes must be serialized.** The pinger writes concurrently with the ACK
  writes that keep the calc streaming; two `transferOut`s on the same endpoint
  at once hang. A promise-chain mutex (`transferChain`) queues them.
- **ACK everything the calc sends with `reqAck` set**, or it stops. The pump
  loop does this before dispatching by service.
- **Do not wait for ACKs of your own NavNet packets** in the streaming path;
  the calc acks regardless and you just consume (and ignore) those ACK packets.
- **Frame chunk cap is 1439 bytes** (`packet_max_datasize - 1`, 1440 − the
  command byte). Take `min(1439, remaining, chunk.length - 1)` per chunk.
- **Screenshot header** (payload of the `0x01` packet) is
  `bwhhhhbb`: command, RLE size (u32 BE), y, x, width, height (u16 BE each),
  bpp, sample. Valid bpp values are 4 and 16.
- **Handshake is slow to start**: the calc can take a while to send its
  AddrReq/Time after connect, so the handshake read timeout must be generous
  (30 s; libnspire uses 60 s) while the steady-state timeout stays short.
- **A dirty calc state is real**: after an aborted mid-stream session the
  calc's NavNet daemon may not re-handshake over software alone. The only
  reliable recovery is a physical unplug/replug. Error messages should say so.

## Tuning

`SCREENSHOT_INTERVAL_MS` in `src/config.ts` is the request period and caps the
frame rate. Because dropped frames are harmless now, it can be lowered safely
(e.g. 500 ms for ~2 fps) if the calc keeps up.
