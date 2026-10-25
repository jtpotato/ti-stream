import { NSP_PID_CX2, SCREENSHOT_INTERVAL_MS, TI_VID } from "../config";
import {
  Addr,
  internetChecksum,
  NavNetPacket,
  NNSE_HEADER_SIZE,
  parseNavNet,
  parseNnse,
  serializeNavNet,
  serializeNnse,
  Service,
  type NnsePacket,
} from "./protocol";

const HOST_ADDR = 0x6400;
const DEVICE_ADDR = 0x6401;
const SCREENSHOT_SID = 0x4024;
const DISCONNECT_SID = 0x40de;
const MAX_NNSE = NNSE_HEADER_SIZE + 1472;
const MAX_STREAM_QUEUE = 32;
const MAX_FRAME_PIXELS = 1_000_000;
/** Steady-state read timeout: a stalled stream should recover in ~6 s. */
const TRANSFER_TIMEOUT_MS = 5000;
/** Handshake timeout: the calc can be slow to respond right after connect. */
const HANDSHAKE_TIMEOUT_MS = 30000;

export type Screenshot = {
  width: number;
  height: number;
  bpp: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
};

type FrameBuilder = {
  rleSize: number;
  width: number;
  height: number;
  bpp: number;
  rle: Uint8Array;
  filled: number;
};

function beginFrame(d: Uint8Array): FrameBuilder | null {
  if (d.length < 15 || d[0] !== 0x01) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const rleSize = view.getUint32(1, false);
  const width = view.getUint16(9, false);
  const height = view.getUint16(11, false);
  const bpp = d[13];
  if (
    !rleSize ||
    rleSize > 2_000_000 ||
    width * height > MAX_FRAME_PIXELS ||
    (bpp !== 4 && bpp !== 16)
  ) {
    return null;
  }
  return { rleSize, width, height, bpp, rle: new Uint8Array(rleSize), filled: 0 };
}

function appendChunk(f: FrameBuilder, d: Uint8Array): boolean {
  if (d.length < 1 || d[0] !== 0x02) return false;
  const take = Math.min(1439, f.rleSize - f.filled, Math.max(0, d.length - 1));
  if (take > 0) {
    f.rle.set(d.subarray(1, 1 + take), f.filled);
    f.filled += take;
  }
  return f.filled >= f.rleSize;
}

function decodeFrame(f: FrameBuilder): Screenshot {
  const outLen = (f.width * f.height * f.bpp) / 8;
  const raw = rleDecode(f.bpp, f.rle, outLen);
  return {
    width: f.width,
    height: f.height,
    bpp: f.bpp,
    rgba: pixelsToRgba(raw, f.width, f.height, f.bpp),
  };
}

function endpointNumber(ep: USBEndpoint): number {
  return ep.endpointNumber;
}

export class NspireCx2 {
  private device: USBDevice;
  private epIn = 1;
  private epOut = 1;
  private nnseSeq = 0;
  private hostSid = 0x8000;
  private handshakeDone = false;
  private closing = false;
  /** Bytes already pulled from USB but not yet parsed into NNSE packets. */
  private rx: Uint8Array = new Uint8Array(0);
  /** Stream payloads that arrived while we were waiting for something else. */
  private streamQ: Uint8Array[] = [];

  constructor(device: USBDevice) {
    this.device = device;
  }

  static async request(): Promise<NspireCx2> {
    if (!navigator.usb) {
      throw new Error("WebUSB is not available. Use Chrome or Edge over http://localhost.");
    }
    const granted = await navigator.usb.getDevices();
    const existing = granted.find((d) => d.vendorId === TI_VID && d.productId === NSP_PID_CX2);
    const device =
      existing ??
      (await navigator.usb.requestDevice({
        filters: [{ vendorId: TI_VID, productId: NSP_PID_CX2 }],
      }));
    const calc = new NspireCx2(device);
    try {
      await calc.open();
    } catch (e) {
      await calc.close().catch(() => {});
      throw e;
    }
    return calc;
  }

  async open(): Promise<void> {
    this.closing = false;
    this.rx = new Uint8Array(0);
    this.streamQ = [];
    await this.device.open();
    // Do not call device.reset(). Chrome treats a USB reset as a disconnect.
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }
    const iface = this.device.configuration?.interfaces[0];
    if (!iface) throw new Error("No USB interface on calculator");
    await this.device.claimInterface(iface.interfaceNumber);

