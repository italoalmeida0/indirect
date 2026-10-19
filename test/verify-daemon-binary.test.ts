// Synthetic-artifact tests for scripts/verify-daemon-binary.ts.
//
// The daemon links a prebuilt QuickJS archive late (packages/qjs/lib), so a
// build can "succeed" while shipping a binary with no engine inside, a
// dynamically linked linux ELF, or a Mach-O whose engine symbols stayed
// undefined (the darwin cross link defers symbols on purpose). The validator
// is the only thing standing between those outcomes and a release, so its
// parser is exercised here on hand-built headers with no compiler involved.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinaryError, verifyDaemonBinary } from "../scripts/verify-daemon-binary";

const dir = mkdtempSync(join(tmpdir(), "verify-bin-"));

function write(name: string, buf: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

/** Minimal 64-bit little-endian ELF: ELF header + one PT_LOAD (+ optional PT_INTERP/SHT_DYNAMIC). */
function elf(machine: number, opts: { interp?: boolean; dynamic?: boolean } = {}): Buffer {
  const phnum = opts.interp ? 2 : 1;
  const shnum = opts.dynamic ? 1 : 0;
  const phoff = 64;
  const shoff = phoff + phnum * 56;
  const end = shoff + shnum * 64 + 16;
  const buf = Buffer.alloc(end);
  buf.writeUInt8(0x7f, 0);
  buf.write("ELF", 1, "ascii");
  buf.writeUInt8(2, 4); // 64-bit
  buf.writeUInt8(1, 5); // little-endian
  buf.writeUInt16LE(2, 0x10); // ET_EXEC
  buf.writeUInt16LE(machine, 0x12);
  buf.writeBigUInt64LE(BigInt(phoff), 0x20);
  buf.writeBigUInt64LE(BigInt(shoff), 0x28);
  buf.writeUInt16LE(64, 0x34);
  buf.writeUInt16LE(56, 0x36);
  buf.writeUInt16LE(phnum, 0x38);
  buf.writeUInt16LE(64, 0x3a);
  buf.writeUInt16LE(shnum, 0x3c);
  buf.writeUInt32LE(1, phoff); // PT_LOAD
  if (opts.interp) buf.writeUInt32LE(3, phoff + 56); // PT_INTERP
  if (opts.dynamic) buf.writeUInt32LE(6, shoff + 4); // SHT_DYNAMIC
  return buf;
}

/** Minimal 64-bit Mach-O: header + LC_LOAD_DYLIBs + LC_SYMTAB with the engine symbols. */
function macho(cputype: number, opts: { engine?: boolean; undefinedEngine?: boolean } = {}): Buffer {
  const dylibs = [
    "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
    "/System/Library/Frameworks/Security.framework/Versions/A/Security",
  ];
  const symbols = opts.engine === false ? [] : ["_JS_NewRuntime", "_JS_NewContextRaw", "_JS_Eval", "_qjs_eval_module"];
  const strtab = Buffer.from("__probe\0" + [...symbols, "_main", "_helper"].join("\0") + "\0", "utf8");
  const symbolNames = ["__probe", ...symbols, "_main", "_helper"];
  const nl = (s: string) => Buffer.byteLength(s, "utf8") + 1;
  const ncmds = 1 + dylibs.length + 1;
  const headerSize = 32;
  let off: number; // set below, once the load commands are built
  interface Cmd {
    buf: Buffer;
    size: number;
  }
  const cmds: Cmd[] = [];
  for (const name of dylibs) {
    const size = 24 + nl(name);
    const b = Buffer.alloc(size);
    b.writeUInt32LE(0xc, 0); // LC_LOAD_DYLIB
    b.writeUInt32LE(size, 4);
    b.writeUInt32LE(24, 8);
    b.write(name, 24, "utf8");
    cmds.push({ buf: b, size });
  }
  // LC_SYMTAB layout is resolved after we know where the tables live.
  const symtabSize = 24;
  const nsyms = symbolNames.length;
  const symoff = headerSize + cmds.reduce((n, c) => n + c.size, 0) + symtabSize;
  const stroff = symoff + nsyms * 16;
  const symtab = Buffer.alloc(symtabSize);
  symtab.writeUInt32LE(0x2, 0); // LC_SYMTAB
  symtab.writeUInt32LE(symtabSize, 4);
  symtab.writeUInt32LE(symoff, 8);
  symtab.writeUInt32LE(nsyms, 12);
  symtab.writeUInt32LE(stroff, 16);
  symtab.writeUInt32LE(strtab.length, 20);
  cmds.push({ buf: symtab, size: symtabSize });

  const syms = Buffer.alloc(nsyms * 16);
  let nameOffset = 0;
  symbolNames.forEach((name, i) => {
    // The engine's symbols are the ones that must come out DEFINED, except in
    // the negative case where they are left undefined on purpose.
    const undef = opts.undefinedEngine && symbols.includes(name);
    syms.writeUInt32LE(nameOffset, i * 16);
    syms.writeUInt8(undef ? 0x01 : 0x0f, i * 16 + 4); // N_UNDF vs N_SECT
    syms.writeUInt8(1, i * 16 + 5);
    nameOffset += nl(name);
  });

  const total = stroff + strtab.length;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeUInt32LE(cputype, 4);
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(ncmds, 16);
  buf.writeUInt32LE(total - headerSize, 20);
  off = headerSize;
  for (const c of cmds) {
    c.buf.copy(buf, off);
    off += c.size;
  }
  syms.copy(buf, symoff);
  strtab.copy(buf, stroff);
  return buf;
}

/** Minimal PE: MZ + PE signature + COFF header for the given machine. */
function pe(machine: number): Buffer {
  const buf = Buffer.alloc(0x100);
  buf.write("MZ", 0, "ascii");
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "ascii");
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

describe("verify-daemon-binary", () => {
  test("a static ELF of the right machine passes", () => {
    const p = write("ok-amd64", elf(0x3e));
    expect(verifyDaemonBinary(p, "linux", "amd64").staticallyLinked).toBe(true);
    expect(verifyDaemonBinary(write("ok-arm64", elf(0xb7)), "linux", "arm64").machine).toBe("arm64");
  });

  test("an ELF for another machine is refused", () => {
    expect(() => verifyDaemonBinary(write("mismatch", elf(0x3e)), "linux", "arm64")).toThrow(BinaryError);
  });

  test("a dynamically linked ELF is refused (linux must stay glibc-free)", () => {
    expect(() => verifyDaemonBinary(write("dyn", elf(0x3e, { dynamic: true })), "linux", "amd64")).toThrow(
      /glibc-free/,
    );
    expect(() => verifyDaemonBinary(write("interp", elf(0x3e, { interp: true })), "linux", "amd64")).toThrow(
      /glibc-free/,
    );
  });

  test("a Mach-O with the engine defined and frameworks linked passes", () => {
    const rep = verifyDaemonBinary(write("macho-ok", macho(0x0100000c)), "darwin", "arm64");
    expect(rep.format).toBe("macho");
    expect(rep.engineSymbols).toBeGreaterThanOrEqual(4);
    expect(rep.dylibs?.length).toBe(2);
  });

  test("a Mach-O for another CPU is refused", () => {
    expect(() => verifyDaemonBinary(write("macho-arm", macho(0x0100000c)), "darwin", "amd64")).toThrow(/cputype/);
  });

  test("a Mach-O without the engine defined is refused (deferred symbols hide broken links)", () => {
    expect(() => verifyDaemonBinary(write("macho-noengine", macho(0x0100000c, { undefinedEngine: true })), "darwin", "arm64")).toThrow(
      /undefined engine symbols/,
    );
    expect(() => verifyDaemonBinary(write("macho-empty", macho(0x0100000c, { engine: false })), "darwin", "arm64")).toThrow(
      /missing defined QuickJS symbol/,
    );
  });

  test("PE machine must match the target", () => {
    expect(verifyDaemonBinary(write("pe-amd64", pe(0x8664)), "windows", "amd64").machine).toBe("amd64");
    expect(() => verifyDaemonBinary(write("pe-arm", pe(0xaa64)), "windows", "amd64")).toThrow(/PE machine/);
  });

  test("a non-binary file is refused instead of crashing", () => {
    expect(() => verifyDaemonBinary(write("garbage", Buffer.from("not an executable at all")), "linux", "amd64")).toThrow(
      BinaryError,
    );
  });
});
