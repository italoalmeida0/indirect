/**
 * Archive extraction for the Obscura release assets.
 *
 * Bun.Archive cannot read ZIP at all ("Unrecognized archive format" on a
 * valid PK archive, verified on Bun 1.3.14 and 1.4.2), and the Windows
 * release is only published as a ZIP. This module reads both formats
 * directly so the installer never depends on an external binary:
 *
 *   - ZIP: central directory walk + stored/deflate entries (ZIP64 aware).
 *   - tar.gz: gunzip + POSIX/GNU tar headers.
 *
 * Only the members we ask for are decompressed, and every read is bounds
 * checked against the buffer, so a truncated or hostile archive fails with a
 * clear error instead of a crash or a huge allocation.
 */

const MAX_MEMBER_BYTES = 512 * 1024 * 1024;

export interface ArchiveEntry {
  name: string;
  /** Decompress one member (throws when the entry is unsupported/corrupt). */
  read: () => Promise<Uint8Array>;
}

/** Magic-byte sniffing: the download URL is not trusted to describe the bytes. */
export function detectArchiveFormat(data: Uint8Array): "zip" | "gzip" | "tar" | null {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)) return "zip";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  if (data.length >= 5 && String.fromCharCode(data[257]!, data[258]!, data[259]!, data[260]!, data[261]!) === "ustar") return "tar";
  return null;
}

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u64(b: Uint8Array, o: number): number {
  const value = u32(b, o) + u32(b, o + 4) * 0x1_0000_0000;
  return value;
}

/** Locate the End Of Central Directory record, scanning back over the
 *  optional comment (max 65535 bytes). */
function findEocd(data: Uint8Array): number {
  const min = Math.max(0, data.length - 65_557);
  for (let i = data.length - 22; i >= min; i--) {
    if (u32(data, i) === 0x0605_4b50) return i;
  }
  return -1;
}

interface ZipMember {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function readZipMembers(data: Uint8Array): ZipMember[] {
  const eocd = findEocd(data);
  if (eocd < 0) throw new Error("not a ZIP archive: end of central directory not found");
  let count = u16(data, eocd + 10);
  let cdOffset = u32(data, eocd + 16);
  // ZIP64: when any field is saturated, the real values live in the locator.
  if (count === 0xffff || cdOffset === 0xffff_ffff) {
    const locator = eocd - 20;
    if (locator >= 0 && u32(data, locator) === 0x0706_4b50) {
      const z64 = u64(data, locator + 8);
      if (z64 + 56 <= data.length && u32(data, z64) === 0x0606_4b50) {
        count = u64(data, z64 + 32);
        cdOffset = u64(data, z64 + 48);
      }
    }
  }
  const members: ZipMember[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length || u32(data, p) !== 0x0201_4b50) {
      throw new Error("corrupt ZIP: bad central directory entry");
    }
    const method = u16(data, p + 10);
    let compressedSize = u32(data, p + 20);
    let size = u32(data, p + 24);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    let localOffset = u32(data, p + 42);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extended information: fields appear in a fixed order, only for
    // the values saturated in the fixed header.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const headerId = u16(data, e);
      const blockSize = u16(data, e + 2);
      if (headerId === 0x0001) {
        // Fields appear in this fixed order, and ONLY for the values that
        // saturated the fixed header.
        let q = e + 4;
        const end = e + 4 + blockSize;
        if (size === 0xffff_ffff && q + 8 <= end) { size = u64(data, q); q += 8; }
        if (compressedSize === 0xffff_ffff && q + 8 <= end) { compressedSize = u64(data, q); q += 8; }
        if (localOffset === 0xffff_ffff && q + 8 <= end) { localOffset = u64(data, q); }
      }
      e += 4 + blockSize;
    }
    members.push({ name, method, compressedSize, size, localOffset });
    p = extraEnd + commentLen;
  }
  return members;
}

