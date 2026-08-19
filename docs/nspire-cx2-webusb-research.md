# How the TI-Nspire CX II CAS WebUSB screenshot path was found

This is a research log for the protocol used in this repo. It is written so a later person (or model) can reconstruct the same stack without rediscovering each source from scratch.

Goal that started this: a browser app that uses **WebUSB**, connects to a **TI-Nspire CX II CAS**, and captures the LCD on a timer.

There is no public TI spec for the link protocol. The working picture is stitched from community docs, a C library that already talks to CX II units, and a few GitHub threads that name the extra wrapper CX II added on top of classic Nspire USB.

## 1. Confirm that WebUSB is a real path

Official software already does this in a browser:

- Product: [TI-Nspire CX II Connect](https://education.ti.com/eu/products/computer-software/ti-nspire-cx-ii-connect)
- Host: `nspireconnect.ti.com`
- Guidebook: screen capture, `.tns` transfer, OS update; requires a WebUSB-capable browser

That answers two questions immediately:

1. Chrome/Edge WebUSB can see a CX II CAS.
2. Screenshot is a first-class USB feature, not something that only exists in desktop TI-Nspire Computer Software.

It does **not** document packets. TI’s web app is a closed blob. Next step is reverse-engineered protocol notes, not the official guidebook.

USB IDs (needed for `navigator.usb.requestDevice` filters):

| Field | Value | Notes |
| --- | --- | --- |
| `idVendor` | `0x0451` | Texas Instruments |
| `idProduct` (classic Nspire / CX) | `0xE012` | Hackspire USB descriptors |
| `idProduct` (CX II family) | `0xE022` | Same page; also n-link udev rules |

Source for descriptors: [Hackspire — USB Protocol](https://hackspire.org/USB_Protocol/).

On Linux, n-link documents udev rules that tag both PIDs as `ID_PDA=1` so userspace can open the device. macOS/Windows/Chrome OS usually need TI’s software **not** to hold the interface.

## 2. Classic Nspire packets (NavNet) — Hackspire

Hackspire’s USB Protocol page is the best single write-up of the **pre-CX II** link. It was built from Computer Link Software, USB captures, and TiLP.

Useful facts taken from that page:

- Vendor-specific interface: bulk IN + bulk OUT (64-byte max on older units).
- A **protocol packet** can span multiple USB packets.
- Header is 16 bytes, constant `54 FD`, then source/dest address, source/dest **service ID**, data checksum, size, ACK field, sequence, header checksum.
- Host address in examples: `0x6400`. Device address: `0x6401`.
- After plug-in you reset the port, wait for an address request on service `0x4003`, then assign `0x6401`.
- Screenshot services:
  - `0x4021` — uncompressed capture
  - `0x4024` — RLE capture (what implementations actually use)
- RLE request is a single data byte `00`. First reply starts with command `01` plus a header:

  - 4-byte RLE payload size
  - x/y (usually 0)
  - width / height (CX: 320×240)
  - bits per pixel
  - sample model

  Later packets are `02` plus a chunk of RLE bytes.

The RLE description on Hackspire is written for **4-bit grayscale**. Color calculators are not fully documented there.

**Do not stop at Hackspire if the calculator is a CX II.** Several people independently say CX II does not speak this framing on the wire.

## 3. The CX II fork: NNSE wraps NavNet

Search hits that name the extra layer:

- [Timendus/ticalc-usb#34](https://github.com/Timendus/ticalc-usb/issues/34) — Lionel Debroux: CX II uses **NNSE**, “some form of wrapping on top of a variant of the NavNet protocol.”
- [tilp_and_gfm#33](https://github.com/debrouxl/tilp_and_gfm/issues/33) — libticalcs had no complete CX II implementation; Vogtinator’s **libnspire fork** was the practical option.
- [n-link](https://github.com/lights0123/n-link) — browser + desktop linker, WebUSB, CX II file transfer. Screenshots were blocked for a long time by a libnspire decoder bug (see below).

So the stack to copy is not TiLP’s `nsp_cmd.cc` as-is. It is:

```
WebUSB bulk IN 0x81 / OUT 0x01
        ↓
NNSE (12-byte header, services, seq, internet checksum)
        ↓
NavNet (16-byte 54 FD header, service IDs)
        ↓
Screenshot service 0x4024
```

The only complete open implementation of NNSE found for this work is:

**[Vogtinator/libnspire](https://github.com/Vogtinator/libnspire)** — especially `src/cx2.cpp`, `src/packet.c`, `src/data.c`, `src/init.c`, `src/usb.c`, `src/services/screenshot.c`.

n-link is a consumer of that library (plus a WASM/WebUSB backend). It is useful for VID/PID and “this works in Chrome,” less useful as a packet spec because the protocol lives in C.

## 4. NNSE, as implemented in `cx2.cpp`

File: [`src/cx2.cpp`](https://github.com/Vogtinator/libnspire/blob/master/src/cx2.cpp).

On-wire header (big-endian multi-byte fields), 12 bytes:

| Offset | Field | Meaning |
| --- | --- | --- |
| 0 | `misc` | unused in practice |
| 1 | `service` | service number; bit 7 set = ACK |
| 2 | `src` | `0xFE` = host, `0x01` = calc, `0xFF` = all |
| 3 | `dest` | same address space |
| 4 | `unknown` | copied back in ACKs |
| 5 | `reqAck` | bit 0: peer wants an ACK |
| 6–7 | `length` | total size **including** this header |
| 8–9 | `seqno` | incremented for non-ACK packets |
| 10–11 | `csum` | RFC1071-style 16-bit checksum; stored so the whole packet sums to `0xFFFF` |

Services used during connect:

| Service | Role |
| --- | --- |
| `0x01` | Address request from the calc. Host replies with a 1-byte address `0x80`, **twice** (first packet is sometimes ignored after reconnect). |
| `0x02` | Time request. Host replies with `0x80` + unix seconds (and zeroed fraction fields). Handshake is considered complete after this. |
| `0x08` | Short unknown probe (`01`). Host replies `81 03`. |
| `0x04` | **Stream.** NavNet bytes live in `data[]`. Host sets `reqAck = 1` when sending. |

Bulk endpoints in this file are hardcoded: **IN `0x81`, OUT `0x01`**. Classic libnspire `usb.c` instead walks the interface for the first bulk IN/OUT pair (needed in recovery mode). For a normal CX II OS, those two agree.

Checksum:

```
sum 16-bit big-endian words (odd trailing byte padded as high byte)
fold carries
stored field = htons(sum ^ 0xFFFF)
```

`packet_send_cx2` will not send NavNet until `cx2_handshake_complete` is true (time response has been sent). `packet_recv_cx2` unwraps stream payloads into the same NavNet `struct packet` used on older calcs.

## 5. NavNet send/recv after the wrapper

Files: `packet.c`, `data.c`, `init.c`, `service.c`.

CX II differences vs classic:

- **No** wait for a NavNet address-request packet in `nspire_init`. Handshake already happened in NNSE.
- Init still **sends** NavNet data `64 01 FF 00` on services `4003 → 4003` (assign device address `0x6401`), then sets host service id to `0x8000`.
- NavNet sequence field is forced to `0` on CX II (`packet_new`).
- NavNet ACKs (`src_sid` `0x00FF`/`0x00FE`, `ack = 0x0A`) are **not** used on CX II. Reliability is the NNSE ACK on stream packets.
- Max NavNet data size is **1440** bytes on CX II vs **254** on older models. Size `0xFF` in the header means a 4-byte big-endian length follows, then the payload.
- Connecting to a service is just setting `device_sid`. Disconnect is service `0x40DE` with the old host sid as payload, then increment `host_sid`.

Spurious packets (login, disconnect) are NACKed or ACKed in `data_read` / `handle_unknown`. On CX II you still may see NNSE control packets interleaved; `handlePacket` ACKs them and continues.

Header checksum on Hackspire is “sum of the previous 15 bytes mod 256.” Data checksum is the unusual CRC listed on that page (the Python snippet). This repo checksums the **serialized big-endian bytes**. libnspire overlays a C struct and byte-swaps after computing checksums; treat that as an implementation detail and verify against captures if a peer rejects packets.

## 6. Screenshot (`0x4024`) and color RLE

File: [`src/services/screenshot.c`](https://github.com/Vogtinator/libnspire/blob/master/src/services/screenshot.c).

Flow:

1. `service_connect(..., 0x4024)`
2. Write one byte `0x00`
3. Read header; scan format `bwhhhhbb` → command, RLE size, y, x, width, height, bpp, sample
4. Read remaining RLE in chunks. Each NavNet payload starts with command `0x02`; skip that byte. Chunk cap is `packet_max_datasize - 1` (1439 on CX II).
5. RLE-decode into `width * height * bpp / 8` bytes
6. Disconnect service (optional if you keep the session open for a capture loop)

### Color RLE (this is the part Hackspire gets wrong)

[Vogtinator/libnspire#1](https://github.com/Vogtinator/libnspire/issues/1) + commit [`7d7d962`](https://github.com/Vogtinator/libnspire/commit/7d7d962ca49ff9017f6f146336c51ef7f2edf4e0):

TiLP’s `CALC_PIXFMT_RGB_565_LE` does **not** RLE on single bytes. It RLE-encodes **2 pixels at a time** (4 bytes at 16 bpp). Same control byte as grayscale:

- `len >= 0`: repeat the next unit `len + 1` times
- `len < 0`: copy `(-len + 1)` literal units

Unit size = `(bpp * 2) / 8`. Gray 4 bpp → 1 byte; RGB565 → 4 bytes.

libnspire `Image.bpp` is 16 on color handhelds. Pixels are **RGB565 little-endian** (TiLP’s `RGB_565_LE`). Convert with:

```
px = data[i*2] | (data[i*2+1] << 8)
r = (px >> 11) & 0x1f
g = (px >> 5) & 0x3f
b = px & 0x1f
```

n-link’s site used to say screenshots were blocked on that issue. After `7d7d962`, Vogtinator reported it tested on a CX II. That is the decoder this app ports.

## 7. Mapping libusb to WebUSB

libnspire `usb.c` order: open by VID/PID → `set_configuration(1)` → **`libusb_reset_device`** → `claim_interface(0)` → discover endpoints.

That reset is correct for a native host that wants the calc to forget old service IDs. It is **wrong** to copy blindly into WebUSB.

Chrome’s `USBDevice.reset()` re-enumerates the gadget. The `USBDevice` you just `open()`’d is then dead. The next `claimInterface()` throws:

```text
Failed to execute 'claimInterface' on 'USBDevice': The device was disconnected.
```

This repo’s first WebUSB open path copied libusb and hit exactly that error. Fix: **do not reset** in the browser. Open → `selectConfiguration(1)` if needed → `claimInterface`. If the calc is in a dirty NavNet state, unplug/replug (hardware reset) instead of `device.reset()`.

Other WebUSB constraints:

- Secure context: `https://` or `http://localhost`
- Chromium-family browsers
- `transferIn` / `transferOut` use the endpoint **number** without the direction bit (`1`, not `0x81`)
- Reassemble NNSE by reading the 16-bit `length` field, then pulling remaining bulk data
- Close TI-Nspire Student Software / CX II Connect so nothing else owns the interface

## 8. What was not used

- Compiling libnspire to WASM (n-link already did this; it is GPL and heavy for a screenshot loop).
- Official Connect JS (minified, no packet comments).
- Classic TiLP-only NavNet without NNSE (will not speak CX II on the bus).

## 9. Suggested reading order for a reimplementation

1. Hackspire USB Protocol — packet layout, service IDs, screenshot header, RLE *idea*
2. `libnspire/src/cx2.cpp` — NNSE handshake and stream wrap
3. `libnspire/src/init.c` + `packet.c` + `data.c` — NavNet on top of that wrap
4. `libnspire/src/services/screenshot.c` + issue #1 — color RLE
5. n-link README — VID/PID, udev, “WebUSB works in Chrome”
6. This repo `src/nspire/protocol.ts` + `src/nspire/device.ts` — TypeScript port of the above

## 10. Constants cheat sheet

```
VID                 0x0451
PID CX II           0xE022
USB config          1
USB interface       0
Bulk OUT            1 (0x01)
Bulk IN             1 (0x81)

NNSE host addr      0xFE
NNSE calc addr      0x01
NNSE stream         0x04
NNSE ACK flag       0x80

NavNet host         0x6400
NavNet device       0x6401
Screenshot service  0x4024
Disconnect service  0x40DE
```
