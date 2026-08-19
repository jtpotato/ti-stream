export const NNSE_HEADER_SIZE = 12;

export const Addr = {
  All: 0xff,
  Me: 0xfe,
  Calc: 0x01,
} as const;

export const Service = {
  AddrReq: 0x01,
  Time: 0x02,
  Echo: 0x03,
  Stream: 0x04,
  Transmit: 0x05,
  Loopback: 0x06,
  Stats: 0x07,
  Unknown: 0x08,
  AckFlag: 0x80,
} as const;

export function internetChecksum(data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    acc += (data[i] << 8) | data[i + 1];
  }
  if (data.length & 1) {
    acc += data[data.length - 1] << 8;
  }
  while (acc >>> 16) {
    acc = (acc >>> 16) + (acc & 0xffff);
  }
  return acc & 0xffff;
}

export type NnsePacket = {
  misc: number;
  service: number;
  src: number;
  dest: number;
  unknown: number;
  reqAck: number;
  length: number;
  seqno: number;
  csum: number;
  data: Uint8Array;
};

export function parseNnse(buf: Uint8Array): NnsePacket {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const length = view.getUint16(6, false);
  return {
    misc: buf[0],
    service: buf[1],
    src: buf[2],
    dest: buf[3],
    unknown: buf[4],
    reqAck: buf[5],
    length,
    seqno: view.getUint16(8, false),
    csum: view.getUint16(10, false),
    data: buf.subarray(NNSE_HEADER_SIZE, length),
  };
}

export function serializeNnse(packet: Omit<NnsePacket, "csum" | "length"> & { data: Uint8Array }): Uint8Array {
  const length = NNSE_HEADER_SIZE + packet.data.length;
  const buf = new Uint8Array(length);
  const view = new DataView(buf.buffer);
  buf[0] = packet.misc;
  buf[1] = packet.service;
  buf[2] = packet.src;
  buf[3] = packet.dest;
  buf[4] = packet.unknown;
  buf[5] = packet.reqAck;
  view.setUint16(6, length, false);
  view.setUint16(8, packet.seqno, false);
  view.setUint16(10, 0, false);
  buf.set(packet.data, NNSE_HEADER_SIZE);
  const csum = internetChecksum(buf) ^ 0xffff;
  view.setUint16(10, csum, false);
  return buf;
}

export function navnetDataChecksum(data: Uint8Array): number {
  let chksum = 0;
  for (let i = 0; i < data.length; i++) {
    const tmp1 = (data[i] << 8) | (chksum >> 8);
    chksum &= 0xff;
    const tmp2 = (((chksum & 0xf) << 4) ^ chksum) << 8;
    const tmp3 = tmp2 >> 5;
    chksum = tmp3 >> 7;
    chksum ^= tmp1 ^ tmp2 ^ tmp3;
    chksum &= 0xffff;
  }
  return chksum;
}

export function headerChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return sum;
}

export type NavNetPacket = {
  srcAddr: number;
  srcSid: number;
  dstAddr: number;
  dstSid: number;
  ack: number;
  seq: number;
  data: Uint8Array;
};

const NAVNET_MAGIC = 0x54fd;

export function serializeNavNet(p: NavNetPacket): Uint8Array {
  const big = p.data.length >= 0xff;
  const payload = big
    ? (() => {
        const out = new Uint8Array(4 + p.data.length);
        new DataView(out.buffer).setUint32(0, p.data.length, false);
        out.set(p.data, 4);
        return out;
      })()
    : p.data;

  const size = 16 + payload.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint16(0, NAVNET_MAGIC, false);
  view.setUint16(2, p.srcAddr, false);
  view.setUint16(4, p.srcSid, false);
  view.setUint16(6, p.dstAddr, false);
  view.setUint16(8, p.dstSid, false);
  view.setUint16(10, navnetDataChecksum(payload), false);
  buf[12] = big ? 0xff : p.data.length;
  buf[13] = p.ack;
  buf[14] = p.seq;
  buf[15] = 0;
  buf.set(payload, 16);
  buf[15] = headerChecksum(buf.subarray(0, 15));
  return buf;
}

export function parseNavNet(buf: Uint8Array): NavNetPacket {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint16(0, false);
  if (magic !== NAVNET_MAGIC) {
    throw new Error(`Bad NavNet magic 0x${magic.toString(16)}`);
  }
  const dataSize = buf[12];
  let data: Uint8Array;
  if (dataSize === 0xff) {
    const bigSize = view.getUint32(16, false);
    data = buf.subarray(20, 20 + bigSize);
  } else {
    data = buf.subarray(16, 16 + dataSize);
  }
  return {
    srcAddr: view.getUint16(2, false),
    srcSid: view.getUint16(4, false),
    dstAddr: view.getUint16(6, false),
    dstSid: view.getUint16(8, false),
    ack: buf[13],
    seq: buf[14],
    data,
  };
}