    const alt = iface.alternates[0];
    const bulkIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
    const bulkOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    if (!bulkIn || !bulkOut) throw new Error("Missing bulk endpoints");
    this.epIn = endpointNumber(bulkIn);
    this.epOut = endpointNumber(bulkOut);

    this.nnseSeq = 0;
    this.hostSid = 0x8000;
    this.handshakeDone = false;

    await this.assureReady().catch((e) => {
      throw new Error(
        `Handshake with the calculator failed (${
          e instanceof Error ? e.message : String(e)
        }). Unplug the calculator, plug it back in, then try again.`,
      );
    });
    await this.sendNavNet({
      srcAddr: HOST_ADDR,
      srcSid: 0x4003,
      dstAddr: DEVICE_ADDR,
      dstSid: 0x4003,
      ack: 0,
      seq: 0,
      data: new Uint8Array([0x64, 0x01, 0xff, 0x00]),
    });
  }

  /**
   * Drop the USB interface immediately. Do not send protocol traffic — a capture
   * loop may already own transferIn, and a second IN/OUT on the same endpoints
   * will hang the tab until the cable is unplugged.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.rx = new Uint8Array(0);
    this.streamQ = [];
    try {
      await this.device.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Continuously capture screenshots, "UDP-style": screenshot requests are
   * fired on a timer without waiting for a response, and whatever complete
   * frame arrives is delivered via `onFrame`. A dropped/corrupted frame is
   * simply skipped (the next request yields a fresh one) instead of stalling
   * the stream. Only a full USB silence triggers a reconnect.
   */
  async stream(onFrame: (shot: Screenshot) => void): Promise<void> {
    while (!this.closing) {
      try {
        await this.runStream(onFrame);
        return;
      } catch (e) {
        if (this.closing) return;
        try {
          await this.device.close();
        } catch {
          /* already gone */
        }
        await new Promise((r) => setTimeout(r, 2000));
        if (this.closing) return;
        try {
          await this.open();
        } catch (e2) {
          throw new Error(
            `Stream stalled and reconnecting failed (${
              e2 instanceof Error ? e2.message : String(e2)
            }). Unplug the calculator, plug it back in, then try again.`,
          );
        }
      }
    }
  }

  private async runStream(onFrame: (shot: Screenshot) => void): Promise<void> {
    let active: FrameBuilder | null = null;
    let pingBusy = false;

    const ping = async () => {
      if (pingBusy) return;
      pingBusy = true;
      try {
        await this.sendScreenshotRequest();
      } catch {
        /* next ping retries */
      } finally {
        pingBusy = false;
      }
    };

    void ping();
    const pinger = setInterval(() => void ping(), SCREENSHOT_INTERVAL_MS);
    try {
      while (!this.closing) {
        const nav = await this.recvNavNet();
        if (nav.dstSid !== this.hostSid) {
          await this.sendNavNetNoWait(
            nav.dstSid === DISCONNECT_SID ? ackPacket(nav) : nackPacket(nav),
          ).catch(() => {});
          continue;
        }
        const header = beginFrame(nav.data);
        if (header) {
          active = header;
          continue;
        }
        if (active && appendChunk(active, nav.data)) {
          onFrame(decodeFrame(active));
          active = null;
        }
      }
    } finally {
      clearInterval(pinger);
    }
  }

  private async sendScreenshotRequest(): Promise<void> {
    await this.writeNnse({
      service: Service.Stream,
      src: Addr.Me,
      dest: Addr.Calc,
      reqAck: 1,
      seqno: this.nextSeq(),
      data: serializeNavNet({
        srcAddr: HOST_ADDR,
        srcSid: this.hostSid,
        dstAddr: DEVICE_ADDR,
        dstSid: SCREENSHOT_SID,
        ack: 0,
        seq: 0,
        data: new Uint8Array([0x00]),
      }),
    });
  }

  private async sendNavNetNoWait(packet: NavNetPacket): Promise<void> {
    await this.writeNnse({
      service: Service.Stream,
      src: Addr.Me,
      dest: Addr.Calc,
      reqAck: 1,
      seqno: this.nextSeq(),
      data: serializeNavNet(packet),
    });
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Disconnected");
  }

  private nextSeq(): number {
    const s = this.nnseSeq;
    this.nnseSeq = (this.nnseSeq + 1) & 0xffff;
    return s;
  }

  private transferChain: Promise<void> = Promise.resolve();

  private async transferOut(data: Uint8Array): Promise<void> {
    this.assertOpen();
    const op = this.transferChain.then(async () => {
      this.assertOpen();
      const result = await this.device.transferOut(this.epOut, new Uint8Array(data));
      if (result.status !== "ok" || result.bytesWritten !== data.length) {
        throw new Error(`USB out failed (${result.status})`);
      }
    });
    this.transferChain = op.catch(() => {});
    await op;
  }

  private async transferIn(length: number): Promise<Uint8Array> {
    this.assertOpen();
    const timeoutMs = this.handshakeDone ? TRANSFER_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`USB read timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    const transfer = this.device.transferIn(this.epIn, length);
    transfer.catch(() => {});
    try {
      const result = await Promise.race([transfer, timeout]);
      clearTimeout(timer);
      if (this.closing) throw new Error("Disconnected");
      if (result.status !== "ok" || !result.data) {
        throw new Error(`USB in failed (${result.status})`);
      }
      return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  private async readNnse(): Promise<NnsePacket> {
    while (true) {
      this.assertOpen();
      if (this.rx.length >= NNSE_HEADER_SIZE) {
        const total = new DataView(this.rx.buffer, this.rx.byteOffset, this.rx.byteLength).getUint16(
          6,
          false,
        );
        if (total < NNSE_HEADER_SIZE || total > MAX_NNSE) {
          throw new Error(`Bad NNSE length ${total}`);
        }
        if (this.rx.length >= total) {
          const raw = this.rx.subarray(0, total);
          // CX II firmware appends one padding byte to packets whose total
          // length is a multiple of 64 (its size check does `size & 0x3F → ++size`).
          const padding = total % 64 === 0 && this.rx.length > total ? 1 : 0;
          this.rx = this.rx.slice(total + padding);
          if (internetChecksum(raw) !== 0xffff) {
            throw new Error("NNSE checksum mismatch");
          }
          return parseNnse(raw);
        }
      }
      const chunk = await this.transferIn(MAX_NNSE);
      const next = new Uint8Array(this.rx.length + chunk.length);
      next.set(this.rx);
      next.set(chunk, this.rx.length);
      this.rx = next;
    }
  }

  private async writeNnse(partial: {
    misc?: number;
    service: number;
    src: number;
    dest: number;
    unknown?: number;
    reqAck?: number;
    seqno: number;
    data?: Uint8Array;
  }): Promise<void> {
    const bytes = serializeNnse({
      misc: partial.misc ?? 0,
      service: partial.service,
      src: partial.src,
      dest: partial.dest,
      unknown: partial.unknown ?? 0,
      reqAck: partial.reqAck ?? 0,
      seqno: partial.seqno,
      data: partial.data ?? new Uint8Array(),
    });
    await this.transferOut(bytes);
  }

  private async ackNnse(message: NnsePacket): Promise<void> {
    if (!(message.reqAck & 1)) return;
    await this.writeNnse({
      misc: message.misc,
      service: message.service | Service.AckFlag,
      src: message.dest,
      dest: message.src,
      unknown: message.unknown,
      reqAck: message.reqAck & ~1,
      seqno: message.seqno,
    });
  }

  /** Read one NNSE packet, ACK it if needed, queue stream payloads. */
  private async pump(): Promise<NnsePacket> {
    const message = await this.readNnse();
    if (message.dest !== Addr.Me && message.dest !== Addr.All) {
      return message;
    }
    if (message.service & Service.AckFlag) {
      return message;
    }
    await this.ackNnse(message);

    const svc = message.service & ~Service.AckFlag;
    switch (svc) {
      case Service.AddrReq: {
        if (message.data[0] !== 0) break;
        const resp = {
          service: message.service,
          src: Addr.Me,
          dest: Addr.Calc,
          data: new Uint8Array([0x80]),
        };
        await this.writeNnse({ ...resp, seqno: this.nextSeq() });
        await this.writeNnse({ ...resp, seqno: this.nextSeq() });
        break;
      }
      case Service.Time: {
        if (message.data[0] !== 0) break;
        const sec = Math.floor(Date.now() / 1000);
        const data = new Uint8Array(17);
        const view = new DataView(data.buffer);
        data[0] = 0x80;
        view.setUint32(1, sec, false);
        await this.writeNnse({
          service: message.service,
          src: Addr.Me,
          dest: Addr.Calc,
          seqno: this.nextSeq(),
          data,
        });
        this.handshakeDone = true;
        break;
      }
      case Service.Unknown: {
        if (message.data.length === 1 && message.data[0] === 0x01) {
          await this.writeNnse({
            service: message.service,
            src: Addr.Me,
            dest: Addr.Calc,
            seqno: this.nextSeq(),
            data: new Uint8Array([0x81, 0x03]),
          });
        }
        break;
      }
      case Service.Stream:
        // A stalled consumer must not retain an unbounded number of USB
        // payloads. Dropping the backlog is safe because the next header
        // starts a fresh frame.
        if (this.streamQ.length >= MAX_STREAM_QUEUE) this.streamQ = [];
        this.streamQ.push(message.data.slice());
        break;
    }
    return message;
  }

  private async assureReady(): Promise<void> {
    if (this.handshakeDone) return;
    for (let i = 0; i < 20 && !this.handshakeDone; i++) {
      await this.pump();
    }
    if (!this.handshakeDone) {
      throw new Error("CX II handshake timed out (no time request)");
    }
  }

  private async sendNavNet(packet: NavNetPacket): Promise<void> {
    await this.assureReady();
    const nav = serializeNavNet(packet);
    const seqno = this.nextSeq();
    await this.writeNnse({
      service: Service.Stream,
      src: Addr.Me,
      dest: Addr.Calc,
      reqAck: 1,
      seqno,
      data: nav,
    });

    for (let i = 0; i < 64; i++) {
      const pkt = await this.pump();
      if (
        pkt.dest === Addr.Me &&
        pkt.service === (Service.Stream | Service.AckFlag) &&
        pkt.seqno === seqno
      ) {
        return;
      }
    }
    throw new Error("NNSE stream packet was not acknowledged");
  }

  private async recvNavNet(): Promise<NavNetPacket> {
    await this.assureReady();
    if (this.streamQ.length > 0) {
      return parseNavNet(this.streamQ.shift()!);
    }
    for (let i = 0; i < 64; i++) {
      await this.pump();
      if (this.streamQ.length > 0) {
        return parseNavNet(this.streamQ.shift()!);
      }
    }
    throw new Error("No NavNet stream packet received");
  }
}

function ackPacket(p: NavNetPacket): NavNetPacket {
  return {
    srcAddr: HOST_ADDR,
    srcSid: p.seq ? 0xff : 0xfe,
    dstAddr: DEVICE_ADDR,
    dstSid: p.srcSid,
    ack: 0x0a,
    seq: p.seq,
    data: new Uint8Array([(p.dstSid >> 8) & 0xff, p.dstSid & 0xff]),
  };
}

function nackPacket(p: NavNetPacket): NavNetPacket {
  return { ...ackPacket(p), srcSid: 0xd3 };
}

function rleDecode(bpp: number, input: Uint8Array, outSize: number): Uint8Array {
  const unit = (bpp * 2) / 8;
  const out = new Uint8Array(outSize);
  let i = 0;
  let o = 0;
  while (i + 1 <= input.length && o < outSize) {
    const rec = (input[i] << 24) >> 24;
    i += 1;
    if (rec < 0) {
      let len = (-rec + 1) * unit;
      len = Math.min(len, outSize - o, input.length - i);
      out.set(input.subarray(i, i + len), o);
      i += len;
      o += len;
    } else {
      if (input.length - i < unit) break;
      const count = rec + 1;
      for (let n = 0; n < count && o + unit <= outSize; n++) {
        out.set(input.subarray(i, i + unit), o);
        o += unit;
      }
      i += unit;
    }
  }
  return out;
}

function pixelsToRgba(
  raw: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (bpp === 16) {
    for (let i = 0; i < width * height; i++) {
      const px = raw[i * 2] | (raw[i * 2 + 1] << 8);
      const r = ((px >> 11) & 0x1f) * (255 / 31);
      const g = ((px >> 5) & 0x3f) * (255 / 63);
      const b = (px & 0x1f) * (255 / 31);
      const o = i * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
    return rgba;
  }

  if (bpp === 4) {
    for (let i = 0; i < width * height; i += 2) {
      const byte = raw[i >> 1] ?? 0;
      const hi = (byte >> 4) & 0xf;
      const lo = byte & 0xf;
      for (const [idx, nibble] of [
        [i, hi],
        [i + 1, lo],
      ] as const) {
        if (idx >= width * height) break;
        const g = nibble * 17;
        const o = idx * 4;
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  throw new Error(`Unsupported screenshot bpp ${bpp}`);
}