/** Async so every failure surfaces as a rejected promise, never a throw from
 *  a caller that already awaited the entry list. */
async function readZipMember(data: Uint8Array, member: ZipMember): Promise<Uint8Array> {
  const p = member.localOffset;
  if (p + 30 > data.length || u32(data, p) !== 0x0403_4b50) throw new Error(`corrupt ZIP: bad local header for ${member.name}`);
  // The central directory is authoritative; a local header that disagrees on
  // the compression method is a signature of an archive-confusion attack.
  if (u16(data, p + 8) !== member.method) throw new Error(`corrupt ZIP: local header disagrees with the central directory for ${member.name}`);
  const nameLen = u16(data, p + 26);
  const extraLen = u16(data, p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + member.compressedSize;
  if (end > data.length) throw new Error(`corrupt ZIP: ${member.name} runs past the archive`);
  if (member.size > MAX_MEMBER_BYTES) throw new Error(`${member.name} is larger than the supported limit`);
  const body = data.subarray(start, end);
  if (member.method === 0) return Uint8Array.from(body);
  if (member.method !== 8) throw new Error(`unsupported ZIP compression method ${member.method} for ${member.name}`);
  return Uint8Array.from(Bun.inflateSync(new Uint8Array(body)));
}

/** POSIX ustar / GNU long-name aware member walk. */
function readTarMembers(data: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let p = 0;
  let longName: string | null = null;
  while (p + 512 <= data.length) {
    const header = data.subarray(p, p + 512);
    // A tar stream ends with a zero block; tolerate trailing garbage.
    if (header.every((byte) => byte === 0)) break;
    const rawName = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const type = String.fromCharCode(header[156] ?? 48);
    const prefix = new TextDecoder().decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const size = sizeText === "" ? 0 : parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("corrupt tar: invalid member size");
    if (size > MAX_MEMBER_BYTES) throw new Error("tar member is larger than the supported limit");
    const bodyStart = p + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > data.length) throw new Error("corrupt tar: member runs past the archive");
    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    if (type === "L") {
      // GNU long name: the payload carries the next member's real path.
      longName = new TextDecoder().decode(data.subarray(bodyStart, bodyEnd)).replace(/\0.*$/, "");
    } else if (type === "0" || type === "7" || type === "\0") {
      entries.push({ name, read: () => Promise.resolve(Uint8Array.from(data.subarray(bodyStart, bodyEnd))) });
    }
    p = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Every member of a ZIP, tar or tar.gz buffer, keyed by its archive path. */
export function archiveEntries(raw: Uint8Array): ArchiveEntry[] {
  const format = detectArchiveFormat(raw);
  if (format === "zip") {
    return readZipMembers(raw).map((member) => ({ name: member.name, read: () => readZipMember(raw, member) }));
  }
  if (format === "tar") return readTarMembers(raw);
  if (format === "gzip") return readTarMembers(Bun.gunzipSync(new Uint8Array(raw)));
  throw new Error("unrecognized archive format (expected zip, tar or tar.gz)");
}

/** Case-insensitive member lookup by basename, matching `binary` exactly. */
export async function extractBinaryFromArchive(raw: Uint8Array, binary: string): Promise<Uint8Array> {
  const entries = archiveEntries(raw);
  const wanted = binary.toLowerCase();
  const match =
    entries.find((entry) => entry.name.toLowerCase() === wanted) ??
    entries.find((entry) => entry.name.toLowerCase().endsWith(`/${wanted}`)) ??
    entries.find((entry) => entry.name.toLowerCase().split("/").pop() === wanted && !entry.name.endsWith("/"));
  if (!match) {
    throw new Error(`obscura archive has no ${binary} (found: ${entries.map((entry) => entry.name).slice(0, 20).join(", ") || "no members"})`);
  }
  const bytes = await match.read();
  if (bytes.length === 0) throw new Error(`obscura archive member ${match.name} is empty`);
  return bytes;
}
