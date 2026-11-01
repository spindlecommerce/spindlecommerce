import { crc32, deflateSync } from "node:zlib";

/** Small media files built byte by byte, for type sniffing, dimension parsing and upload tests. */

export const bytes = (...parts: (number[] | Uint8Array | string)[]) => {
  const arrays = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};
export const u16 = (n: number) => [n >> 8, n & 0xff];
export const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, n >> 8];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** A real, decodable RGB PNG. */
export const png = (width: number, height: number) => {
  const chunk = (type: string, data: Uint8Array) => bytes(u32(data.length), type, data, u32(crc32(bytes(type, data))));
  const rows = new Uint8Array(height * (1 + width * 3)).fill(0x80);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk("IHDR", bytes(u32(width), u32(height), [8, 2, 0, 0, 0])), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array()));
};

/** JPEG headers: an EXIF block with an orientation, then a baseline frame header. */
export const jpeg = (width: number, height: number, orientation?: number) => {
  const exif = orientation ? bytes("Exif\0\0", "MM", [0, 42], u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), [0, 0], u32(0)) : null;
  const app1 = exif ? bytes([0xff, 0xe1], u16(exif.length + 2), exif) : bytes();
  const app0 = bytes([0xff, 0xe0], u16(16), "JFIF\0", [1, 1, 0], u16(1), u16(1), [0, 0]);
  const sof = bytes([0xff, 0xc0], u16(17), [8], u16(height), u16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return bytes([0xff, 0xd8], app0, app1, sof, [0xff, 0xd9]);
};

export const gif = (width: number, height: number) => bytes("GIF89a", le16(width), le16(height), [0xf7, 0, 0], new Uint8Array(32));
const riff = (chunk: string, data: Uint8Array) => bytes("RIFF", le32(4 + 8 + data.length), "WEBP", chunk, le32(data.length), data);
export const webpLossy = (width: number, height: number) => riff("VP8 ", bytes([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a], le16(width), le16(height), new Uint8Array(8)));
export const webpLossless = (width: number, height: number) => riff("VP8L", bytes([0x2f], le32((width - 1) | ((height - 1) << 14)), new Uint8Array(8)));
export const webpExtended = (width: number, height: number) => riff("VP8X", bytes([0x10, 0, 0, 0], le24(width - 1), le24(height - 1)));

export const box = (type: string, ...parts: Uint8Array[]) => {
  const body = bytes(...parts);
  return bytes(u32(8 + body.length), type, body);
};
export const fullBox = (type: string, version: number, flags: number, ...parts: Uint8Array[]) => box(type, bytes([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);

/** An AVIF header: item 1 is primary with ispe 3×2 and (optionally) a 90° irot; item 2, a 1×1 thumbnail. */
export const avif = (rotate: boolean) => {
  const ftyp = box("ftyp", bytes("avif", u32(0), "avif", "mif1", "miaf"));
  const ipco = box("ipco", fullBox("ispe", 0, 0, bytes(u32(1), u32(1))), fullBox("ispe", 0, 0, bytes(u32(3), u32(2))), box("irot", bytes([1])));
  const ipma = fullBox("ipma", 0, 0, bytes(u32(2), u16(2), [1, 1], u16(1), rotate ? [2, 0x82, 3] : [1, 0x82]));
  const meta = fullBox("meta", 0, 0, fullBox("hdlr", 0, 0, bytes(u32(0), "pict", u32(0), u32(0), u32(0), [0])), fullBox("pitm", 0, 0, bytes(u16(1))), box("iprp", ipco, ipma));
  return bytes(ftyp, meta, box("mdat", bytes([0, 0, 0, 0])));
};
export const mp4 = () => bytes(box("ftyp", bytes("isom", u32(512), "isom", "iso2", "mp41")), box("mdat", new Uint8Array(16)));
