import type { MediaKind } from "./tables.ts";

/** Accepted types, recognized by their bytes. No SVG: it can carry script. */
export const MEDIA_TYPES = [
  { contentType: "image/jpeg", extension: "jpg", kind: "image", label: "JPEG" },
  { contentType: "image/png", extension: "png", kind: "image", label: "PNG" },
  { contentType: "image/gif", extension: "gif", kind: "image", label: "GIF" },
  { contentType: "image/webp", extension: "webp", kind: "image", label: "WebP" },
  { contentType: "image/avif", extension: "avif", kind: "image", label: "AVIF" },
  { contentType: "video/mp4", extension: "mp4", kind: "video", label: "MP4" },
] as const satisfies readonly { contentType: string; extension: string; kind: MediaKind; label: string }[];

export type MediaType = (typeof MEDIA_TYPES)[number];
export type MediaContentType = MediaType["contentType"];

export const ALLOWED_CONTENT_TYPES: string[] = MEDIA_TYPES.map((t) => t.contentType);
export const MEDIA_EXTENSIONS: string[] = MEDIA_TYPES.map((t) => t.extension);
/** "JPEG, PNG, GIF, WebP, AVIF or MP4", for error messages. */
export const ALLOWED_LABELS = `${MEDIA_TYPES.slice(0, -1).map((t) => t.label).join(", ")} or ${MEDIA_TYPES.at(-1)!.label}`;

export const mediaType = (contentType: string): MediaType | null => MEDIA_TYPES.find((t) => t.contentType === contentType.trim().toLowerCase()) ?? null;
export const mediaTypeByExtension = (extension: string): MediaType | null => MEDIA_TYPES.find((t) => t.extension === extension.toLowerCase()) ?? null;

export const SNIFF_BYTES = 64 * 1024;

export const concatBytes = (chunks: Uint8Array[], total = chunks.reduce((sum, c) => sum + c.length, 0)): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, total - at), at);
    at += Math.min(chunk.length, total - at);
    if (at >= total) break;
  }
  return out;
};

/** Up to `limit` bytes. With `exact`, a longer stream gives null instead of a prefix. */
export const readStream = async (stream: ReadableStream<Uint8Array> | null, limit: number, options: { exact?: boolean } = {}): Promise<Uint8Array | null> => {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > limit && options.exact) return null;
      if (total >= limit && !options.exact) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concatBytes(chunks, Math.min(total, limit));
};

/** The start of a ranged GET's body (200 means the server ignored the range). Null on 404. */
export const responsePrefix = async (response: Response, length: number): Promise<Uint8Array | null> => {
  if (response.status === 200 || response.status === 206) return readStream(response.body, length);
  await response.body?.cancel().catch(() => {});
  if (response.status === 404) return null;
  throw new Error(`Reading the start of the file failed with ${response.status}`);
};

const ascii = (b: Uint8Array, start: number, length: number) => (start + length <= b.length ? String.fromCharCode(...b.subarray(start, start + length)) : "");
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MP4_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]);

/** An ISO base media file's brands, major first; null without an `ftyp` box. */
const ftypBrands = (b: Uint8Array): string[] | null => {
  if (ascii(b, 4, 4) !== "ftyp" || b.length < 12) return null;
  const size = Math.min(view(b).getUint32(0), b.length);
  const brands = [ascii(b, 8, 4)];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(b, at, 4));
  return brands;
};

export const sniffMediaType = (b: Uint8Array): MediaType | null => {
  const is = (contentType: MediaContentType) => MEDIA_TYPES.find((t) => t.contentType === contentType)!;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return is("image/jpeg");
  if (PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return is("image/png");
  if (ascii(b, 0, 4) === "GIF8") return is("image/gif");
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return is("image/webp");
  const brands = ftypBrands(b);
  if (brands?.some((brand) => brand === "avif" || brand === "avis")) return is("image/avif");
  if (brands && MP4_BRANDS.has(brands[0]!)) return is("video/mp4");
  return null;
};

export type Dimensions = { width: number; height: number };

const valid = (d: Dimensions | null): Dimensions | null =>
  d && Number.isInteger(d.width) && Number.isInteger(d.height) && d.width > 0 && d.height > 0 && d.width <= 1_000_000 && d.height <= 1_000_000 ? d : null;

const png = (b: Uint8Array): Dimensions | null => (ascii(b, 12, 4) === "IHDR" && b.length >= 24 ? { width: view(b).getUint32(16), height: view(b).getUint32(20) } : null);

const gif = (b: Uint8Array): Dimensions | null => (b.length >= 10 ? { width: view(b).getUint16(6, true), height: view(b).getUint16(8, true) } : null);

const webp = (b: Uint8Array): Dimensions | null => {
  const v = view(b);
  switch (ascii(b, 12, 4)) {
    case "VP8 ": // lossy: a 3-byte frame tag, the start code 9d 01 2a, then 14-bit sizes
      return b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff } : null;
    case "VP8L": {
      // lossless: the signature 0x2f, then width - 1 and height - 1 in 14 bits each
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X": // extended: 24-bit canvas width - 1 and height - 1 after the flags
      return b.length >= 30 ? { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) } : null;
    default:
      return null;
  }
};

