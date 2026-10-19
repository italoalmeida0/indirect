// scripts/verify-daemon-binary.ts — object-format checks on a built daemon
// binary, called by scripts/build-indirect-all.ts right after each build.
//
// Three properties are worth asserting from the bytes, none of which a
// "file exists" check would catch:
//
//  1. The artifact is the right format AND the right machine for the target
//     (an ELF on a windows slot, or an arm64 Mach-O for amd64, would only
//     fail much later, on the user's machine).
//  2. The linux artifacts are glibc-free: no PT_INTERP program header and no
//     DT_NEEDED entries (the Alpine gate in CI proves the same property by
//     execution).
//  3. On darwin the cross link uses -Wl,-undefined,dynamic_lookup, so an
//     unresolved engine symbol would only explode at runtime on the user's
//     Mac. The Mach-O symbol table is inspected instead: the QuickJS entry
//     points must be DEFINED and no engine symbol may stay undefined while
//     the CoreFoundation/Security frameworks must be real load commands.
import { readFileSync } from "node:fs";

export class BinaryError extends Error {}

function bad(msg: string): never {
  throw new BinaryError(msg);
}

const ENGINE_PREFIXES = ["_JS_", "_qjs_", "_js_", "_lre_"];
const REQUIRED_SYMBOLS = ["_JS_NewRuntime", "_JS_NewContextRaw", "_JS_Eval", "_qjs_eval_module"];

export interface BinaryReport {
  format: "elf" | "macho" | "pe";
  machine: string;
  staticallyLinked?: boolean;
  engineSymbols: number;
  dylibs?: string[];
}

// verifyDaemonBinary inspects one built artifact. It throws BinaryError on
// any violation.
export function verifyDaemonBinary(path: string, goos: string, goarch: string): BinaryReport {
  const buf = readFileSync(path);
  if (goos === "linux") return verifyELF(path, buf, goarch);
  if (goos === "darwin") return verifyMachO(path, buf, goarch);
  return verifyPE(path, buf, goarch);
}

function verifyELF(path: string, buf: Buffer, goarch: string): BinaryReport {
  if (buf.length < 64 || buf[0] !== 0x7f || buf.toString("ascii", 1, 4) !== "ELF" || buf[4] !== 2 || buf[5] !== 1) {
    bad(`${path}: not a 64-bit little-endian ELF binary`);
  }
  const machine = buf.readUInt16LE(0x12);
  const wantMachine = elfMachine(goarch);
  if (machine !== wantMachine) {
    bad(`${path}: ELF machine 0x${machine.toString(16)}, want 0x${wantMachine.toString(16)}`);
  }
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  let hasInterp = false;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + 4 > buf.length) break;
    if (buf.readUInt32LE(off) === 3) hasInterp = true; // PT_INTERP
  }
  let dynamicSections = 0;
  let dynamicEntries = 0;
  for (let i = 0; i < shnum; i++) {
    const off = shoff + i * shentsize;
    if (off + 8 > buf.length) break;
    if (buf.readUInt32LE(off + 4) === 6) {
      // SHT_DYNAMIC
      dynamicSections++;
      const size = Number(buf.readBigUInt64LE(off + 0x20));
      dynamicEntries += size / 16;
    }
  }
  const staticallyLinked = !hasInterp && dynamicSections === 0;
  if (!staticallyLinked) {
    bad(`${path}: not statically linked (PT_INTERP=${hasInterp}, dynamic entries=${dynamicEntries}) — linux artifacts must stay glibc-free`);
  }
  return { format: "elf", machine: goarch, staticallyLinked, engineSymbols: 0 };
}

function elfMachine(goarch: string): number {
  return goarch === "amd64" ? 0x3e : 0xb7; // EM_X86_64 | EM_AARCH64
}

function verifyMachO(path: string, buf: Buffer, goarch: string): BinaryReport {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0xfeedfacf) bad(`${path}: not a 64-bit Mach-O binary`);
  const cputype = buf.readUInt32LE(4);
  const wantCpu = goarch === "amd64" ? 0x01000007 : 0x0100000c;
  if (cputype !== wantCpu) {
    bad(`${path}: Mach-O cputype 0x${cputype.toString(16)}, want 0x${wantCpu.toString(16)}`);
  }
  const ncmds = buf.readUInt32LE(16);
  let off = 32;
  let symtab: { symoff: number; nsyms: number; stroff: number; strsize: number } | null = null;
  const dylibs: string[] = [];
  for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmd === 0x2) {
      symtab = {
        symoff: buf.readUInt32LE(off + 8),
        nsyms: buf.readUInt32LE(off + 12),
        stroff: buf.readUInt32LE(off + 16),
        strsize: buf.readUInt32LE(off + 20),
      };
    } else if (cmd === 0xc || cmd === 0x8000001c) {
      // LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB
      const nameOff = buf.readUInt32LE(off + 8);
      const end = buf.indexOf(0, off + nameOff);
      if (end > 0) dylibs.push(buf.toString("utf8", off + nameOff, end));
    }
    off += cmdsize;
  }
  for (const framework of ["CoreFoundation", "Security"]) {
    if (!dylibs.some((d) => d.includes(`${framework}.framework`))) {
      bad(`${path}: missing ${framework} load command (crypto/x509 needs it on darwin)`);
    }
  }
  if (!symtab) bad(`${path}: Mach-O has no symbol table`);
  const strtab = buf.subarray(symtab.stroff, symtab.stroff + symtab.strsize);
  const defined = new Set<string>();
  const undefinedEngine: string[] = [];
  for (let i = 0; i < symtab.nsyms; i++) {
    const e = symtab.symoff + i * 16;
    if (e + 16 > buf.length) break;
    const nStrx = buf.readUInt32LE(e);
    const nType = buf[e + 4];
    if (nStrx === 0 || nStrx >= strtab.length) continue;
    const end = strtab.indexOf(0, nStrx);
    if (end < 0) continue;
    const name = strtab.toString("utf8", nStrx, end);
    if ((nType & 0x0e) === 0) {
      if (ENGINE_PREFIXES.some((p) => name.startsWith(p))) undefinedEngine.push(name);
      continue;
    }
    defined.add(name);
  }
  if (undefinedEngine.length > 0) {
    bad(`${path}: undefined engine symbols (${undefinedEngine.slice(0, 4).join(", ")}) — libquickjs.a was not linked`);
  }
  for (const want of REQUIRED_SYMBOLS) {
    if (!defined.has(want)) bad(`${path}: missing defined QuickJS symbol ${want} — was libquickjs.a linked in?`);
  }
  const engineSymbols = [...defined].filter((s) => ENGINE_PREFIXES.some((p) => s.startsWith(p))).length;
  return { format: "macho", machine: goarch, engineSymbols, dylibs };
}

function verifyPE(path: string, buf: Buffer, goarch: string): BinaryReport {
  if (buf.length < 0x40 || buf.toString("ascii", 0, 2) !== "MZ") bad(`${path}: not a PE binary`);
  const lfanew = buf.readUInt32LE(0x3c);
  if (buf.toString("ascii", lfanew, lfanew + 4) !== "PE\0\0") bad(`${path}: missing PE signature`);
  const machine = buf.readUInt16LE(lfanew + 4);
  const wantMachine = goarch === "amd64" ? 0x8664 : 0xaa64;
  if (machine !== wantMachine) {
    bad(`${path}: PE machine 0x${machine.toString(16)}, want 0x${wantMachine.toString(16)}`);
  }
  return { format: "pe", machine: goarch, engineSymbols: 0 };
}
