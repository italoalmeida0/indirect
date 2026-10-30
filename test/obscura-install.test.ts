import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { archiveEntries, detectArchiveFormat, extractBinaryFromArchive } from "../server/archive";
import { OBSCURA_ASSETS, obscuraPlatformKey } from "../server/routes/obscura";

/**
 * Release archives must unpack in-process on every platform.
 *
 * Regression: the installer used Bun.Archive, which rejects a valid ZIP with
 * "Unrecognized archive format" on Bun 1.3.x/1.4.x. The Windows release is
 * published ONLY as a ZIP, so the automated install always failed on Windows.
 * These tests build real archives (a stored ZIP, a deflated ZIP and a tar.gz)
 * so the format handling is exercised natively instead of depending on a
 * platform-specific external tool.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a ZIP with the given members; `deflate` selects method 8. */
function buildZip(members: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const nameBytes = new TextEncoder().encode(member.name);
    const payload = member.deflate ? new Uint8Array(Bun.deflateSync(new Uint8Array(member.data))) : member.data;
    const method = member.deflate ? 8 : 0;
    const crc = crc32(member.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, member.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, payload);

    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, member.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length + payload.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = chunks.reduce((sum, part) => sum + part.length, 0) + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...chunks, ...central, eocd]) { out.set(part, at); at += part.length; }
  return out;
}

/** Build a POSIX tar (with the ustar magic the detector expects). */
function buildTar(members: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(member.name).subarray(0, 100), 0);
    const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";
    header.set(new TextEncoder().encode(octal(member.data.length, 12)), 124);
    header.set(new TextEncoder().encode(octal(0o644, 8)), 100);
    header[156] = "0".charCodeAt(0);
    header.set(new TextEncoder().encode("ustar\0"), 257);
    const padded = new Uint8Array(Math.ceil(member.data.length / 512) * 512);
    padded.set(member.data);
    blocks.push(header, padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of blocks) { out.set(part, at); at += part.length; }
  return out;
}

const encoder = new TextEncoder();
const binary = (label: string, size = 4096) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + label.length) & 0xff;
  return bytes;
};

describe("release archive extraction", () => {
  test("a stored ZIP is detected and unpacked", async () => {
    const zip = buildZip([
      { name: "obscura.exe", data: binary("obscura") },
      { name: "obscura-worker.exe", data: binary("worker") },
    ]);
    expect(detectArchiveFormat(zip)).toBe("zip");
    expect(archiveEntries(zip).map((entry) => entry.name)).toEqual(["obscura.exe", "obscura-worker.exe"]);
    const extracted = await extractBinaryFromArchive(zip, "obscura.exe");
    expect(extracted).toEqual(binary("obscura"));
  });

  test("a deflated ZIP member is inflated byte-for-byte", async () => {
    const payload = encoder.encode("model-authored widget source ".repeat(500));
    const zip = buildZip([{ name: "nested/dir/obscura", data: payload, deflate: true }]);
    const extracted = await extractBinaryFromArchive(zip, "obscura");
    expect(new TextDecoder().decode(extracted)).toBe(new TextDecoder().decode(payload));
  });

  test("a tar.gz release is detected and unpacked", async () => {
    const tar = buildTar([
      { name: "obscura", data: binary("linux") },
      { name: "obscura-worker", data: binary("linux-worker") },
    ]);
    const gz = new Uint8Array(Bun.gzipSync(new Uint8Array(tar)));
    expect(detectArchiveFormat(gz)).toBe("gzip");
    expect(await extractBinaryFromArchive(gz, "obscura")).toEqual(binary("linux"));
  });

  test("a bare tar is accepted too", async () => {
    const tar = buildTar([{ name: "obscura", data: binary("bare") }]);
    expect(detectArchiveFormat(tar)).toBe("tar");
    expect(await extractBinaryFromArchive(tar, "obscura")).toEqual(binary("bare"));
  });

  test("a corrupt archive fails with a clear message, never a crash", async () => {
    expect(() => archiveEntries(new Uint8Array([1, 2, 3, 4]))).toThrow(/unrecognized archive format/i);
    const truncated = buildZip([{ name: "obscura.exe", data: binary("x") }]).subarray(0, 40);
    expect(() => archiveEntries(truncated)).toThrow();
    await expect(extractBinaryFromArchive(buildZip([{ name: "other.exe", data: binary("y") }]), "obscura.exe")).rejects.toThrow(/has no obscura\.exe/);
  });

  test("a ZIP that claims a member larger than the buffer is refused", async () => {
    const zip = buildZip([{ name: "obscura.exe", data: binary("short") }]);
    // Corrupt the compressed size in the local header so the member runs past
    // the archive: the reader must bounds-check instead of reading garbage.
    // The central directory is authoritative, so inflate it there.
    const view = new DataView(zip.buffer);
    const eocdOffset = zip.length - 22;
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    view.setUint32(centralOffset + 20, 0x7fffffff, true);
    const entries = archiveEntries(zip);
    await expect(entries[0]!.read()).rejects.toThrow(/runs past the archive/);
  });

  test("a local header that disagrees with the central directory is refused", async () => {
    const zip = buildZip([{ name: "obscura.exe", data: binary("mismatch") }]);
    // Stored in the directory, "deflated" in the local header.
    new DataView(zip.buffer).setUint16(8, 8, true);
    const entries = archiveEntries(zip);
    await expect(entries[0]!.read()).rejects.toThrow(/disagrees with the central directory/);
  });
});