/** EXIF orientation (1–8) from an APP1 payload. A damaged block gives null, not an error. */
const exifOrientation = (b: Uint8Array, start: number, end: number): number | null => {
  if (ascii(b, start, 6) !== "Exif\0\0") return null;
  const tiff = start + 6;
  const little = ascii(b, tiff, 2) === "II";
  if ((!little && ascii(b, tiff, 2) !== "MM") || tiff + 8 > end) return null;
  try {
    const v = view(b);
    const ifd = tiff + v.getUint32(tiff + 4, little);
    if (ifd + 2 > end) return null;
    const count = v.getUint16(ifd, little);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) return null;
      if (v.getUint16(entry, little) === 0x0112) {
        const value = v.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch {
    // Offsets pointing past the buffer.
  }
  return null;
};

/** Frame header markers (SOF0–SOF15) other than DHT, JPG and DAC. */
const isFrameHeader = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** EXIF orientations 5–8 rotate by 90°, so width and height swap as displayed. */
const jpeg = (b: Uint8Array): Dimensions | null => {
  const v = view(b);
  let orientation = 1;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // image data before any frame header
    const length = v.getUint16(at + 2);
    if (length < 2) return null;
    if (marker === 0xe1) orientation = exifOrientation(b, at + 4, Math.min(b.length, at + 2 + length)) ?? orientation;
    if (isFrameHeader(marker)) {
      if (at + 9 > b.length) return null;
      const height = v.getUint16(at + 5);
      const width = v.getUint16(at + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    at += 2 + length;
  }
  return null;
};

type Box = { type: string; body: number; end: number };

/** ISO BMFF boxes between `start` and `end`; a box cut off by the end of the buffer ends there. */
const boxes = (b: Uint8Array, start: number, end: number): Box[] => {
  const v = view(b);
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(v.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header) break;
    found.push({ type: ascii(b, at + 4, 4), body: at + header, end: Math.min(at + size, end) });
    at += size;
  }
  return found;
};

/**
 * The primary item's `ispe` (image spatial extents) from meta → iprp → ipco, found through pitm and
 * ipma; a 90° or 270° `irot` swaps width and height as displayed.
 */
const avif = (b: Uint8Array): Dimensions | null => {
  const v = view(b);
  const meta = boxes(b, 0, b.length).find((box) => box.type === "meta");
  if (!meta) return null;
  let primary: number | null = null;
  let ipco: Box | undefined;
  let ipma: Box | undefined;
  for (const box of boxes(b, meta.body + 4, meta.end)) {
    if (box.type === "pitm") primary = b[box.body] === 0 ? v.getUint16(box.body + 4) : v.getUint32(box.body + 4);
    if (box.type === "iprp") {
      const children = boxes(b, box.body, box.end);
      ipco = children.find((c) => c.type === "ipco");
      ipma = children.find((c) => c.type === "ipma");
    }
  }
  if (!ipco) return null;
  const properties = boxes(b, ipco.body, ipco.end);
  let associated: Box[] | null = null;
  if (ipma && primary !== null) {
    const version = b[ipma.body]!;
    const wide = (b[ipma.body + 3]! & 1) === 1;
    let at = ipma.body + 4;
    const entries = v.getUint32(at);
    at += 4;
    for (let i = 0; i < entries && at < ipma.end; i++) {
      const item = version < 1 ? v.getUint16(at) : v.getUint32(at);
      at += version < 1 ? 2 : 4;
      const count = b[at]!;
      at += 1;
      const indexes: number[] = [];
      for (let j = 0; j < count; j++) {
        indexes.push(wide ? v.getUint16(at) & 0x7fff : b[at]! & 0x7f);
        at += wide ? 2 : 1;
      }
      if (item === primary) {
        associated = indexes.flatMap((index) => properties[index - 1] ?? []);
        break;
      }
    }
  }
  // Without associations, the largest extents are the full image rather than a tile or thumbnail.
  const extents = (associated ?? properties).filter((p) => p.type === "ispe" && p.body + 12 <= b.length).map((p) => ({ width: v.getUint32(p.body + 4), height: v.getUint32(p.body + 8) }));
  const size = extents.sort((x, y) => y.width * y.height - x.width * x.height)[0];
  if (!size) return null;
  const irot = (associated ?? properties).find((p) => p.type === "irot");
  return irot && (b[irot.body]! & 3) % 2 === 1 ? { width: size.height, height: size.width } : size;
};

const PARSERS: Partial<Record<MediaContentType, (b: Uint8Array) => Dimensions | null>> = {
  "image/jpeg": jpeg,
  "image/png": png,
  "image/gif": gif,
  "image/webp": webp,
  "image/avif": avif,
};

/** Dimensions as displayed, from the file's first bytes (64 KB almost always suffices). */
export const imageDimensions = (b: Uint8Array): Dimensions | null => {
  const type = sniffMediaType(b);
  const parse = type ? PARSERS[type.contentType] : undefined;
  if (!parse) return null;
  try {
    return valid(parse(b));
  } catch {
    // A header cut off mid-field reads past the buffer.
    return null;
  }
};