describe("pinned release assets", () => {
  test("every supported platform pins a versioned archive with a 64-hex digest", () => {
    const platforms = Object.keys(OBSCURA_ASSETS);
    expect(platforms).toEqual(expect.arrayContaining(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]));
    for (const [platform, asset] of Object.entries(OBSCURA_ASSETS)) {
      expect(asset.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
      // Assets live under a versioned release path; the file name itself
      // carries no version, so pinning is enforced by the digest table.
      expect(asset.file, platform).toMatch(/^obscura-(x86_64|aarch64)-(linux|macos|windows)-stealth\.(zip|tar\.gz)$/);
      expect(asset.file.endsWith(".zip") || asset.file.endsWith(".tar.gz"), platform).toBe(true);
      expect(asset.binary, platform).toBe(platform.startsWith("win32") ? "obscura.exe" : "obscura");
    }
  });

  test("the platform key maps Windows to the ZIP asset", () => {
    expect(obscuraPlatformKey("win32", "x64")).toBe("win32-x64");
    expect(OBSCURA_ASSETS[obscuraPlatformKey("win32", "x64")]?.file).toBe("obscura-x86_64-windows-stealth.zip");
    expect(OBSCURA_ASSETS[obscuraPlatformKey("linux", "arm64")]?.file).toBe("obscura-aarch64-linux-stealth.tar.gz");
    expect(OBSCURA_ASSETS[obscuraPlatformKey("darwin", "x64")]?.file).toBe("obscura-x86_64-macos-stealth.tar.gz");
  });

  test("the real downloaded archive extracts the shipped executables", async () => {
    // Uses the real release when the operator cached it (offline/CI friendly);
    // the synthetic archives above cover the format logic otherwise.
    const cached = path.resolve(import.meta.dir, "..", "tmp", "obscura-cache", OBSCURA_ASSETS[obscuraPlatformKey()]?.file ?? "");
    if (!existsSync(cached)) {
      console.log("[skip] no cached release archive at tmp/obscura-cache");
      return;
    }
    const raw = new Uint8Array(await Bun.file(cached).arrayBuffer());
    const entries = archiveEntries(raw);
    expect(entries.length).toBeGreaterThan(0);
    const bytes = await extractBinaryFromArchive(raw, OBSCURA_ASSETS[obscuraPlatformKey()]!.binary);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    // PE (MZ) on Windows, ELF on Linux, Mach-O on macOS.
    const magic = new TextDecoder("latin1").decode(bytes.subarray(0, 2));
    if (process.platform === "win32") expect(magic).toBe("MZ");
    else if (process.platform === "linux") expect(magic).toBe("\x7fE");
  }, 120_000);
});
