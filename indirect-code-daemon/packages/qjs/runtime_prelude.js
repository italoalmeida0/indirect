// runtime_prelude.js — embedded Node.js / WinterCG Web / Shell ($) runtime
// evaluated inside QjsRuntime before user scripts execute.
(function () {
  "use strict";

  const rawHostCall = globalThis.__qjs_host_call;
  const writeFD = globalThis.__qjs_write_fd;
  const hostExit = globalThis.__qjs_exit;
  const evalCJS = globalThis.__qjs_eval_cjs;
  const evalScript = globalThis.__qjs_eval_script;
  const evalInContext = globalThis.__qjs_eval_in_context;
  const rawRequireESM = globalThis.__qjs_require_esm;
  const rawSetPromiseHook = globalThis.__qjs_set_promise_hook;
  const rawIsProxy = globalThis.__qjs_is_proxy;
  const vmPinSym = globalThis.__qjs_vm_pin_sym;

  delete globalThis.__qjs_host_call;
  delete globalThis.__qjs_write_fd;
  delete globalThis.__qjs_exit;
  delete globalThis.__qjs_eval_cjs;
  delete globalThis.__qjs_eval_script;
  delete globalThis.__qjs_eval_in_context;
  delete globalThis.__qjs_require_esm;
  delete globalThis.__qjs_set_promise_hook;
  delete globalThis.__qjs_is_proxy;
  delete globalThis.__qjs_vm_pin_sym;

  if (vmPinSym) {
    const origGetOwnPropertySymbols = Object.getOwnPropertySymbols;
    Object.getOwnPropertySymbols = function getOwnPropertySymbols(obj) {
      return origGetOwnPropertySymbols(obj).filter((s) => s !== vmPinSym);
    };
    if (typeof Reflect !== "undefined" && typeof Reflect.ownKeys === "function") {
      const origOwnKeys = Reflect.ownKeys;
      Reflect.ownKeys = function ownKeys(target) {
        return origOwnKeys(target).filter((k) => k !== vmPinSym);
      };
    }
  }

  // Ensure Error.prototype.stack includes V8/Node.js-style "ErrorName: message\n" header
  (function patchErrorStack() {
    const desc = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
    if (desc && typeof desc.get === "function") {
      const origGet = desc.get;
      const origSet = desc.set;
      Object.defineProperty(Error.prototype, "stack", {
        configurable: true,
        enumerable: false,
        get() {
          const raw = origGet.call(this);
          if (typeof raw !== "string") return raw;
          const name = this && this.name !== undefined ? String(this.name) : "Error";
          const msg = this && this.message !== undefined && this.message !== "" ? String(this.message) : "";
          const header = msg ? `${name}: ${msg}` : name;
          if (raw.startsWith(header)) return raw;
          return raw ? `${header}\n${raw}` : header;
        },
        set(v) {
          if (typeof origSet === "function") {
            origSet.call(this, v);
          } else {
            Object.defineProperty(this, "stack", {
              value: v,
              writable: true,
              configurable: true,
              enumerable: false,
            });
          }
        },
      });
    }
    if (typeof Error.captureStackTrace !== "function") {
      Error.captureStackTrace = function captureStackTrace(targetObject, constructorOpt) {
        if ((typeof targetObject !== "object" || targetObject === null) && typeof targetObject !== "function") {
          const err = new TypeError("The \"targetObject\" argument must be an object");
          err.code = "ERR_INVALID_ARG_TYPE";
          throw err;
        }
        const holder = new Error();
        const raw = String(holder.stack || "");
        const lines = raw.split("\n");
        let startIdx = 1;
        while (startIdx < lines.length && lines[startIdx].includes("captureStackTrace")) {
          startIdx++;
        }
        if (typeof constructorOpt === "function" && constructorOpt.name) {
          const fnName = constructorOpt.name;
          for (let i = startIdx; i < lines.length; i++) {
            if (lines[i].includes(`at ${fnName} `) || lines[i].includes(`at new ${fnName} `) || lines[i].endsWith(`at ${fnName}`)) {
              startIdx = i + 1;
              break;
            }
          }
        }
        const frames = lines.slice(startIdx).join("\n");
        Object.defineProperty(targetObject, "stack", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: (function () {
            const name = targetObject.name !== undefined ? String(targetObject.name) : "Error";
            const msg = targetObject.message !== undefined && targetObject.message !== "" ? String(targetObject.message) : "";
            const header = msg ? `${name}: ${msg}` : name;
            return frames ? `${header}\n${frames}` : header;
          })(),
        });
      };
    }
  })();

  const POSIX_ERRNO_MAP = {
    EPERM: -1,
    ENOENT: -2,
    ESRCH: -3,
    EINTR: -4,
    EIO: -5,
    ENXIO: -6,
    E2BIG: -7,
    ENOEXEC: -8,
    EBADF: -9,
    ECHILD: -10,
    EAGAIN: -11,
    ENOMEM: -12,
    EACCES: -13,
    EFAULT: -14,
    EBUSY: -16,
    EEXIST: -17,
    EXDEV: -18,
    ENODEV: -19,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    ENFILE: -23,
    EMFILE: -24,
    ENOTTY: -25,
    EFBIG: -27,
    ENOSPC: -28,
    ESPIPE: -29,
    EROFS: -30,
    EMLINK: -31,
    EPIPE: -32,
    EDOM: -33,
    ERANGE: -34,
    EDEADLK: -35,
    ENAMETOOLONG: -36,
    ENOLCK: -37,
    ENOSYS: -38,
    ENOTEMPTY: -39,
    ELOOP: -40,
    EADDRINUSE: -98,
    EADDRNOTAVAIL: -99,
    ECONNRESET: -104,
    ENOBUFS: -105,
    ETIMEDOUT: -110,
    ECONNREFUSED: -111,
  };

  const WIN_ERRNO_MAP = {
    ENOENT: -4058,
    EPERM: -4048,
    EACCES: -4092,
    EEXIST: -4075,
    EISDIR: -4068,
    ENOTDIR: -4052,
    ENOTEMPTY: -4051,
    EBUSY: -4082,
    EINVAL: -4071,
    EBADF: -4083,
    EADDRINUSE: -4091,
    ECONNREFUSED: -4078,
    ECONNRESET: -4077,
    ETIMEDOUT: -4039,
  };
  let isWinHost = false;

  function enrichHostError(err) {
    if (err && typeof err === "object" && typeof err.code === "string") {
      if (err.errno === undefined) {
        if (isWinHost && WIN_ERRNO_MAP[err.code] !== undefined) {
          err.errno = WIN_ERRNO_MAP[err.code];
        } else if (POSIX_ERRNO_MAP[err.code] !== undefined) {
          err.errno = POSIX_ERRNO_MAP[err.code];
        }
      }
      if (typeof err.message === "string") {
        const m = err.message.match(/,\s*([a-z0-9_]+)\s+'([^']*)'/i);
        if (m) {
          if (err.syscall === undefined) err.syscall = m[1];
          if (err.path === undefined) err.path = m[2];
        }
      }
    }
    return err;
  }

  function hostCall(op, args, bin) {
    try {
      return bin !== undefined ? rawHostCall(op, args, bin) : rawHostCall(op, args);
    } catch (err) {
      throw enrichHostError(err);
    }
  }

  const init = JSON.parse(hostCall("runtime.init", ""));
  isWinHost = init.platform === "win32";
  const builtins = Object.create(null);
  globalThis.__qjs_builtins = builtins;
  globalThis.global = globalThis;

  function makeNodeError(code, msg, Ctor = Error) {
    const err = new Ctor(msg);
    err.code = code;
    return err;
  }

  // =========================================================================
  // 1. UTF-8 / Base64 / Hex / TextEncoder / TextDecoder
  // =========================================================================

  function utf8Encode(str) {
    str = String(str);
    const len = str.length;
    const out = new Uint8Array(len * 3);
    let p = 0;
    for (let i = 0; i < len; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        out[p++] = c;
      } else if (c < 0x800) {
        out[p++] = 0xc0 | (c >> 6);
        out[p++] = 0x80 | (c & 0x3f);
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
          out[p++] = 0xf0 | (c >> 18);
          out[p++] = 0x80 | ((c >> 12) & 0x3f);
          out[p++] = 0x80 | ((c >> 6) & 0x3f);
          out[p++] = 0x80 | (c & 0x3f);
          i++;
        } else {
          out[p++] = 0xef;
          out[p++] = 0xbf;
          out[p++] = 0xbd;
        }
      } else if (c >= 0xd800 && c <= 0xdfff) {
        out[p++] = 0xef;
        out[p++] = 0xbf;
        out[p++] = 0xbd;
      } else {
        out[p++] = 0xe0 | (c >> 12);
        out[p++] = 0x80 | ((c >> 6) & 0x3f);
        out[p++] = 0x80 | (c & 0x3f);
      }
    }
    return p === out.length ? out : out.slice(0, p);
  }

  function utf8Decode(bytes, start = 0, end = bytes.length) {
    return utf8DecodeEx(bytes, start, end, false, false).text;
  }

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_LOOKUP = new Uint8Array(256);
  B64_LOOKUP.fill(255);
  for (let i = 0; i < B64_CHARS.length; i++) {
    B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
  }
  B64_LOOKUP["-".charCodeAt(0)] = 62;
  B64_LOOKUP["_".charCodeAt(0)] = 63;

  function base64Encode(bytes, start = 0, end = bytes.length, urlSafe = false) {
    const len = end - start;
    if (len <= 0) return "";
    const parts = [];
    let chunk = "";
    for (let i = 0; i < len; i += 3) {
      const a = bytes[start + i];
      const b = i + 1 < len ? bytes[start + i + 1] : 0;
      const c = i + 2 < len ? bytes[start + i + 2] : 0;
      const triplet = (a << 16) | (b << 8) | c;
      chunk +=
        B64_CHARS[(triplet >> 18) & 0x3f] +
        B64_CHARS[(triplet >> 12) & 0x3f] +
        (i + 1 < len ? B64_CHARS[(triplet >> 6) & 0x3f] : "=") +
        (i + 2 < len ? B64_CHARS[triplet & 0x3f] : "=");
      if (chunk.length >= 4096) {
        parts.push(chunk);
        chunk = "";
      }
    }
    if (chunk.length > 0) parts.push(chunk);
    let out = parts.length === 1 ? parts[0] : parts.join("");
    if (urlSafe) {
      out = out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return out;
  }

  function base64Decode(str) {
    str = String(str);
    const slen = str.length;
    const out = new Uint8Array(((slen * 3) >>> 2) + 4);
    let p = 0;
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < slen; i++) {
      const ch = str.charCodeAt(i);
      if (ch === 61) break; // '='
      const val = ch < 256 ? B64_LOOKUP[ch] : 255;
      if (val === 255) continue;
      buffer = (buffer << 6) | val;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[p++] = (buffer >> bits) & 0xff;
      }
    }
    return out.slice(0, p);
  }

  function hexEncode(bytes, start = 0, end = bytes.length) {
    const parts = [];
    let chunk = "";
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      chunk += (b < 16 ? "0" : "") + b.toString(16);
      if (chunk.length >= 4096) {
        parts.push(chunk);
        chunk = "";
      }
    }
    if (chunk.length > 0) parts.push(chunk);
    return parts.length === 0 ? "" : parts.length === 1 ? parts[0] : parts.join("");
  }

  function hexNibble(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
    return -1;
  }

  function hexDecode(str) {
    str = String(str);
    const len = str.length >>> 1;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const hi = hexNibble(str.charCodeAt(i * 2));
      const lo = hexNibble(str.charCodeAt(i * 2 + 1));
      if (hi < 0 || lo < 0) return out.subarray(0, i);
      out[i] = (hi << 4) | lo;
    }
    return out;
  }

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input = "") {
      return utf8Encode(input);
    }
    encodeInto(source, destination) {
      const str = String(source);
      const destLen = destination.length;
      let read = 0;
      let written = 0;
      while (read < str.length) {
        let c = str.charCodeAt(read);
        let units = 1;
        if (c >= 0xd800 && c <= 0xdbff && read + 1 < str.length) {
          const low = str.charCodeAt(read + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
            units = 2;
          } else {
            c = 0xfffd;
          }
        } else if (c >= 0xd800 && c <= 0xdfff) {
          c = 0xfffd;
        }
        if (c < 0x80) {
          if (written + 1 > destLen) break;
          destination[written++] = c;
        } else if (c < 0x800) {
          if (written + 2 > destLen) break;
          destination[written++] = 0xc0 | (c >> 6);
          destination[written++] = 0x80 | (c & 0x3f);
        } else if (c < 0x10000) {
          if (written + 3 > destLen) break;
          destination[written++] = 0xe0 | (c >> 12);
          destination[written++] = 0x80 | ((c >> 6) & 0x3f);
          destination[written++] = 0x80 | (c & 0x3f);
        } else {
          if (written + 4 > destLen) break;
          destination[written++] = 0xf0 | (c >> 18);
          destination[written++] = 0x80 | ((c >> 12) & 0x3f);
          destination[written++] = 0x80 | ((c >> 6) & 0x3f);
          destination[written++] = 0x80 | (c & 0x3f);
        }
        read += units;
      }
      return { read, written };
    }
  }

  function utf8DecodeEx(bytes, start, end, fatal, stream) {
    const parts = [];
    let out = "";
    let i = start;
    const flushText = () => {
      if (out.length > 0) {
        parts.push(out);
        out = "";
      }
      return parts.length === 0 ? "" : parts.length === 1 ? parts[0] : parts.join("");
    };
    while (i < end) {
      if (out.length >= 4096) {
        parts.push(out);
        out = "";
      }
      const b0 = bytes[i];
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        i++;
      } else if ((b0 & 0xe0) === 0xc0) {
        if (i + 1 >= end) {
          if (stream) return { text: flushText(), rem: bytes.slice(i, end) };
          if (fatal) throw new TypeError("The encoded data was not valid for encoding utf-8");
          out += "\ufffd";
          i++;
          continue;
        }
        const b1 = bytes[i + 1];
        if ((b1 & 0xc0) !== 0x80 || b0 < 0xc2) {
          if (fatal) throw new TypeError("The encoded data was not valid for encoding utf-8");
          out += "\ufffd";
          i++;
          continue;
        }
        out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
        i += 2;
      } else if ((b0 & 0xf0) === 0xe0) {
        const validSecond = i + 1 < end && (bytes[i + 1] & 0xc0) === 0x80 && !(b0 === 0xe0 && bytes[i + 1] < 0xa0) && !(b0 === 0xed && bytes[i + 1] >= 0xa0);
        if (i + 2 >= end) {
          if (stream && (i + 1 >= end || validSecond)) return { text: flushText(), rem: bytes.slice(i, end) };
          if (fatal) {
            const err = new TypeError("The encoded data was not valid for encoding utf-8");
            err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
            throw err;
          }
          out += "\ufffd";
          i += validSecond ? 2 : 1;
          continue;
        }
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        if (!validSecond || (b2 & 0xc0) !== 0x80 || cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) {
          if (fatal) {
            const err = new TypeError("The encoded data was not valid for encoding utf-8");
            err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
            throw err;
          }
          out += "\ufffd";
          i += validSecond ? 2 : 1;
          continue;
        }
        out += String.fromCharCode(cp);
        i += 3;
      } else if ((b0 & 0xf8) === 0xf0 && b0 <= 0xf4) {
        let validCont = 0;
        if (i + 1 < end && (bytes[i + 1] & 0xc0) === 0x80 && !(b0 === 0xf0 && bytes[i + 1] < 0x90) && !(b0 === 0xf4 && bytes[i + 1] >= 0x90)) {
          validCont = 1;
          if (i + 2 < end && (bytes[i + 2] & 0xc0) === 0x80) validCont = 2;
        }
        if (i + 3 >= end) {
          if (stream && validCont === (end - 1 - i)) return { text: flushText(), rem: bytes.slice(i, end) };
          if (fatal) {
            const err = new TypeError("The encoded data was not valid for encoding utf-8");
            err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
            throw err;
          }
          out += "\ufffd";
          i += 1 + validCont;
          continue;
        }
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const b3 = bytes[i + 3];
        const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        if (validCont < 2 || (b3 & 0xc0) !== 0x80 || cp < 0x10000 || cp > 0x10ffff) {
          if (fatal) {
            const err = new TypeError("The encoded data was not valid for encoding utf-8");
            err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
            throw err;
          }
          out += "\ufffd";
          i += 1 + validCont;
          continue;
        }
        const u = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
        i += 4;
      } else {
        if (fatal) {
          const err = new TypeError("The encoded data was not valid for encoding utf-8");
          err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
          throw err;
        }
        out += "\ufffd";
        i++;
      }
    }
    return { text: flushText(), rem: null };
  }

  function resolveTextDecoderLabel(label) {
    const l = String(label).trim().toLowerCase();
    switch (l) {
      case "utf-8":
      case "utf8":
      case "unicode-1-1-utf-8":
        return "utf-8";
      case "utf-16le":
      case "utf-16":
      case "ucs-2":
      case "ucs2":
      case "iso-10646-ucs-2":
        return "utf-16le";
      case "utf-16be":
        return "utf-16be";
      case "latin1":
      case "iso-8859-1":
      case "iso8859-1":
      case "iso88591":
      case "windows-1252":
      case "cp1252":
      case "ascii":
      case "us-ascii":
        return "windows-1252";
      case "shift_jis":
      case "shift-jis":
      case "sjis":
      case "cssshiftjis":
      case "ms_kanji":
      case "windows-31j":
      case "x-sjis":
        return "shift_jis";
      default: {
        const err = new RangeError(`The "${label}" encoding is not supported`);
        err.code = "ERR_ENCODING_NOT_SUPPORTED";
        throw err;
      }
    }
  }

  class TextDecoder {
    constructor(label = "utf-8", options = {}) {
      this.encoding = resolveTextDecoderLabel(label);
      this.fatal = Boolean(options && options.fatal);
      this.ignoreBOM = Boolean(options && options.ignoreBOM);
      this._pending = null;
      this._bomSeen = false;
    }
    decode(input, options = {}) {
      const stream = Boolean(options && options.stream);
      let bytes;
      if (input === undefined) {
        bytes = new Uint8Array(0);
      } else if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
      } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else {
        const err = new TypeError("The \"input\" argument must be an instance of ArrayBuffer or ArrayBufferView");
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (this._pending && this._pending.length > 0) {
        const merged = new Uint8Array(this._pending.length + bytes.length);
        merged.set(this._pending, 0);
        merged.set(bytes, this._pending.length);
        bytes = merged;
        this._pending = null;
      }
      if (bytes.length === 0) {
        if (!stream) this._bomSeen = false;
        return "";
      }
      if (this.encoding === "shift_jis") {
        let s = "";
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          if (b < 0x80) {
            s += String.fromCharCode(b);
          } else if (b >= 0xa1 && b <= 0xdf) {
            s += String.fromCharCode(0xff61 + (b - 0xa1));
          } else if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
            if (i + 1 >= bytes.length) {
              if (stream) {
                this._pending = bytes.slice(i);
                return s;
              }
              if (this.fatal) {
                const err = new TypeError("The encoded data was not valid for encoding shift_jis");
                err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
                throw err;
              }
              s += "\ufffd";
              break;
            }
            const b2 = bytes[++i];
            if (b === 0x81 && b2 === 0x40) s += "\u3000";
            else if (b === 0x82 && b2 >= 0x9f && b2 <= 0xf1) s += String.fromCharCode(0x3041 + (b2 - 0x9f));
            else if (b === 0x83 && b2 >= 0x40 && b2 <= 0x96) s += String.fromCharCode(0x30a1 + (b2 > 0x7f ? b2 - 0x41 : b2 - 0x40));
            else s += "\ufffd";
          } else {
            if (this.fatal) {
              const err = new TypeError("The encoded data was not valid for encoding shift_jis");
              err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
              throw err;
            }
            s += "\ufffd";
          }
        }
        if (!stream) this._bomSeen = false;
        return s;
      }
      if (this.encoding === "windows-1252" || (this.encoding !== "utf-8" && this.encoding !== "utf-16le" && this.encoding !== "utf-16be")) {
        const WIN1252_MAP = [
          0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
          0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
          0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
          0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
        ];
        let s = "";
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? WIN1252_MAP[b - 0x80] : b);
        }
        if (!stream) this._bomSeen = false;
        return s;
      }
      if (this.encoding === "utf-16le" || this.encoding === "utf-16be") {
        const isLE = this.encoding === "utf-16le";
        const throwInvalid = () => {
          const err = new TypeError(`The encoded data was not valid for encoding ${this.encoding}`);
          err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
          throw err;
        };
        let start = 0;
        if (!this._bomSeen) {
          if (!this.ignoreBOM && bytes.length >= 2 && ((isLE && bytes[0] === 0xff && bytes[1] === 0xfe) || (!isLE && bytes[0] === 0xfe && bytes[1] === 0xff))) {
            start = 2;
            this._bomSeen = true;
          } else if (stream && bytes.length === 1) {
            this._pending = bytes.slice();
            return "";
          } else {
            this._bomSeen = true;
          }
        }
        let s = "";
        let i = start;
        for (; i + 1 < bytes.length; i += 2) {
          const code = isLE ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]);
          if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 3 < bytes.length) {
              const nextCode = isLE ? (bytes[i + 2] | (bytes[i + 3] << 8)) : ((bytes[i + 2] << 8) | bytes[i + 3]);
              if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
                s += String.fromCharCode(code, nextCode);
                i += 2;
                continue;
              }
              if (this.fatal) throwInvalid();
              s += "\ufffd";
              continue;
            }
            if (stream) {
              this._pending = bytes.slice(i);
              return s;
            }
            if (this.fatal) throwInvalid();
            s += "\ufffd";
            continue;
          }
          if (code >= 0xdc00 && code <= 0xdfff) {
            if (this.fatal) throwInvalid();
            s += "\ufffd";
            continue;
          }
          s += String.fromCharCode(code);
        }
        if (i < bytes.length) {
          if (stream) {
            this._pending = bytes.slice(i);
          } else {
            this._bomSeen = false;
            if (this.fatal) throwInvalid();
            s += "\ufffd";
          }
        } else if (!stream) {
          this._bomSeen = false;
        }
        return s;
      }
      let start = 0;
      if (!this._bomSeen) {
        if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          start = 3;
          this._bomSeen = true;
        } else if (stream && bytes.length < 3 && bytes[0] === 0xef && (bytes.length === 1 || bytes[1] === 0xbb)) {
          this._pending = bytes.slice();
          return "";
        } else {
          this._bomSeen = true;
        }
      }
      const res = utf8DecodeEx(bytes, start, bytes.length, this.fatal, stream);
      this._pending = res.rem;
      if (!stream) {
        this._bomSeen = false;
      }
      return res.text;
    }
  }

  class StringDecoder {
    constructor(encoding = "utf8") {
      const norm = normalizeEncoding(encoding);
      if (!norm) {
        throw makeNodeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`, TypeError);
      }
      this.encoding = norm;
      this._td = (norm === "utf8" || norm === "utf16le") ? new TextDecoder(norm === "utf8" ? "utf-8" : "utf-16le", { ignoreBOM: true }) : null;
      this._rem = null;
    }
    write(buf) {
      if (typeof buf === "string") return buf;
      const u8 = buf instanceof Uint8Array ? buf : Buffer.from(buf);
      if (u8.byteLength === 0) return "";
      if (this._td) {
        return this._td.decode(u8, { stream: true });
      }
      if (this.encoding === "base64" || this.encoding === "base64url") {
        let bytes = u8;
        if (this._rem && this._rem.length > 0) {
          const m = new Uint8Array(this._rem.length + u8.length);
          m.set(this._rem, 0);
          m.set(u8, this._rem.length);
          bytes = m;
          this._rem = null;
        }
        const remLen = bytes.length % 3;
        const mainLen = bytes.length - remLen;
        if (remLen > 0) {
          this._rem = Uint8Array.prototype.slice.call(bytes, mainLen);
        }
        if (mainLen === 0) return "";
        return base64Encode(bytes, 0, mainLen, this.encoding === "base64url");
      }
      return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString(this.encoding);
    }
    end(buf) {
      let out = "";
      if (buf !== undefined) {
        out += this.write(buf);
      }
      if (this._td) {
        out += this._td.decode(new Uint8Array(0), { stream: false });
      } else if (this._rem && this._rem.length > 0) {
        out += base64Encode(this._rem, 0, this._rem.length, this.encoding === "base64url");
        this._rem = null;
      }
      return out;
    }
  }
  builtins["string_decoder"] = { StringDecoder };

  const DOM_EXCEPTION_CODES = {
    IndexSizeError: 1,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InUseAttributeError: 10,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25,
  };

  class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(String(message));
      this.name = String(name);
      this.code = DOM_EXCEPTION_CODES[this.name] || 0;
    }
  }
  Object.assign(DOMException, {
    INDEX_SIZE_ERR: 1,
    DOMSTRING_SIZE_ERR: 2,
    HIERARCHY_REQUEST_ERR: 3,
    WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5,
    NO_DATA_ALLOWED_ERR: 6,
    NO_MODIFICATION_ALLOWED_ERR: 7,
    NOT_FOUND_ERR: 8,
    NOT_SUPPORTED_ERR: 9,
    INUSE_ATTRIBUTE_ERR: 10,
    INVALID_STATE_ERR: 11,
    SYNTAX_ERR: 12,
    INVALID_MODIFICATION_ERR: 13,
    NAMESPACE_ERR: 14,
    INVALID_ACCESS_ERR: 15,
    VALIDATION_ERR: 16,
    TYPE_MISMATCH_ERR: 17,
    SECURITY_ERR: 18,
    NETWORK_ERR: 19,
    ABORT_ERR: 20,
    URL_MISMATCH_ERR: 21,
    QUOTA_EXCEEDED_ERR: 22,
    TIMEOUT_ERR: 23,
    INVALID_NODE_TYPE_ERR: 24,
    DATA_CLONE_ERR: 25,
  });
  Object.assign(DOMException.prototype, {
    INDEX_SIZE_ERR: 1,
    DOMSTRING_SIZE_ERR: 2,
    HIERARCHY_REQUEST_ERR: 3,
    WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5,
    NO_DATA_ALLOWED_ERR: 6,
    NO_MODIFICATION_ALLOWED_ERR: 7,
    NOT_FOUND_ERR: 8,
    NOT_SUPPORTED_ERR: 9,
    INUSE_ATTRIBUTE_ERR: 10,
    INVALID_STATE_ERR: 11,
    SYNTAX_ERR: 12,
    INVALID_MODIFICATION_ERR: 13,
    NAMESPACE_ERR: 14,
    INVALID_ACCESS_ERR: 15,
    VALIDATION_ERR: 16,
    TYPE_MISMATCH_ERR: 17,
    SECURITY_ERR: 18,
    NETWORK_ERR: 19,
    ABORT_ERR: 20,
    URL_MISMATCH_ERR: 21,
    QUOTA_EXCEEDED_ERR: 22,
    TIMEOUT_ERR: 23,
    INVALID_NODE_TYPE_ERR: 24,
    DATA_CLONE_ERR: 25,
  });
  globalThis.DOMException = DOMException;

  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;

  if (typeof globalThis.atob !== "function") {
    globalThis.atob = function atob(data) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to execute 'atob': 1 argument required, but only 0 present.");
      }
      const str = String(data).replace(/[\t\n\f\r ]+/g, "");
      if (str.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(str) || /=[^=]/.test(str) || /===$/.test(str)) {
        throw new DOMException("Invalid character", "InvalidCharacterError");
      }
      const bytes = base64Decode(str);
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    };
  }
  if (typeof globalThis.btoa !== "function") {
    globalThis.btoa = function btoa(str) {
      str = String(str);
      const bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c > 0xff) {
          throw new DOMException("InvalidCharacterError", "InvalidCharacterError");
        }
        bytes[i] = c;
      }
      return base64Encode(bytes);
    };
  }

  // =========================================================================
  // 2. Buffer, Blob, File
  // =========================================================================

  function normalizeEncoding(enc) {
    if (!enc) return "utf8";
    const e = String(enc).toLowerCase();
    switch (e) {
      case "utf8":
      case "utf-8":
        return "utf8";
      case "hex":
        return "hex";
      case "base64":
        return "base64";
      case "base64url":
        return "base64url";
      case "latin1":
      case "binary":
        return "latin1";
      case "ascii":
        return "ascii";
      case "utf16le":
      case "utf-16le":
      case "ucs2":
      case "ucs-2":
        return "utf16le";
      default:
        return null;
    }
  }

  function decodeStringByEncoding(str, encoding) {
    str = String(str);
    const enc = normalizeEncoding(encoding);
    if (!enc) {
      const err = new TypeError(`Unknown encoding: ${encoding}`);
      err.code = "ERR_UNKNOWN_ENCODING";
      throw err;
    }
    switch (enc) {
      case "utf8":
        return utf8Encode(str);
      case "hex":
        return hexDecode(str);
      case "base64":
      case "base64url":
        return base64Decode(str);
      case "latin1":
      case "ascii": {
        const out = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
        return out;
      }
      case "utf16le": {
        const out = new Uint8Array(str.length * 2);
        for (let i = 0; i < str.length; i++) {
          const c = str.charCodeAt(i);
          out[i * 2] = c & 0xff;
          out[i * 2 + 1] = (c >> 8) & 0xff;
        }
        return out;
      }
    }
  }

  function validateBufferAllocSize(size) {
    if (typeof size !== "number") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "size" argument must be of type number. Received type ${typeof size}`, TypeError);
    }
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff) {
      throw makeNodeError("ERR_OUT_OF_RANGE", `The value of "size" is out of range. It must be >= 0 and <= 2147483647. Received ${size}`, RangeError);
    }
    if (size >= 256 * 1024 * 1024) {
      throw makeNodeError("ERR_MEMORY_ALLOCATION_FAILED", "Array buffer allocation failed", RangeError);
    }
  }

  class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
      if (
        value &&
        typeof value === "object" &&
        !(value instanceof ArrayBuffer) &&
        !(typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) &&
        !ArrayBuffer.isView(value) &&
        !Array.isArray(value)
      ) {
        if (typeof value[Symbol.toPrimitive] === "function") {
          value = value[Symbol.toPrimitive]("string");
        } else if (typeof value.valueOf === "function") {
          const v = value.valueOf();
          if (v !== value && (typeof v === "string" || typeof v === "object")) {
            value = v;
          }
        }
      }
      if (typeof value === "string") {
        const bytes = decodeStringByEncoding(value, encodingOrOffset);
        return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
        const off = encodingOrOffset >>> 0;
        const len = length !== undefined ? length >>> 0 : value.byteLength - off;
        return new Buffer(value, off, len);
      }
      if (ArrayBuffer.isView(value)) {
        if (value instanceof Uint8Array || value instanceof DataView) {
          const copy = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
          return new Buffer(copy.buffer, copy.byteOffset, copy.byteLength);
        }
        const copy = new Uint8Array(value);
        return new Buffer(copy.buffer, copy.byteOffset, copy.byteLength);
      }
      if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
        const copy = new Uint8Array(value.data);
        return new Buffer(copy.buffer, 0, copy.byteLength);
      }
      if (Array.isArray(value) || (value && typeof value[Symbol.iterator] === "function")) {
        const copy = new Uint8Array(value);
        return new Buffer(copy.buffer, 0, copy.byteLength);
      }
      if (value && typeof value === "object" && typeof value.length === "number") {
        const len = Math.max(0, Math.trunc(value.length) || 0);
        const out = new Buffer(len);
        for (let i = 0; i < len; i++) out[i] = value[i] & 0xff;
        return out;
      }
      throw makeNodeError(
        "ERR_INVALID_ARG_TYPE",
        "The first argument must be of type string, Buffer, ArrayBuffer, Array, or Array-like Object.",
        TypeError
      );
    }

    static alloc(size, fill, encoding) {
      validateBufferAllocSize(size);
      let buf;
      try {
        buf = new Buffer(size);
      } catch (_) {
        throw makeNodeError("ERR_MEMORY_ALLOCATION_FAILED", "Array buffer allocation failed", RangeError);
      }
      if (fill !== undefined && fill !== 0 && size > 0) {
        buf.fill(fill, 0, buf.length, encoding);
      }
      return buf;
    }

    static allocUnsafe(size) {
      validateBufferAllocSize(size);
      try {
        return new Buffer(size);
      } catch (_) {
        throw makeNodeError("ERR_MEMORY_ALLOCATION_FAILED", "Array buffer allocation failed", RangeError);
      }
    }

    static allocUnsafeSlow(size) {
      validateBufferAllocSize(size);
      try {
        return new Buffer(size);
      } catch (_) {
        throw makeNodeError("ERR_MEMORY_ALLOCATION_FAILED", "Array buffer allocation failed", RangeError);
      }
    }

    static isBuffer(obj) {
      return obj instanceof Buffer;
    }

    static isEncoding(encoding) {
      if (typeof encoding !== "string" || encoding.length === 0) return false;
      return normalizeEncoding(encoding) !== null;
    }

    static byteLength(string, encoding) {
      if (typeof string !== "string") {
        if (
          ArrayBuffer.isView(string) ||
          string instanceof ArrayBuffer ||
          (typeof SharedArrayBuffer !== "undefined" && string instanceof SharedArrayBuffer)
        ) {
          return string.byteLength;
        }
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received ${string === null ? "null" : typeof string}`,
          TypeError
        );
      }
      const enc = normalizeEncoding(encoding);
      if (enc === "base64" || enc === "base64url") {
        const trimmed = string.trim();
        let len = trimmed.length;
        if (len === 0) return 0;
        if (trimmed.charCodeAt(len - 1) === 0x3d) {
          len--;
          if (len > 0 && trimmed.charCodeAt(len - 1) === 0x3d) len--;
        }
        return (len * 3) >>> 2;
      }
      return decodeStringByEncoding(string, encoding).byteLength;
    }

    static concat(list, totalLength) {
      if (!Array.isArray(list)) throw new TypeError("list argument must be an Array");
      if (list.length === 0) return Buffer.alloc(0);
      let len = totalLength;
      if (len === undefined) {
        len = 0;
        for (let i = 0; i < list.length; i++) len += list[i].byteLength;
      }
      const out = Buffer.alloc(len);
      let offset = 0;
      for (let i = 0; i < list.length && offset < len; i++) {
        const item = list[i];
        const u8 = item instanceof Uint8Array ? item : new Uint8Array(item.buffer || item);
        const toCopy = Math.min(u8.byteLength, len - offset);
        out.set(u8.subarray(0, toCopy), offset);
        offset += toCopy;
      }
      return out;
    }

    static compare(buf1, buf2) {
      if (!(buf1 instanceof Uint8Array)) {
        const err = new TypeError(`The "buf1" argument must be an instance of Buffer or Uint8Array. Received ${buf1 === null ? "null" : typeof buf1}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (!(buf2 instanceof Uint8Array)) {
        const err = new TypeError(`The "buf2" argument must be an instance of Buffer or Uint8Array. Received ${buf2 === null ? "null" : typeof buf2}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      const a = buf1;
      const b = buf2;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }

    toString(encoding = "utf8", start = 0, end = this.length) {
      start = start === undefined ? 0 : (Math.trunc(Number(start)) || 0);
      end = end === undefined ? this.length : (Number.isNaN(Number(end)) ? 0 : Math.trunc(Number(end)));
      if (start < 0) start = 0;
      if (end > this.length) end = this.length;
      const enc = normalizeEncoding(encoding);
      if (!enc) {
        const err = new TypeError(`Unknown encoding: ${encoding}`);
        err.code = "ERR_UNKNOWN_ENCODING";
        throw err;
      }
      if (start >= end) return "";
      switch (enc) {
        case "utf8":
          return utf8Decode(this, start, end);
        case "hex":
          return hexEncode(this, start, end);
        case "base64":
          return base64Encode(this, start, end, false);
        case "base64url":
          return base64Encode(this, start, end, true);
        case "latin1": {
          let s = "";
          for (let i = start; i < end; i++) s += String.fromCharCode(this[i]);
          return s;
        }
        case "ascii": {
          let s = "";
          for (let i = start; i < end; i++) s += String.fromCharCode(this[i] & 0x7f);
          return s;
        }
        case "utf16le": {
          let s = "";
          for (let i = start; i + 1 < end; i += 2) {
            s += String.fromCharCode(this[i] | (this[i + 1] << 8));
          }
          return s;
        }
      }
    }

    write(string, offset, length, encoding) {
      if (typeof string !== "string") {
        const err = new TypeError(`The "string" argument must be of type string. Received ${string === null ? "null" : typeof string}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (offset === undefined) {
        offset = 0;
        length = this.length;
        encoding = "utf8";
      } else if (typeof offset === "string") {
        encoding = offset;
        offset = 0;
        length = this.length;
      } else {
        if (typeof offset !== "number") {
          const err = new TypeError(`The "offset" argument must be of type number. Received ${offset === null ? "null" : typeof offset}`);
          err.code = "ERR_INVALID_ARG_TYPE";
          throw err;
        }
        if (!Number.isInteger(offset) || offset < 0 || offset > this.length) {
          const err = new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${this.length}. Received ${offset}`);
          err.code = "ERR_OUT_OF_RANGE";
          throw err;
        }
        const remaining = this.length - offset;
        if (length === undefined) {
          length = remaining;
          if (encoding === undefined) encoding = "utf8";
        } else if (typeof length === "string") {
          encoding = length;
          length = remaining;
        } else {
          if (typeof length !== "number") {
            const err = new TypeError(`The "length" argument must be of type number. Received ${length === null ? "null" : typeof length}`);
            err.code = "ERR_INVALID_ARG_TYPE";
            throw err;
          }
          if (!Number.isInteger(length) || length < 0 || length > this.length) {
            const err = new RangeError(`The value of "length" is out of range. It must be >= 0 and <= ${this.length}. Received ${length}`);
            err.code = "ERR_OUT_OF_RANGE";
            throw err;
          }
          if (length > remaining) length = remaining;
          if (encoding === undefined) encoding = "utf8";
        }
      }
      const normEnc = normalizeEncoding(encoding === undefined ? "utf8" : encoding);
      if (!normEnc) {
        const err = new TypeError(`Unknown encoding: ${encoding}`);
        err.code = "ERR_UNKNOWN_ENCODING";
        throw err;
      }
      const bytes = decodeStringByEncoding(string, normEnc);
      let n = Math.min(bytes.length, length, this.length - offset);
      if (normEnc === "utf8" && n < bytes.length && n > 0 && (bytes[n] & 0xc0) === 0x80) {
        while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
      } else if (normEnc === "utf16le" && (n & 1) === 1) {
        n--;
      }
      if (n > 0) this.set(bytes.subarray(0, n), offset);
      return Math.max(0, n);
    }

    slice(start, end) {
      const sub = super.subarray(start, end);
      return new Buffer(sub.buffer, sub.byteOffset, sub.byteLength);
    }

    subarray(start, end) {
      const sub = super.subarray(start, end);
      return new Buffer(sub.buffer, sub.byteOffset, sub.byteLength);
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      if (!(target instanceof Uint8Array)) {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "target" argument must be an instance of Buffer or Uint8Array. Received ${target === null ? "null" : typeof target}`, TypeError);
      }
      targetStart = targetStart === undefined ? 0 : (Math.trunc(Number(targetStart)) || 0);
      sourceStart = sourceStart === undefined ? 0 : (Math.trunc(Number(sourceStart)) || 0);
      sourceEnd = sourceEnd === undefined ? this.length : (Math.trunc(Number(sourceEnd)) || 0);
      if (targetStart < 0 || sourceStart < 0 || sourceEnd < 0) {
        throw makeNodeError("ERR_OUT_OF_RANGE", "The value of offset is out of range.", RangeError);
      }
      sourceEnd = Math.min(this.length, sourceEnd);
      if (sourceEnd <= sourceStart || targetStart >= target.length) return 0;
      const src = this.subarray(sourceStart, sourceEnd);
      const n = Math.min(src.length, target.length - targetStart);
      if (n <= 0) return 0;
      target.set(src.subarray(0, n), targetStart);
      return n;
    }

    equals(other) {
      if (!(other instanceof Uint8Array)) {
        const err = new TypeError(`The "otherBuffer" argument must be an instance of Buffer or Uint8Array. Received ${other === null ? "null" : typeof other}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      return Buffer.compare(this, other) === 0;
    }

    compare(target, targetStart = 0, targetEnd = target && target.length, sourceStart = 0, sourceEnd = this.length) {
      if (!(target instanceof Uint8Array)) {
        const err = new TypeError(`The "target" argument must be an instance of Buffer or Uint8Array. Received ${target === null ? "null" : typeof target}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      targetStart = targetStart === undefined ? 0 : (Math.trunc(Number(targetStart)) || 0);
      targetEnd = targetEnd === undefined ? target.length : (Math.trunc(Number(targetEnd)) || 0);
      sourceStart = sourceStart === undefined ? 0 : (Math.trunc(Number(sourceStart)) || 0);
      sourceEnd = sourceEnd === undefined ? this.length : (Math.trunc(Number(sourceEnd)) || 0);
      if (
        targetStart < 0 ||
        targetEnd < 0 ||
        sourceStart < 0 ||
        sourceEnd < 0 ||
        targetStart > target.length ||
        targetEnd > target.length ||
        sourceStart > this.length ||
        sourceEnd > this.length
      ) {
        throw makeNodeError("ERR_OUT_OF_RANGE", "The value of offset is out of range.", RangeError);
      }
      return Buffer.compare(
        this.subarray(sourceStart, sourceEnd),
        target.subarray(targetStart, targetEnd)
      );
    }

    fill(value, offset = 0, end = this.length, encoding = "utf8") {
      if (typeof offset === "string") {
        encoding = offset;
        offset = 0;
        end = this.length;
      } else if (typeof end === "string") {
        encoding = end;
        end = this.length;
      }
      offset = Math.trunc(Number(offset)) || 0;
      end = end === undefined ? this.length : (Math.trunc(Number(end)) || 0);
      if (offset < 0 || end < 0 || offset > this.length || end > this.length) {
        throw makeNodeError("ERR_OUT_OF_RANGE", "The value of offset is out of range.", RangeError);
      }
      if (typeof value === "number") {
        super.fill(value & 0xff, offset, end);
        return this;
      }
      if (typeof value !== "string" && !(value instanceof Uint8Array) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
        super.fill((Number(value) || 0) & 0xff, offset, end);
        return this;
      }
      const bytes = typeof value === "string" ? decodeStringByEncoding(value, encoding) : Buffer.from(value);
      if (bytes.length === 0) {
        super.fill(0, offset, end);
        return this;
      }
      for (let i = offset; i < end; i++) {
        this[i] = bytes[(i - offset) % bytes.length];
      }
      return this;
    }

    indexOf(value, byteOffset = 0, encoding = "utf8") {
      if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = 0;
      } else {
        byteOffset = Math.trunc(Number(byteOffset)) || 0;
      }
      if (byteOffset < 0) byteOffset = Math.max(0, this.length + byteOffset);
      if (typeof value === "number") {
        return super.indexOf(value & 0xff, byteOffset);
      }
      const needle = typeof value === "string" ? decodeStringByEncoding(value, encoding) : value;
      if (needle.length === 0) return Math.min(byteOffset, this.length);
      outer: for (let i = byteOffset; i <= this.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (this[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    includes(value, byteOffset = 0, encoding = "utf8") {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    lastIndexOf(value, byteOffset, encoding = "utf8") {
      let hasOffset = byteOffset !== undefined;
      if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = undefined;
        hasOffset = false;
      }
      if (!hasOffset) {
        byteOffset = this.length;
      } else {
        byteOffset = Math.trunc(Number(byteOffset));
        if (Number.isNaN(byteOffset)) byteOffset = this.length;
      }
      if (byteOffset < 0) byteOffset = this.length + byteOffset;
      if (byteOffset < 0) return -1;
      if (typeof value === "number") {
        if (this.length === 0) return -1;
        return super.lastIndexOf(value & 0xff, Math.min(byteOffset, this.length - 1));
      }
      const needle = typeof value === "string" ? decodeStringByEncoding(value, encoding) : value;
      if (needle.length === 0) return Math.min(byteOffset, this.length);
      const start = Math.min(byteOffset, this.length - needle.length);
      outer: for (let i = start; i >= 0; i--) {
        for (let j = 0; j < needle.length; j++) {
          if (this[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    swap16() {
      if (this.length % 2 !== 0) throw new RangeError("Buffer size must be a multiple of 16-bits");
      for (let i = 0; i < this.length; i += 2) {
        const t = this[i];
        this[i] = this[i + 1];
        this[i + 1] = t;
      }
      return this;
    }

    swap32() {
      if (this.length % 4 !== 0) throw new RangeError("Buffer size must be a multiple of 32-bits");
      for (let i = 0; i < this.length; i += 4) {
        let t = this[i]; this[i] = this[i + 3]; this[i + 3] = t;
        t = this[i + 1]; this[i + 1] = this[i + 2]; this[i + 2] = t;
      }
      return this;
    }

    swap64() {
      if (this.length % 8 !== 0) throw new RangeError("Buffer size must be a multiple of 64-bits");
      for (let i = 0; i < this.length; i += 8) {
        for (let j = 0; j < 4; j++) {
          const t = this[i + j];
          this[i + j] = this[i + 7 - j];
          this[i + 7 - j] = t;
        }
      }
      return this;
    }

    toJSON() {
      return { type: "Buffer", data: Array.from(this) };
    }

    _dv() {
      return new DataView(this.buffer, this.byteOffset, this.byteLength);
    }

    _checkOffset(offset, byteLen) {
      if (typeof offset !== "number") {
        const err = new TypeError(`The "offset" argument must be of type number. Received ${offset === null ? "null" : typeof offset}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (!Number.isInteger(offset)) {
        const err = new RangeError(`The value of "offset" is out of range. It must be an integer. Received ${offset}`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
      if (byteLen > this.length) {
        const err = new RangeError(`Attempt to access memory outside buffer bounds`);
        err.code = "ERR_BUFFER_OUT_OF_BOUNDS";
        throw err;
      }
      if (offset < 0 || offset + byteLen > this.length) {
        const err = new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${this.length - byteLen}. Received ${offset}`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
    }
    _checkByteLen(byteLength) {
      if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
        const err = new RangeError(`The value of "byteLength" is out of range. It must be >= 1 and <= 6. Received ${byteLength}`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
    }
    _checkIntVal(value, min, max) {
      const v = Number(value);
      if (typeof value !== "number" || !Number.isFinite(v) || v < min || v > max) {
        const err = new RangeError(`The value of "value" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
      return v;
    }
    _checkBigIntVal(value, min, max) {
      if (typeof value !== "bigint") {
        const err = new TypeError(`The "value" argument must be of type bigint. Received ${typeof value}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (value < min || value > max) {
        const err = new RangeError(`The value of "value" is out of range. It must be >= ${min}n and <= ${max}n. Received ${value}n`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
      return value;
    }

    readUIntLE(offset, byteLength) {
      this._checkByteLen(byteLength);
      this._checkOffset(offset, byteLength);
      let val = 0;
      let mul = 1;
      for (let i = 0; i < byteLength; i++) {
        val += this[offset + i] * mul;
        mul *= 256;
      }
      return val;
    }
    readUIntBE(offset, byteLength) {
      this._checkByteLen(byteLength);
      this._checkOffset(offset, byteLength);
      let val = 0;
      for (let i = 0; i < byteLength; i++) {
        val = val * 256 + this[offset + i];
      }
      return val;
    }
    readIntLE(offset, byteLength) {
      let val = this.readUIntLE(offset, byteLength);
      const limit = Math.pow(2, 8 * byteLength - 1);
      if (val >= limit) val -= limit * 2;
      return val;
    }
    readIntBE(offset, byteLength) {
      let val = this.readUIntBE(offset, byteLength);
      const limit = Math.pow(2, 8 * byteLength - 1);
      if (val >= limit) val -= limit * 2;
      return val;
    }
    writeUIntLE(value, offset, byteLength) {
      this._checkByteLen(byteLength);
      let v = Math.floor(this._checkIntVal(value, 0, Math.pow(2, 8 * byteLength) - 1));
      this._checkOffset(offset, byteLength);
      for (let i = 0; i < byteLength; i++) {
        this[offset + i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      return offset + byteLength;
    }
    writeUIntBE(value, offset, byteLength) {
      this._checkByteLen(byteLength);
      let v = Math.floor(this._checkIntVal(value, 0, Math.pow(2, 8 * byteLength) - 1));
      this._checkOffset(offset, byteLength);
      for (let i = byteLength - 1; i >= 0; i--) {
        this[offset + i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      return offset + byteLength;
    }
    writeIntLE(value, offset, byteLength) {
      this._checkByteLen(byteLength);
      const limit = Math.pow(2, 8 * byteLength - 1);
      let v = Math.floor(this._checkIntVal(value, -limit, limit - 1));
      this._checkOffset(offset, byteLength);
      if (v < 0) v += limit * 2;
      for (let i = 0; i < byteLength; i++) {
        this[offset + i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      return offset + byteLength;
    }
    writeIntBE(value, offset, byteLength) {
      this._checkByteLen(byteLength);
      const limit = Math.pow(2, 8 * byteLength - 1);
      let v = Math.floor(this._checkIntVal(value, -limit, limit - 1));
      this._checkOffset(offset, byteLength);
      if (v < 0) v += limit * 2;
      for (let i = byteLength - 1; i >= 0; i--) {
        this[offset + i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      return offset + byteLength;
    }

    readUInt8(offset = 0) { this._checkOffset(offset, 1); return this._dv().getUint8(offset); }
    readInt8(offset = 0) { this._checkOffset(offset, 1); return this._dv().getInt8(offset); }
    readUInt16LE(offset = 0) { this._checkOffset(offset, 2); return this._dv().getUint16(offset, true); }
    readUInt16BE(offset = 0) { this._checkOffset(offset, 2); return this._dv().getUint16(offset, false); }
    readInt16LE(offset = 0) { this._checkOffset(offset, 2); return this._dv().getInt16(offset, true); }
    readInt16BE(offset = 0) { this._checkOffset(offset, 2); return this._dv().getInt16(offset, false); }
    readUInt32LE(offset = 0) { this._checkOffset(offset, 4); return this._dv().getUint32(offset, true); }
    readUInt32BE(offset = 0) { this._checkOffset(offset, 4); return this._dv().getUint32(offset, false); }
    readInt32LE(offset = 0) { this._checkOffset(offset, 4); return this._dv().getInt32(offset, true); }
    readInt32BE(offset = 0) { this._checkOffset(offset, 4); return this._dv().getInt32(offset, false); }
    readBigUInt64LE(offset = 0) { this._checkOffset(offset, 8); return this._dv().getBigUint64(offset, true); }
    readBigUInt64BE(offset = 0) { this._checkOffset(offset, 8); return this._dv().getBigUint64(offset, false); }
    readBigInt64LE(offset = 0) { this._checkOffset(offset, 8); return this._dv().getBigInt64(offset, true); }
    readBigInt64BE(offset = 0) { this._checkOffset(offset, 8); return this._dv().getBigInt64(offset, false); }
    readFloatLE(offset = 0) { this._checkOffset(offset, 4); return this._dv().getFloat32(offset, true); }
    readFloatBE(offset = 0) { this._checkOffset(offset, 4); return this._dv().getFloat32(offset, false); }
    readDoubleLE(offset = 0) { this._checkOffset(offset, 8); return this._dv().getFloat64(offset, true); }
    readDoubleBE(offset = 0) { this._checkOffset(offset, 8); return this._dv().getFloat64(offset, false); }

    writeUInt8(value, offset = 0) { const v = this._checkIntVal(value, 0, 0xff); this._checkOffset(offset, 1); this._dv().setUint8(offset, v); return offset + 1; }
    writeInt8(value, offset = 0) { const v = this._checkIntVal(value, -0x80, 0x7f); this._checkOffset(offset, 1); this._dv().setInt8(offset, v); return offset + 1; }
    writeUInt16LE(value, offset = 0) { const v = this._checkIntVal(value, 0, 0xffff); this._checkOffset(offset, 2); this._dv().setUint16(offset, v, true); return offset + 2; }
    writeUInt16BE(value, offset = 0) { const v = this._checkIntVal(value, 0, 0xffff); this._checkOffset(offset, 2); this._dv().setUint16(offset, v, false); return offset + 2; }
    writeInt16LE(value, offset = 0) { const v = this._checkIntVal(value, -0x8000, 0x7fff); this._checkOffset(offset, 2); this._dv().setInt16(offset, v, true); return offset + 2; }
    writeInt16BE(value, offset = 0) { const v = this._checkIntVal(value, -0x8000, 0x7fff); this._checkOffset(offset, 2); this._dv().setInt16(offset, v, false); return offset + 2; }
    writeUInt32LE(value, offset = 0) { const v = this._checkIntVal(value, 0, 0xffffffff); this._checkOffset(offset, 4); this._dv().setUint32(offset, v, true); return offset + 4; }
    writeUInt32BE(value, offset = 0) { const v = this._checkIntVal(value, 0, 0xffffffff); this._checkOffset(offset, 4); this._dv().setUint32(offset, v, false); return offset + 4; }
    writeInt32LE(value, offset = 0) { const v = this._checkIntVal(value, -0x80000000, 0x7fffffff); this._checkOffset(offset, 4); this._dv().setInt32(offset, v, true); return offset + 4; }
    writeInt32BE(value, offset = 0) { const v = this._checkIntVal(value, -0x80000000, 0x7fffffff); this._checkOffset(offset, 4); this._dv().setInt32(offset, v, false); return offset + 4; }
    writeBigUInt64LE(value, offset = 0) { const v = this._checkBigIntVal(value, 0n, 0xffffffffffffffffn); this._checkOffset(offset, 8); this._dv().setBigUint64(offset, v, true); return offset + 8; }
    writeBigUInt64BE(value, offset = 0) { const v = this._checkBigIntVal(value, 0n, 0xffffffffffffffffn); this._checkOffset(offset, 8); this._dv().setBigUint64(offset, v, false); return offset + 8; }
    writeBigInt64LE(value, offset = 0) { const v = this._checkBigIntVal(value, -0x8000000000000000n, 0x7fffffffffffffffn); this._checkOffset(offset, 8); this._dv().setBigInt64(offset, v, true); return offset + 8; }
    writeBigInt64BE(value, offset = 0) { const v = this._checkBigIntVal(value, -0x8000000000000000n, 0x7fffffffffffffffn); this._checkOffset(offset, 8); this._dv().setBigInt64(offset, v, false); return offset + 8; }
    writeFloatLE(value, offset = 0) { this._checkOffset(offset, 4); this._dv().setFloat32(offset, value, true); return offset + 4; }
    writeFloatBE(value, offset = 0) { this._checkOffset(offset, 4); this._dv().setFloat32(offset, value, false); return offset + 4; }
    writeDoubleLE(value, offset = 0) { this._checkOffset(offset, 8); this._dv().setFloat64(offset, value, true); return offset + 8; }
    writeDoubleBE(value, offset = 0) { this._checkOffset(offset, 8); this._dv().setFloat64(offset, value, false); return offset + 8; }
  }

  Buffer.prototype.readUintLE = Buffer.prototype.readUIntLE;
  Buffer.prototype.readUintBE = Buffer.prototype.readUIntBE;
  Buffer.prototype.writeUintLE = Buffer.prototype.writeUIntLE;
  Buffer.prototype.writeUintBE = Buffer.prototype.writeUIntBE;
  Buffer.prototype.readUint8 = Buffer.prototype.readUInt8;
  Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE;
  Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE;
  Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE;
  Buffer.prototype.readBigUint64LE = Buffer.prototype.readBigUInt64LE;
  Buffer.prototype.readBigUint64BE = Buffer.prototype.readBigUInt64BE;
  Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8;
  Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE;
  Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE;
  Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE;
  Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE;
  Buffer.prototype.writeBigUint64LE = Buffer.prototype.writeBigUInt64LE;
  Buffer.prototype.writeBigUint64BE = Buffer.prototype.writeBigUInt64BE;
  Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE;
  Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE;
  Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE;
  Buffer.prototype.readBigUint64LE = Buffer.prototype.readBigUInt64LE;
  Buffer.prototype.readBigUint64BE = Buffer.prototype.readBigUInt64BE;
  Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8;
  Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE;
  Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE;
  Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE;
  Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE;
  Buffer.prototype.writeBigUint64LE = Buffer.prototype.writeBigUInt64LE;
  Buffer.prototype.writeBigUint64BE = Buffer.prototype.writeBigUInt64BE;

  Buffer.poolSize = 8192;
  Buffer.prototype.inspect = function inspect() {
    const max = 50;
    const hex = this.subarray(0, max).toString("hex").replace(/(..)/g, "$1 ").trim();
    return `<Buffer ${hex}${this.length > max ? ` ... ${this.length - max} more bytes` : ""}>`;
  };
  globalThis.Buffer = Buffer;

  class Blob {
    constructor(parts = [], options = {}) {
      const chunks = [];
      for (const p of parts) {
        if (typeof p === "string") {
          chunks.push(utf8Encode(p));
        } else if (p instanceof Blob) {
          chunks.push(p._bytes);
        } else if (p instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(p));
        } else if (ArrayBuffer.isView(p)) {
          chunks.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
        } else if (p !== undefined && p !== null) {
          chunks.push(utf8Encode(String(p)));
        }
      }
      this._bytes = Buffer.concat(chunks);
      this.size = this._bytes.byteLength;
      this.type = options && options.type ? String(options.type).toLowerCase() : "";
    }
    async text() {
      const s = utf8Decode(this._bytes);
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }
    async arrayBuffer() {
      return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
    }
    async bytes() {
      return new Uint8Array(this._bytes);
    }
    slice(start = 0, end = this.size, contentType = "") {
      const sub = this._bytes.subarray(start, end);
      return new Blob([sub], { type: contentType });
    }
    stream() {
      const bytes = this._bytes;
      return new ReadableStream({
        start(ctrl) {
          if (bytes.byteLength > 0) ctrl.enqueue(new Uint8Array(bytes));
          ctrl.close();
        },
      });
    }
  }

  class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    }
  }

  globalThis.Blob = Blob;
  globalThis.File = File;

  builtins["buffer"] = {
    Buffer,
    SlowBuffer: Buffer,
    Blob,
    File,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    kMaxLength: 0x7fffffff,
    constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffe8 },
    isUtf8(buf) {
      let u;
      if (buf instanceof Uint8Array) u = buf;
      else if (buf instanceof ArrayBuffer) u = new Uint8Array(buf);
      else if (ArrayBuffer.isView(buf)) u = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      else throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"input\" argument must be an instance of TypedArray or ArrayBuffer", TypeError);
      try {
        utf8DecodeEx(u, 0, u.length, true, false);
        return true;
      } catch (_) {
        return false;
      }
    },
    isAscii: (buf) => {
      const u = buf instanceof Uint8Array ? buf : Buffer.from(buf);
      for (let i = 0; i < u.length; i++) if (u[i] > 0x7f) return false;
      return true;
    },
    transcode(source, fromEnc, toEnc) {
      if (!(source instanceof Uint8Array) && !ArrayBuffer.isView(source)) {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"source\" argument must be an instance of Buffer or Uint8Array", TypeError);
      }
      const f = normalizeEncoding(fromEnc);
      const t = normalizeEncoding(toEnc);
      const srcBuf = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
      const decoded = srcBuf.toString(f);
      if (t === "latin1" || t === "ascii") {
        const max = t === "ascii" ? 0x7f : 0xff;
        const out = Buffer.allocUnsafe(decoded.length);
        for (let i = 0; i < decoded.length; i++) {
          const c = decoded.charCodeAt(i);
          out[i] = c > max ? 0x3f : c;
        }
        return out;
      }
      return Buffer.from(decoded, t);
    },
  };

  // =========================================================================
  // 3. Events (EventEmitter, EventTarget, Event, CustomEvent, AbortController)
  // =========================================================================

  const kCaptureRejectionSymbol = Symbol.for("nodejs.rejection");
  const kErrorMonitor = Symbol("events.errorMonitor");

  class EventEmitter {
    constructor() {
      this._events = Object.create(null);
      this._maxListeners = EventEmitter.defaultMaxListeners;
    }
    setMaxListeners(n) {
      this._maxListeners = n;
      return this;
    }
    getMaxListeners() {
      return this._maxListeners;
    }
    on(type, listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      if (!this._events) this._events = Object.create(null);
      if (this._events.newListener && this._events.newListener.length > 0) {
        this.emit("newListener", type, listener.listener || listener);
      }
      if (!this._events[type]) this._events[type] = [];
      this._events[type].push(listener);
      return this;
    }
    addListener(type, listener) {
      return this.on(type, listener);
    }
    prependListener(type, listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      if (!this._events) this._events = Object.create(null);
      if (this._events.newListener && this._events.newListener.length > 0) {
        this.emit("newListener", type, listener.listener || listener);
      }
      if (!this._events[type]) this._events[type] = [];
      this._events[type].unshift(listener);
      return this;
    }
    once(type, listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      const wrapped = (...args) => {
        this.removeListener(type, wrapped);
        listener.apply(this, args);
      };
      wrapped.listener = listener;
      return this.on(type, wrapped);
    }
    prependOnceListener(type, listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      const wrapped = (...args) => {
        this.removeListener(type, wrapped);
        listener.apply(this, args);
      };
      wrapped.listener = listener;
      return this.prependListener(type, wrapped);
    }
    removeListener(type, listener) {
      if (!this._events || !this._events[type]) return this;
      const list = this._events[type];
      let removed = null;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          removed = list[i];
          list.splice(i, 1);
          break;
        }
      }
      if (list.length === 0) delete this._events[type];
      if (removed && this._events.removeListener && this._events.removeListener.length > 0) {
        this.emit("removeListener", type, removed.listener || removed);
      }
      return this;
    }
    off(type, listener) {
      return this.removeListener(type, listener);
    }
    removeAllListeners(type) {
      if (!this._events) return this;
      const hasRemoveListener = Boolean(this._events.removeListener && this._events.removeListener.length > 0);
      if (!hasRemoveListener) {
        if (type === undefined) {
          this._events = Object.create(null);
        } else {
          delete this._events[type];
        }
        return this;
      }
      if (type === undefined) {
        for (const key of Reflect.ownKeys(this._events)) {
          if (key === "removeListener") continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners("removeListener");
        this._events = Object.create(null);
        return this;
      }
      const listeners = this._events[type];
      if (listeners) {
        for (let i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }
      return this;
    }
    listeners(type) {
      if (!this._events || !this._events[type]) return [];
      return this._events[type].map((fn) => fn.listener || fn);
    }
    rawListeners(type) {
      if (!this._events || !this._events[type]) return [];
      return this._events[type].slice();
    }
    listenerCount(type) {
      if (!this._events || !this._events[type]) return 0;
      return this._events[type].length;
    }
    eventNames() {
      if (!this._events) return [];
      return Reflect.ownKeys(this._events);
    }
    emit(type, ...args) {
      if (type === "error" && this._events && this._events[kErrorMonitor] && this._events[kErrorMonitor].length > 0) {
        const monitors = this._events[kErrorMonitor].slice();
        for (let i = 0; i < monitors.length; i++) {
          monitors[i].apply(this, args);
        }
      }
      if (type === "error" && (!this._events || !this._events.error || this._events.error.length === 0)) {
        const err = args[0];
        if (err instanceof Error) throw err;
        throw new Error(`Unhandled error.${err !== undefined ? ` (${err})` : ""}`);
      }
      if (!this._events || !this._events[type]) return false;
      const handlers = this._events[type].slice();
      for (let i = 0; i < handlers.length; i++) {
        handlers[i].apply(this, args);
      }
      return true;
    }
  }
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.once = function once(emitter, name, options) {
    const signal = options && typeof options === "object" ? options.signal : undefined;
    return new Promise((resolve, reject) => {
      if (signal) {
        if (signal.aborted) {
          const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
          return reject(err);
        }
      }
      if (typeof emitter.once === "function") {
        let onAbort = null;
        const cleanup = () => {
          emitter.removeListener(name, onEvent);
          if (name !== "error") emitter.removeListener("error", onError);
          if (onAbort && signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
        };
        const onEvent = (...args) => {
          cleanup();
          resolve(args);
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        if (signal && typeof signal.addEventListener === "function") {
          onAbort = () => {
            cleanup();
            const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
            reject(err);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
        emitter.once(name, onEvent);
        if (name !== "error") emitter.once("error", onError);
      } else if (typeof emitter.addEventListener === "function") {
        let onAbort = null;
        const onEvent = (ev) => {
          if (onAbort && signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
          resolve([ev]);
        };
        if (signal && typeof signal.addEventListener === "function") {
          onAbort = () => {
            if (typeof emitter.removeEventListener === "function") {
              emitter.removeEventListener(name, onEvent);
            }
            const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
            reject(err);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
        emitter.addEventListener(name, onEvent, { once: true });
      } else {
        reject(new TypeError("The \"emitter\" argument must be an instance of EventEmitter or EventTarget"));
      }
    });
  };
  EventEmitter.on = function on(emitter, event, options) {
    if (!emitter || (typeof emitter.on !== "function" && typeof emitter.addEventListener !== "function")) {
      throw new TypeError("The \"emitter\" argument must be an instance of EventEmitter or EventTarget");
    }
    const signal = options && typeof options === "object" ? options.signal : undefined;
    const queue = [];
    let pendingResolve = null;
    let pendingReject = null;
    let done = false;
    const handler = (...args) => {
      if (done) return;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        r({ value: args, done: false });
      } else {
        queue.push({ value: args });
      }
    };
    const errorHandler = (err) => {
      if (done) return;
      done = true;
      cleanupListeners();
      if (pendingReject) {
        const rej = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        rej(err);
      } else {
        queue.push({ error: err });
      }
    };
    let onAbort = null;
    const isEE = typeof emitter.on === "function";
    let listenersAttached = false;
    const cleanupListeners = () => {
      if (!listenersAttached) return;
      listenersAttached = false;
      if (isEE) {
        emitter.off(event, handler);
        if (event !== "error") emitter.off("error", errorHandler);
      } else if (typeof emitter.removeEventListener === "function") {
        emitter.removeEventListener(event, handler);
      }
      if (onAbort && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    if (signal && signal.aborted) {
      const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
      errorHandler(err);
    } else {
      listenersAttached = true;
      if (signal && typeof signal.addEventListener === "function") {
        onAbort = () => {
          const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
          errorHandler(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (isEE) {
        emitter.on(event, handler);
        if (event !== "error") emitter.on("error", errorHandler);
      } else {
        emitter.addEventListener(event, handler);
      }
    }
    const gen = (async function* () {
      try {
        while (true) {
          if (queue.length > 0) {
            const item = queue.shift();
            if ("error" in item) throw item.error;
            yield item.value;
          } else if (done) {
            break;
          } else {
            const step = await new Promise((res, rej) => {
              pendingResolve = res;
              pendingReject = rej;
            });
            if (step.done) break;
            yield step.value;
          }
        }
      } finally {
        done = true;
        cleanupListeners();
      }
    })();
    const origReturn = gen.return.bind(gen);
    gen.return = function (val) {
      done = true;
      cleanupListeners();
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        r({ value: undefined, done: true });
      }
      return origReturn(val);
    };
    return gen;
  };

  class Event {
    constructor(type, eventInitDict = {}) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
      }
      this.type = String(type);
      this.bubbles = Boolean(eventInitDict && eventInitDict.bubbles);
      this.cancelable = Boolean(eventInitDict && eventInitDict.cancelable);
      this.composed = Boolean(eventInitDict && eventInitDict.composed);
      this.defaultPrevented = false;
      this.timeStamp = perfObj.now();
      this.target = null;
      this.currentTarget = null;
      this.srcElement = null;
      this.eventPhase = 0;
      this.isTrusted = false;
      this._stopImmediate = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
    stopPropagation() {}
    stopImmediatePropagation() {
      this._stopImmediate = true;
    }
    composedPath() {
      return this.currentTarget ? [this.currentTarget] : [];
    }
  }

  class CustomEvent extends Event {
    constructor(type, eventInitDict = {}) {
      super(type, eventInitDict);
      this.detail = eventInitDict && eventInitDict.detail !== undefined ? eventInitDict.detail : null;
    }
  }

  class EventTarget {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, listener, options) {
      if (listener === null || listener === undefined) return;
      if (typeof listener !== "function" && (typeof listener !== "object" || typeof listener.handleEvent !== "function")) {
        throw new TypeError("The \"listener\" argument must be of type Function or an Object with a handleEvent method");
      }
      const capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
      const once = Boolean(options && typeof options === "object" && options.once);
      const sig = options && typeof options === "object" ? options.signal : undefined;
      if (sig && sig.aborted) return;
      const key = String(type);
      let list = this._listeners.get(key);
      if (!list) {
        list = [];
        this._listeners.set(key, list);
      }
      for (let i = 0; i < list.length; i++) {
        if (list[i].listener === listener && list[i].capture === capture) return;
      }
      const entry = { listener, capture, once, removed: false };
      list.push(entry);
      if (sig && typeof sig.addEventListener === "function") {
        sig.addEventListener("abort", () => {
          this.removeEventListener(key, listener, options);
        }, { once: true });
      }
    }
    removeEventListener(type, listener, options) {
      const capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
      const key = String(type);
      const list = this._listeners.get(key);
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        if (list[i].listener === listener && list[i].capture === capture) {
          list[i].removed = true;
          list.splice(i, 1);
          break;
        }
      }
    }
    dispatchEvent(event) {
      if (!event || !(event instanceof Event)) {
        throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
      }
      event.target = this;
      event.srcElement = this;
      event.currentTarget = this;
      event.eventPhase = 2;
      const key = String(event.type);
      const list = this._listeners.get(key);
      if (list && list.length > 0) {
        const snapshot = list.slice();
        for (let i = 0; i < snapshot.length; i++) {
          const entry = snapshot[i];
          if (entry.removed) continue;
          if (entry.once) {
            entry.removed = true;
            const idx = list.indexOf(entry);
            if (idx !== -1) list.splice(idx, 1);
          }
          try {
            if (typeof entry.listener === "function") {
              entry.listener.call(this, event);
            } else if (entry.listener && typeof entry.listener.handleEvent === "function") {
              entry.listener.handleEvent(event);
            }
          } catch (err) {
            processObj.nextTick(() => {
              if (!handleUncaughtException(err)) {
                throw err;
              }
            });
          }
          if (event._stopImmediate) break;
        }
      }
      event.currentTarget = null;
      event.eventPhase = 0;
      return !event.defaultPrevented;
    }
  }

  class AbortSignal extends EventTarget {
    constructor() {
      super();
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    static abort(reason) {
      const sig = new AbortSignal();
      sig.aborted = true;
      sig.reason = reason !== undefined ? reason : new DOMException("This operation was aborted", "AbortError");
      return sig;
    }
    static timeout(ms) {
      const ctrl = new AbortController();
      const t = setTimeout(() => {
        ctrl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      }, ms);
      t.unref();
      return ctrl.signal;
    }
    static any(signals) {
      if (!signals || typeof signals[Symbol.iterator] !== "function") {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"signals\" argument must be an Iterable", TypeError);
      }
      const list = Array.from(signals);
      for (const s of list) {
        if (!s || typeof s !== "object" || typeof s.aborted !== "boolean") {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"signals\" argument must contain AbortSignal instances", TypeError);
        }
        if (s.aborted) {
          return AbortSignal.abort(s.reason);
        }
      }
      const ctrl = new AbortController();
      const cleanups = [];
      const onSubAbort = (s) => {
        for (const fn of cleanups) fn();
        cleanups.length = 0;
        ctrl.abort(s.reason);
      };
      for (const s of list) {
        const handler = () => onSubAbort(s);
        s.addEventListener("abort", handler, { once: true });
        cleanups.push(() => s.removeEventListener("abort", handler));
      }
      return ctrl.signal;
    }
  }

  class AbortController {
    constructor() {
      this.signal = new AbortSignal();
    }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason !== undefined ? reason : new DOMException("This operation was aborted", "AbortError");
      const ev = new Event("abort");
      this.signal.dispatchEvent(ev);
      if (typeof this.signal.onabort === "function") {
        this.signal.onabort(ev);
      }
    }
  }

  globalThis.Event = Event;
  globalThis.CustomEvent = CustomEvent;
  globalThis.EventTarget = EventTarget;
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;

  EventEmitter.captureRejectionSymbol = kCaptureRejectionSymbol;
  EventEmitter.errorMonitor = kErrorMonitor;
  EventEmitter.captureRejections = false;
  EventEmitter.listenerCount = (emitter, type) => (emitter && typeof emitter.listenerCount === "function" ? emitter.listenerCount(type) : 0);
  EventEmitter.getMaxListeners = (emitter) => (emitter && typeof emitter.getMaxListeners === "function" ? emitter.getMaxListeners() : EventEmitter.defaultMaxListeners);
  EventEmitter.getEventListeners = (emitter, name) => {
    if (emitter && typeof emitter.listeners === "function") return emitter.listeners(name);
    if (emitter instanceof EventTarget && emitter._listeners) {
      const list = emitter._listeners.get(String(name));
      return list ? list.map((e) => e.listener) : [];
    }
    return [];
  };
  EventEmitter.setMaxListeners = (n, ...targets) => {
    if (targets.length === 0) {
      EventEmitter.defaultMaxListeners = n;
      return;
    }
    for (const t of targets) if (t && typeof t.setMaxListeners === "function") t.setMaxListeners(n);
  };
  EventEmitter.addAbortListener = (signal, listener) => {
    if (!signal || typeof signal.aborted !== "boolean") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'signal' argument must be an instance of AbortSignal", TypeError);
    }
    if (typeof listener !== "function") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'listener' argument must be of type Function", TypeError);
    }
    let removed = false;
    const remove = () => {
      if (!removed) {
        removed = true;
        if (typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", listener);
        }
      }
    };
    if (signal.aborted) {
      listener();
    } else if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", listener, { once: true });
    }
    return {
      [Symbol.dispose || Symbol.for("nodejs.dispose")]: remove,
    };
  };

  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.Event = Event;
  EventEmitter.CustomEvent = CustomEvent;
  EventEmitter.EventTarget = EventTarget;
  EventEmitter.captureRejectionSymbol = kCaptureRejectionSymbol;
  EventEmitter.errorMonitor = kErrorMonitor;
  EventEmitter.captureRejections = false;
  builtins["events"] = EventEmitter;

  // =========================================================================
  // 4. Event Loop Dispatch, Timers, NextTick, Performance
  // =========================================================================

  let nextAsyncId = 1;
  let activeRefs = 0;
  const timersMap = new Map();
  const pendingFetches = new Map();
  const activeChildren = new Map();
  const activeServers = new Map();
  const nextTickQueue = [];
  const pendingAsyncOps = new Map();

  function incRef() { activeRefs++; }
  function decRef() { if (activeRefs > 0) activeRefs--; }

  function hostAsyncCall(op, argsStr, binData, signal) {
    return new Promise((resolve, reject) => {
      if (signal) {
        if (typeof signal !== "object" || typeof signal.aborted !== "boolean") {
          const err = makeNodeError("ERR_INVALID_ARG_TYPE", "The \"options.signal\" property must be an instance of AbortSignal", TypeError);
          reject(err);
          return;
        }
        if (signal.aborted) {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason }));
          return;
        }
      }
      const id = nextAsyncId++;
      incRef();
      let onAbort = null;
      const cleanup = () => {
        if (onAbort && signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      };
      if (signal && typeof signal.addEventListener === "function") {
        onAbort = () => {
          if (pendingAsyncOps.has(id)) {
            pendingAsyncOps.delete(id);
            cleanup();
            decRef();
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason }));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      pendingAsyncOps.set(id, { resolve, reject, cleanup });
      try {
        hostCall("async.call", JSON.stringify({ id, op: String(op), args: argsStr ? String(argsStr) : "" }), binData);
      } catch (err) {
        pendingAsyncOps.delete(id);
        cleanup();
        decRef();
        reject(err);
      }
    });
  }

  let timerSeq = 0;
  class Timeout {
    constructor(fn, delayMs, args, isInterval, isImmediate = false) {
      this._id = nextAsyncId++;
      this._seq = ++timerSeq;
      this._fn = fn;
      let d = Number(delayMs);
      if (isImmediate) {
        d = 0;
      } else if (!Number.isFinite(d) || d < 0 || d > 2147483647) {
        d = isInterval ? 1 : 0;
      } else {
        d = Math.floor(d);
        if (isInterval && d < 1) d = 1;
      }
      this._delay = d;
      this._args = args;
      this._isInterval = isInterval;
      this._isImmediate = Boolean(isImmediate);
      this._wantRef = true;
      this._refed = false;
      this._cleared = true;
      this._destroyed = false;
      this._deadline = 0;
      this._startTimer();
    }
    _startTimer() {
      this._cleared = false;
      this._seq = ++timerSeq;
      this._deadline = Date.now() + this._delay;
      if (this._wantRef && !this._refed) {
        this._refed = true;
        incRef();
      }
      timersMap.set(this._id, this);
      hostCall("timer.start", JSON.stringify({ id: this._id, delayMs: this._delay }));
    }
    ref() {
      this._wantRef = true;
      if (!this._cleared && !this._refed) {
        this._refed = true;
        incRef();
      }
      return this;
    }
    unref() {
      this._wantRef = false;
      if (!this._cleared && this._refed) {
        this._refed = false;
        decRef();
      }
      return this;
    }
    hasRef() {
      return this._refed && !this._cleared;
    }
    refresh() {
      if (this._destroyed) return this;
      hostCall("timer.cancel", String(this._id));
      this._startTimer();
      return this;
    }
    _clear() {
      if (this._cleared) return;
      this._cleared = true;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      timersMap.delete(this._id);
      hostCall("timer.cancel", String(this._id));
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  function setTimeout(fn, delay = 0, ...args) {
    if (typeof fn !== "function") throw new TypeError("Callback must be a function");
    return new Timeout(fn, delay, args, false);
  }
  function clearTimeout(t) {
    if (!t) return;
    const entry = typeof t === "number" ? timersMap.get(t) : t;
    if (entry && typeof entry._clear === "function") {
      entry._destroyed = true;
      entry._clear();
    }
  }
  function setInterval(fn, delay = 0, ...args) {
    if (typeof fn !== "function") throw new TypeError("Callback must be a function");
    return new Timeout(fn, delay, args, true);
  }
  function clearInterval(t) {
    clearTimeout(t);
  }
  function setImmediate(fn, ...args) {
    if (typeof fn !== "function") throw new TypeError("Callback must be a function");
    return new Timeout(fn, 0, args, false, true);
  }
  function clearImmediate(t) {
    clearTimeout(t);
  }
  function queueMicrotask(fn) {
    if (typeof fn !== "function") throw new TypeError("queueMicrotask requires a function");
    Promise.resolve().then(() => {
      try {
        fn();
      } catch (err) {
        if (!handleUncaughtException(err)) {
          processObj.exitCode = 1;
          try {
            processObj.stderr.write((err && err.stack ? err.stack : String(err)) + "\n");
          } catch (_) {}
          processObj.exit(1);
        }
      }
    });
  }

  globalThis.setTimeout = setTimeout;
  globalThis.clearTimeout = clearTimeout;
  globalThis.setInterval = setInterval;
  globalThis.clearInterval = clearInterval;
  globalThis.setImmediate = setImmediate;
  globalThis.clearImmediate = clearImmediate;
  globalThis.queueMicrotask = queueMicrotask;

  function makeTimerAbortError(sig) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    if (sig && sig.reason !== undefined) err.cause = sig.reason;
    return err;
  }

  const timersPromises = {
    setTimeout(delay = 0, value, options = {}) {
      return new Promise((resolve, reject) => {
        const sig = options && options.signal;
        if (sig && sig.aborted) {
          return reject(makeTimerAbortError(sig));
        }
        let onAbort = null;
        const t = setTimeout(() => {
          if (onAbort && sig && typeof sig.removeEventListener === "function") {
            sig.removeEventListener("abort", onAbort);
          }
          resolve(value);
        }, delay);
        if (options && options.ref === false) t.unref();
        if (sig && typeof sig.addEventListener === "function") {
          onAbort = () => {
            clearTimeout(t);
            reject(makeTimerAbortError(sig));
          };
          sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
    setImmediate(value, options = {}) {
      return new Promise((resolve, reject) => {
        const sig = options && options.signal;
        if (sig && sig.aborted) {
          return reject(makeTimerAbortError(sig));
        }
        let onAbort = null;
        const t = setImmediate(() => {
          if (onAbort && sig && typeof sig.removeEventListener === "function") {
            sig.removeEventListener("abort", onAbort);
          }
          resolve(value);
        });
        if (options && options.ref === false) t.unref();
        if (sig && typeof sig.addEventListener === "function") {
          onAbort = () => {
            clearImmediate(t);
            reject(makeTimerAbortError(sig));
          };
          sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
    async *setInterval(delay = 0, value, options = {}) {
      const sig = options && options.signal;
      if (sig && sig.aborted) {
        throw makeTimerAbortError(sig);
      }
      while (true) {
        await timersPromises.setTimeout(delay, value, options);
        yield value;
      }
    },
    scheduler: {
      wait(delay = 0, options = {}) {
        return timersPromises.setTimeout(delay, undefined, options);
      },
      yield() {
        return timersPromises.setImmediate();
      },
    },
  };
  globalThis.scheduler = timersPromises.scheduler;

  builtins["timers"] = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    promises: timersPromises,
  };
  builtins["timers/promises"] = timersPromises;

  const perfEntries = [];
  const activePerfObservers = new Set();
  function notifyPerfObservers(entry) {
    for (const obs of activePerfObservers) {
      if (obs._types && obs._types.has(entry.entryType)) {
        obs._records.push(entry);
        if (!obs._scheduled) {
          obs._scheduled = true;
          queueMicrotask(() => {
            obs._scheduled = false;
            if (!obs._connected || obs._records.length === 0) return;
            const list = obs._records.splice(0);
            const listObj = {
              getEntries: () => list.slice(),
              getEntriesByName: (name, type) => list.filter((e) => e.name === name && (!type || e.entryType === type)),
              getEntriesByType: (type) => list.filter((e) => e.entryType === type),
            };
            try {
              obs._cb(listObj, obs);
            } catch (_) {}
          });
        }
      }
    }
  }
  const perfObj = {
    timeOrigin: Date.now() - (Number(BigInt(hostCall("process.hrtime", ""))) / 1e6),
    now() {
      const ns = BigInt(hostCall("process.hrtime", ""));
      return Number(ns) / 1e6;
    },
    mark(name, options = {}) {
      const entry = {
        name: String(name),
        entryType: "mark",
        startTime: options && options.startTime !== undefined ? options.startTime : perfObj.now(),
        duration: 0,
        detail: options ? options.detail : null,
      };
      perfEntries.push(entry);
      notifyPerfObservers(entry);
      return entry;
    },
    measure(name, startMark, endMark) {
      let start = 0;
      let end = perfObj.now();
      let detail = null;
      if (startMark && typeof startMark === "object") {
        const opts = startMark;
        if (opts.detail !== undefined) detail = opts.detail;
        if (typeof opts.start === "number") start = opts.start;
        else if (typeof opts.start === "string") {
          const m = perfEntries.findLast((e) => e.name === opts.start);
          if (m) start = m.startTime;
        }
        if (typeof opts.end === "number") end = opts.end;
        else if (typeof opts.end === "string") {
          const m = perfEntries.findLast((e) => e.name === opts.end);
          if (m) end = m.startTime;
        } else if (typeof opts.duration === "number") {
          end = start + opts.duration;
        }
      } else {
        if (typeof startMark === "string") {
          const m = perfEntries.findLast((e) => e.name === startMark);
          if (m) start = m.startTime;
        }
        if (typeof endMark === "string") {
          const m = perfEntries.findLast((e) => e.name === endMark);
          if (m) end = m.startTime;
        }
      }
      const entry = {
        name: String(name),
        entryType: "measure",
        startTime: start,
        duration: end - start,
        detail,
      };
      perfEntries.push(entry);
      notifyPerfObservers(entry);
      return entry;
    },
    getEntries() { return perfEntries.slice(); },
    getEntriesByName(name, type) {
      return perfEntries.filter((e) => e.name === name && (!type || e.entryType === type));
    },
    getEntriesByType(type) {
      return perfEntries.filter((e) => e.entryType === type);
    },
    clearMarks(name) {
      for (let i = perfEntries.length - 1; i >= 0; i--) {
        if (perfEntries[i].entryType === "mark" && (!name || perfEntries[i].name === name)) {
          perfEntries.splice(i, 1);
        }
      }
    },
    clearMeasures(name) {
      for (let i = perfEntries.length - 1; i >= 0; i--) {
        if (perfEntries[i].entryType === "measure" && (!name || perfEntries[i].name === name)) {
          perfEntries.splice(i, 1);
        }
      }
    },
  };
  globalThis.performance = perfObj;
  class PerformanceObserver {
    constructor(cb) {
      if (typeof cb !== "function") {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"callback\" argument must be of type function", TypeError);
      }
      this._cb = cb;
      this._types = new Set();
      this._records = [];
      this._connected = false;
      this._scheduled = false;
    }
    observe(options = {}) {
      if (!options || typeof options !== "object") {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"options\" argument must be of type object", TypeError);
      }
      if (Array.isArray(options.entryTypes)) {
        this._types = new Set(options.entryTypes.map(String));
      } else if (options.type) {
        this._types.add(String(options.type));
      }
      this._connected = true;
      activePerfObservers.add(this);
      if (options.buffered) {
        for (const e of perfEntries) {
          if (this._types.has(e.entryType)) this._records.push(e);
        }
        if (this._records.length > 0 && !this._scheduled) {
          this._scheduled = true;
          queueMicrotask(() => {
            this._scheduled = false;
            if (!this._connected || this._records.length === 0) return;
            const list = this._records.splice(0);
            const listObj = {
              getEntries: () => list.slice(),
              getEntriesByName: (name, type) => list.filter((e) => e.name === name && (!type || e.entryType === type)),
              getEntriesByType: (type) => list.filter((e) => e.entryType === type),
            };
            try { this._cb(listObj, this); } catch (_) {}
          });
        }
      }
    }
    disconnect() {
      this._connected = false;
      this._records.length = 0;
      activePerfObservers.delete(this);
    }
    takeRecords() {
      return this._records.splice(0);
    }
    static get supportedEntryTypes() {
      return ["mark", "measure", "function", "resource"];
    }
  }
  globalThis.PerformanceObserver = PerformanceObserver;
  builtins["perf_hooks"] = {
    performance: perfObj,
    Performance: perfObj.constructor,
    PerformanceEntry: Object,
    PerformanceMark: Object,
    PerformanceMeasure: Object,
    PerformanceObserver,
    constants: {},
  };

  // =========================================================================
  // 5. Process & Console
  // =========================================================================

  const envBacking = Object.assign(Object.create(null), init.env || {});
  const isWinEnv = init.platform === "win32";
  function resolveEnvKey(target, prop) {
    if (typeof prop !== "string" || !isWinEnv) return prop;
    if (Object.prototype.hasOwnProperty.call(target, prop)) return prop;
    const lower = prop.toLowerCase();
    for (const k of Object.keys(target)) {
      if (k.toLowerCase() === lower) return k;
    }
    return prop;
  }
  const envProxy = new Proxy(envBacking, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      return target[resolveEnvKey(target, prop)];
    },
    set(target, prop, value) {
      if (typeof prop === "string") {
        if (!prop || prop.includes("=") || prop.includes("\0")) return true;
        const k = resolveEnvKey(target, prop);
        let strVal = String(value);
        const nulIdx = strVal.indexOf("\0");
        if (nulIdx !== -1) strVal = strVal.slice(0, nulIdx);
        hostCall("process.setEnv", JSON.stringify({ key: k, value: strVal }));
        target[k] = strVal;
      }
      return true;
    },
    defineProperty(target, prop, desc) {
      if (typeof prop === "string" && desc && "value" in desc) {
        if (!prop || prop.includes("=") || prop.includes("\0")) return true;
        const k = resolveEnvKey(target, prop);
        let strVal = String(desc.value);
        const nulIdx = strVal.indexOf("\0");
        if (nulIdx !== -1) strVal = strVal.slice(0, nulIdx);
        hostCall("process.setEnv", JSON.stringify({ key: k, value: strVal }));
        target[k] = strVal;
      }
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === "string") {
        const k = resolveEnvKey(target, prop);
        hostCall("process.deleteEnv", k);
        delete target[k];
      }
      return true;
    },
    has(target, prop) {
      if (typeof prop !== "string") return prop in target;
      return resolveEnvKey(target, prop) in target;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      const k = typeof prop === "string" ? resolveEnvKey(target, prop) : prop;
      if (k in target) {
        return { value: target[k], writable: true, enumerable: true, configurable: true };
      }
      return undefined;
    },
  });

  function createStdWritable(fd) {
    const ee = new EventEmitter();
    ee.fd = fd;
    ee._isStdio = true;
    ee.writable = true;
    ee.writableEnded = false;
    ee.writableFinished = false;
    ee.destroyed = false;
    ee.isTTY = false;
    ee.columns = 80;
    ee.rows = 24;
    ee.write = function write(chunk, encoding, cb) {
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = "utf8";
      }
      if (typeof chunk === "string" && encoding && encoding !== "utf8" && encoding !== "utf-8") {
        chunk = Buffer.from(chunk, encoding);
      }
      writeFD(fd, chunk);
      if (typeof cb === "function") queueMicrotask(() => cb(null));
      return true;
    };
    ee.end = function end(chunk, encoding, cb) {
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = null;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = "utf8";
      }
      if (chunk !== null && chunk !== undefined) ee.write(chunk, encoding);
      ee.writableEnded = true;
      ee.writableFinished = true;
      queueMicrotask(() => {
        if (typeof cb === "function") cb();
        ee.emit("finish");
        ee.emit("close");
      });
      return ee;
    };
    ee.cork = function () {};
    ee.uncork = function () {};
    ee.destroy = function (err) {
      ee.destroyed = true;
      if (err) ee.emit("error", err);
      ee.emit("close");
      return ee;
    };
    return ee;
  }

  function createStdinReadable() {
    const ee = new EventEmitter();
    ee.fd = 0;
    ee.readable = true;
    ee.isTTY = false;
    ee._encoding = null;
    ee._decoder = null;
    ee._flowing = false;
    ee._ended = false;
    ee._eof = false;
    ee.readableEnded = false;
    ee.destroyed = false;
    ee._asyncStarted = false;
    ee._refed = false;
    ee._bufQueue = [];
    ee._waiters = [];
    ee._finishEnd = function () {
      if (ee._ended) return;
      ee._ended = true;
      ee.readableEnded = true;
      ee.emit("end");
      ee.emit("close");
    };
    ee.setEncoding = function (enc) {
      ee._encoding = enc;
      ee._decoder = enc ? new StringDecoder(enc) : null;
      return ee;
    };
    ee._formatOut = function (buf) {
      if (ee._decoder) return ee._decoder.write(buf);
      if (ee._encoding) return buf.toString(ee._encoding);
      return buf;
    };
    ee._startAsync = function () {
      if (!ee._asyncStarted && !ee._ended && !ee._eof && !ee.destroyed) {
        ee._asyncStarted = true;
        ee._refed = true;
        incRef();
        const res = hostCall("process.stdinStart", "");
        if (typeof res === "string" && res.startsWith("{")) {
          try {
            const meta = JSON.parse(res);
            queueMicrotask(() => {
              if (meta.initial) {
                ee._onAsyncChunk(Buffer.from(meta.initial, "base64"));
              }
              if (meta.eof) {
                ee._onAsyncEnd();
              }
            });
          } catch (_) {}
        }
      }
    };
    ee._onAsyncChunk = function (buf) {
      if (ee.destroyed || ee._ended) return;
      if (ee._waiters.length > 0) {
        const w = ee._waiters.shift();
        try { hostCall("process.stdinPull", ""); } catch (_) {}
        w.resolve(ee._formatOut(buf));
        return;
      }
      if (ee._flowing) {
        const out = ee._formatOut(buf);
        try { hostCall("process.stdinPull", ""); } catch (_) {}
        if (out !== "") ee.emit("data", out);
        return;
      }
      ee._bufQueue.push(buf);
      if (ee.listenerCount("readable") > 0) {
        ee.emit("readable");
      }
    };
    ee._onAsyncEnd = function () {
      if (ee._ended || ee._eof || ee.destroyed) return;
      ee._eof = true;
      if (ee._asyncStarted) {
        ee._asyncStarted = false;
        if (ee._refed) {
          ee._refed = false;
          decRef();
        }
      }
      if (ee._decoder) {
        const rem = ee._decoder.end();
        if (rem) {
          if (ee._waiters.length > 0) {
            ee._waiters.shift().resolve(rem);
          } else if (ee._flowing) {
            ee.emit("data", rem);
          } else {
            ee._bufQueue.push(Buffer.from(rem, "utf8"));
          }
        }
      }
      while (ee._waiters.length > 0) {
        ee._waiters.shift().resolve(null);
      }
      if (ee.listenerCount("readable") > 0 && ee._bufQueue.length > 0) {
        ee.emit("readable");
      }
      if (ee._flowing || ee._bufQueue.length === 0) {
        ee._finishEnd();
      }
    };
    ee.read = function (size = 65536) {
      if (size !== undefined && size !== null) {
        const n = Number(size);
        if (!Number.isFinite(n) || n < 0 || n > 64 * 1024 * 1024) {
          const err = new RangeError(`The value of "size" is out of range. It must be >= 0 and <= 67108864. Received ${size}`);
          err.code = "ERR_OUT_OF_RANGE";
          throw err;
        }
        if (n === 0) return null;
        size = Math.floor(n);
      } else {
        size = 65536;
      }
      if (ee._bufQueue.length > 0) {
        const b = ee._bufQueue[0];
        if (size < b.length) {
          ee._bufQueue[0] = b.subarray(size);
          return ee._formatOut(b.subarray(0, size));
        }
        ee._bufQueue.shift();
        try { hostCall("process.stdinPull", ""); } catch (_) {}
        const out = ee._formatOut(b);
        if (ee._bufQueue.length === 0 && ee._eof && !ee._ended) {
          queueMicrotask(() => {
            if (ee._bufQueue.length === 0 && ee._eof && !ee._ended && !ee.destroyed) {
              ee._finishEnd();
            }
          });
        }
        return out;
      }
      if (ee._eof && !ee._ended && !ee.destroyed) {
        ee._finishEnd();
        return null;
      }
      if (ee._ended || ee.destroyed || ee._asyncStarted) return null;
      const res = hostCall("process.stdinPoll", String(size));
      if (!res) return null;
      if (typeof res === "string") {
        try {
          const meta = JSON.parse(res);
          if (meta && meta.eof) {
            ee._eof = true;
            ee._finishEnd();
          }
        } catch (_) {}
        return null;
      }
      const bin = res.bin;
      if (!bin || bin.byteLength === 0) return null;
      const buf = new Buffer(bin.buffer, bin.byteOffset, bin.byteLength);
      return ee._formatOut(buf);
    };
    ee.resume = function () {
      if (ee.destroyed || ee._ended) return ee;
      if (!ee._flowing) {
        ee._flowing = true;
        if (ee._asyncStarted && !ee._refed && !ee._eof) {
          ee._refed = true;
          incRef();
        }
        while (ee._bufQueue.length > 0 && ee._flowing) {
          const b = ee._bufQueue.shift();
          try { hostCall("process.stdinPull", ""); } catch (_) {}
          const out = ee._formatOut(b);
          if (out !== "") ee.emit("data", out);
        }
        if (ee._bufQueue.length === 0 && ee._eof && !ee._ended) {
          ee._finishEnd();
          return ee;
        }
        processObj.nextTick(() => {
          if (ee._flowing && !ee.destroyed && !ee._ended) ee._startAsync();
        });
      }
      return ee;
    };
    ee.pause = function () {
      ee._flowing = false;
      if (ee._refed && ee._waiters.length === 0) {
        ee._refed = false;
        decRef();
      }
      return ee;
    };
    ee.ref = function () {
      if (ee._asyncStarted && !ee._refed && !ee._ended && !ee.destroyed) {
        ee._refed = true;
        incRef();
      }
      return ee;
    };
    ee.unref = function () {
      if (ee._refed) {
        ee._refed = false;
        decRef();
      }
      return ee;
    };
    ee.on = function (type, listener) {
      EventEmitter.prototype.on.call(ee, type, listener);
      if (type === "data") {
        ee.resume();
      } else if (type === "readable") {
        processObj.nextTick(() => {
          if (!ee.destroyed && !ee._ended && ee.listenerCount("readable") > 0) ee._startAsync();
        });
        if (ee._bufQueue.length > 0 || ee._eof) {
          queueMicrotask(() => {
            if (!ee.destroyed && !ee._ended) ee.emit("readable");
          });
        }
      }
      return ee;
    };
    ee.pipe = function (dest, options) {
      return Stream.prototype.pipe.call(ee, dest, options);
    };
    ee.unpipe = function (dest) {
      return Stream.prototype.unpipe.call(ee, dest);
    };
    ee.destroy = function (err) {
      if (ee.destroyed) return ee;
      ee.destroyed = true;
      ee._ended = true;
      ee._flowing = false;
      ee._bufQueue.length = 0;
      if (ee._refed) {
        ee._refed = false;
        decRef();
      }
      if (ee._asyncStarted) {
        ee._asyncStarted = false;
        try { hostCall("process.stdinStop", ""); } catch (_) {}
      }
      while (ee._waiters.length > 0) {
        const w = ee._waiters.shift();
        if (err) w.reject(err);
        else w.resolve(null);
      }
      if (err) ee.emit("error", err);
      ee.emit("close");
      return ee;
    };
    ee[Symbol.asyncIterator] = async function* () {
      while (true) {
        if (ee._bufQueue.length > 0) {
          const b = ee._bufQueue.shift();
          try { hostCall("process.stdinPull", ""); } catch (_) {}
          const out = ee._formatOut(b);
          if (out !== "") yield out;
          if (ee._bufQueue.length === 0 && ee._eof && !ee._ended) {
            ee._finishEnd();
            break;
          }
          continue;
        }
        if (ee._ended || ee._eof || ee.destroyed) {
          if (ee._eof && !ee._ended && !ee.destroyed) ee._finishEnd();
          break;
        }
        ee._startAsync();
        const chunk = await new Promise((resolve, reject) => {
          ee._waiters.push({ resolve, reject });
        });
        if (chunk === null) break;
        if (chunk !== "") yield chunk;
      }
    };
    return ee;
  }

  const processObj = new EventEmitter();
  let currentCWD = init.cwd;
  let inProcessExit = false;
  let procExitCode = undefined;
  let uncaughtExceptionCaptureCb = null;
  Object.assign(processObj, {
    title: "node",
    debugPort: 9229,
    argv: init.argv || [],
    argv0: (init.argv && init.argv[0]) || init.execPath || "indirect-code",
    execArgv: [],
    execPath: init.execPath || "indirect-code",
    env: envProxy,
    platform: init.platform || "linux",
    arch: init.arch || "x64",
    pid: init.pid || 1,
    ppid: init.ppid || 0,
    version: "v22.0.0",
    versions: {
      node: "22.0.0",
      v8: "12.4.254.21-node.12",
      openssl: "3.0.13+quic",
      uv: "1.48.0",
      zlib: "1.3.0.1-motley",
      ares: "1.28.1",
      nghttp2: "1.61.0",
      napi: "9",
      llhttp: "9.2.1",
      unicode: "15.1",
      quickjs: "0.17.0",
      modules: "127",
    },
    release: { name: "node" },
    features: {
      inspector: false,
      debug: false,
      uv: true,
      ipv6: true,
      tls_alpn: true,
      tls_sni: true,
      tls_ocsp: true,
      tls: true,
      require_module: true,
    },
    allowedNodeEnvironmentFlags: new Set(),
    stdout: createStdWritable(1),
    stderr: createStdWritable(2),
    stdin: createStdinReadable(),
    cwd() {
      return currentCWD;
    },
    chdir(dir) {
      if (typeof dir !== "string") {
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "directory" argument must be of type string. Received ${dir === null ? "null" : typeof dir}`,
          TypeError
        );
      }
      currentCWD = hostCall("process.chdir", dir);
    },
    exit(code) {
      if (code !== undefined && code !== null) {
        processObj.exitCode = code;
      }
      const finalCode = procExitCode !== undefined ? (procExitCode | 0) : 0;
      if (!inProcessExit) {
        inProcessExit = true;
        try {
          processObj.emit("exit", finalCode);
        } catch (err) {
          procExitCode = 1;
          try {
            processObj.stderr.write(((err && err.stack) || String(err)) + "\n");
          } catch (_) {}
        }
      }
      const exitCodeToUse = procExitCode !== undefined ? (procExitCode | 0) : 0;
      if (exitCodeToUse !== 0 && init.env && init.env.__INDIRECT_WORKER_THREAD_ID) {
        try {
          hostCall("worker.send", "0", v8Serialize({ __indirectWorkerCleanExit: true }));
          hostCall("worker.close", "0");
        } catch (_) {}
      }
      hostExit(exitCodeToUse);
    },
    reallyExit(code) {
      const exitCodeToUse = Number(code !== undefined ? code : (procExitCode !== undefined ? procExitCode : 0)) | 0;
      if (exitCodeToUse !== 0 && init.env && init.env.__INDIRECT_WORKER_THREAD_ID) {
        try {
          hostCall("worker.send", "0", v8Serialize({ __indirectWorkerCleanExit: true }));
          hostCall("worker.close", "0");
        } catch (_) {}
      }
      hostExit(exitCodeToUse);
    },
    abort() {
      hostExit(134);
    },
    getBuiltinModule(id) {
      if (typeof id !== "string") return undefined;
      const clean = id.startsWith("node:") ? id.slice(5) : id;
      return builtins[clean];
    },
    setUncaughtExceptionCaptureCallback(fn) {
      if (fn !== null && typeof fn !== "function") {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'fn' argument must be of type function or null", TypeError);
      }
      uncaughtExceptionCaptureCb = fn;
    },
    hasUncaughtExceptionCaptureCallback() {
      return uncaughtExceptionCaptureCb !== null;
    },
    setSourceMapsEnabled() {},
    getActiveResourcesInfo() {
      const list = [];
      for (const t of timersMap.values()) {
        if (!t._cleared && t._refed) list.push(t._isInterval ? "Timeout" : "Timeout");
      }
      for (const _ of activeServers.values()) list.push("TCPSocketWrap");
      for (const _ of activeNetListeners.values()) list.push("TCPServerWrap");
      for (const _ of activeNetSockets.values()) list.push("TCPSocketWrap");
      for (const _ of activeChildren.values()) list.push("ProcessWrap");
      return list;
    },
    loadEnvFile(path = ".env") {
      const content = readFileSync(path, "utf8");
      const parsed = parseEnv(content);
      for (const [k, v] of Object.entries(parsed)) {
        if (processObj.env[k] === undefined) processObj.env[k] = v;
      }
    },
    ref() {},
    unref() {},
    report: {
      compact: false,
      directory: "",
      filename: "",
      getReport() {
        return { header: { nodejsVersion: processObj.version, arch: processObj.arch, platform: processObj.platform } };
      },
      reportOnFatalError: false,
      reportOnSignal: false,
      reportOnUncaughtException: false,
      signal: "SIGUSR2",
      writeReport() { return ""; },
    },
    nextTick(fn, ...args) {
      if (typeof fn !== "function") throw new TypeError("Callback must be a function");
      nextTickQueue.push(() => fn(...args));
    },
    hrtime: Object.assign(
      function hrtime(prev) {
        const ns = BigInt(hostCall("process.hrtime", ""));
        let diff = ns;
        if (Array.isArray(prev) && prev.length === 2) {
          const prevNs = BigInt(prev[0]) * 1000000000n + BigInt(prev[1]);
          diff = ns - prevNs;
        }
        return [Number(diff / 1000000000n), Number(diff % 1000000000n)];
      },
      {
        bigint() {
          return BigInt(hostCall("process.hrtime", ""));
        },
      }
    ),
    uptime() {
      return perfObj.now() / 1000;
    },
    memoryUsage() {
      return JSON.parse(hostCall("process.memoryUsage", ""));
    },
    cpuUsage(prev) {
      const u = Math.floor(perfObj.now() * 1000);
      if (prev) return { user: Math.max(0, u - (prev.user || 0)), system: 0 };
      return { user: u, system: 0 };
    },
    resourceUsage() {
      const cpu = processObj.cpuUsage();
      const mem = processObj.memoryUsage();
      return {
        userCPUTime: cpu.user,
        systemCPUTime: cpu.system,
        maxRSS: Math.floor((mem.rss || 0) / 1024),
        sharedMemorySize: 0,
        unsharedDataSize: 0,
        unsharedStackSize: 0,
        minorPageFault: 0,
        majorPageFault: 0,
        swappedOut: 0,
        fsRead: 0,
        fsWrite: 0,
        ipcSent: 0,
        ipcReceived: 0,
        signalsCount: 0,
        voluntaryContextSwitches: 0,
        involuntaryContextSwitches: 0,
      };
    },
    kill(pid, signal = "SIGTERM") {
      if (typeof pid !== "number" || !Number.isInteger(pid)) {
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "pid" argument must be of type number. Received ${pid === null ? "null" : typeof pid}`,
          TypeError
        );
      }
      if ((pid === processObj.pid || pid === 0) && signal !== 0 && signal !== "0") {
        const sigName = typeof signal === "string" ? signal.toUpperCase() : "SIGTERM";
        if (processObj.listenerCount(sigName) > 0) {
          queueMicrotask(() => processObj.emit(sigName, sigName));
          return true;
        }
      }
      hostCall("process.kill", JSON.stringify({ pid, signal: typeof signal === "number" ? signal : String(signal) }));
      return true;
    },
    umask(mask) {
      if (processObj._umaskVal === undefined) processObj._umaskVal = 0o022;
      const old = processObj._umaskVal;
      if (mask !== undefined) {
        if (typeof mask === "string") {
          if (!/^[0-7]+$/.test(mask)) {
            throw makeNodeError("ERR_INVALID_ARG_VALUE", `The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received '${mask}'`, TypeError);
          }
          processObj._umaskVal = parseInt(mask, 8) & 0o777;
        } else if (typeof mask === "number" && Number.isInteger(mask) && mask >= 0 && mask <= 0xffffffff) {
          processObj._umaskVal = mask & 0o777;
        } else {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "mask" argument must be of type number or an octal string. Received ${mask === null ? "null" : typeof mask}`, TypeError);
        }
      }
      return old;
    },
    emitWarning(warning, type, code) {
      const msg = warning instanceof Error ? warning.message : String(warning);
      processObj.stderr.write(`Warning${type ? ` [${type}]` : ""}${code ? ` (${code})` : ""}: ${msg}\n`);
    },
  });
  Object.defineProperty(processObj, "exitCode", {
    configurable: true,
    enumerable: true,
    get() {
      return procExitCode;
    },
    set(val) {
      if (val === undefined || val === null) {
        procExitCode = undefined;
        return;
      }
      if (typeof val === "string") {
        if (/^\s*[+-]?\d+\s*$/.test(val)) {
          val = Number(val);
        } else {
          throw makeNodeError(
            "ERR_INVALID_ARG_TYPE",
            `The "code" argument must be of type number. Received type string ('${val}')`,
            TypeError
          );
        }
      } else if (typeof val !== "number") {
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "code" argument must be of type number. Received ${typeof val === "object" ? "an instance of Object" : typeof val}`,
          TypeError
        );
      }
      if (!Number.isInteger(val)) {
        throw makeNodeError(
          "ERR_OUT_OF_RANGE",
          `The value of "code" is out of range. It must be an integer. Received ${val}`,
          RangeError
        );
      }
      procExitCode = val;
    },
  });

  globalThis.process = processObj;
  builtins["process"] = processObj;
  globalThis.navigator = {
    userAgent: `Node.js/${processObj.versions.node.split(".")[0]}`,
    hardwareConcurrency: 4,
    language: "en-US",
    languages: ["en-US", "en"],
    platform: processObj.platform,
  };

  // =========================================================================
  // 6. Util, Console, StructuredClone
  // =========================================================================

  const kCustomInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  const kCustomPromisifySymbol = Symbol.for("nodejs.util.promisify.custom");

  function formatInspectString(str) {
    const json = JSON.stringify(str).slice(1, -1).replace(/\\"/g, "\"");
    if (!str.includes("'")) return `'${json}'`;
    if (!str.includes("\"")) return `"${json.replace(/"/g, "\\\"")}"`;
    if (!str.includes("`") && !str.includes("${")) return `\`${json}\``;
    return `'${json.replace(/'/g, "\\'")}'`;
  }

  function inspectValue(val, depth = 2, seen = new Map(), refState = { nextId: 1 }, showHidden = false, optsObj = null) {
    if (depth === null) depth = Infinity;
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    const t = typeof val;
    if (t === "string") {
      if (optsObj && optsObj.maxStringLength !== undefined && optsObj.maxStringLength !== null && val.length > optsObj.maxStringLength) {
        const maxLen = Math.max(0, optsObj.maxStringLength);
        const rem = val.length - maxLen;
        return `${formatInspectString(val.slice(0, maxLen))}... ${rem} more character${rem === 1 ? "" : "s"}`;
      }
      return formatInspectString(val);
    }
    if (t === "number") return Object.is(val, -0) ? "-0" : String(val);
    if (t === "boolean") return String(val);
    if (t === "bigint") return `${val}n`;
    if (t === "symbol") return val.toString();
    if (t === "function") return `[Function: ${val.name || "(anonymous)"}]`;
    if (t !== "object") return String(val);

    if ((!optsObj || optsObj.customInspect !== false) && typeof val[kCustomInspectSymbol] === "function") {
      try {
        return String(val[kCustomInspectSymbol](depth, Object.assign({ showHidden, depth }, optsObj || {}), inspectValue));
      } catch (_) {}
    }
    if (val instanceof Error) {
      return val.stack || `${val.name || "Error"}: ${val.message || ""}`;
    }
    if (val instanceof Date) {
      return Number.isNaN(val.getTime()) ? "Invalid Date" : val.toISOString();
    }
    if (val instanceof RegExp) {
      return val.toString();
    }
    if (val instanceof Buffer) {
      const max = Math.min(val.length, 50);
      const hex = [];
      for (let i = 0; i < max; i++) hex.push((val[i] < 16 ? "0" : "") + val[i].toString(16));
      return `<Buffer ${hex.join(" ")}${val.length > 50 ? ` ... ${val.length - 50} more bytes` : ""}>`;
    }
    if (ArrayBuffer.isView(val)) {
      const name = val.constructor ? val.constructor.name : "TypedArray";
      const arr = Array.from(val.subarray ? val.subarray(0, 50) : []);
      return `${name}(${val.length}) [ ${arr.join(", ")}${val.length > 50 ? ", ..." : ""} ]`;
    }
    if (seen.has(val)) {
      let id = seen.get(val);
      if (!id) {
        id = refState.nextId++;
        seen.set(val, id);
      }
      return `[Circular *${id}]`;
    }
    if (depth < 0) return Array.isArray(val) ? "[Array]" : "[Object]";

    seen.set(val, 0);
    try {
      let body;
      const valTag = Object.prototype.toString.call(val);
      const isCompact = !optsObj || optsObj.compact !== false;
      if (val instanceof Map || valTag === "[object Map]") {
        if (val.size === 0) {
          body = "Map(0) {}";
        } else {
          const entries = [];
          for (const [k, v] of val.entries()) {
            entries.push(`${inspectValue(k, depth - 1, seen, refState, showHidden, optsObj)} => ${inspectValue(v, depth - 1, seen, refState, showHidden, optsObj)}`);
          }
          body = `Map(${val.size}) { ${entries.join(", ")} }`;
        }
      } else if (val instanceof Set || valTag === "[object Set]") {
        if (val.size === 0) {
          body = "Set(0) {}";
        } else {
          const items = [];
          for (const v of val.values()) items.push(inspectValue(v, depth - 1, seen, refState, showHidden, optsObj));
          body = `Set(${val.size}) { ${items.join(", ")} }`;
        }
      } else if (Array.isArray(val)) {
        if (val.length === 0 && !showHidden) {
          body = "[]";
        } else {
          const maxArr = optsObj && optsObj.maxArrayLength !== undefined ? (optsObj.maxArrayLength === null ? Infinity : Math.max(0, optsObj.maxArrayLength)) : 100;
          const sliceLen = Math.min(val.length, maxArr);
          const items = val.slice(0, sliceLen).map((item) => inspectValue(item, depth - 1, seen, refState, showHidden, optsObj));
          if (val.length > sliceLen) {
            const rem = val.length - sliceLen;
            items.push(`... ${rem} more item${rem === 1 ? "" : "s"}`);
          }
          if (showHidden) {
            items.push(`[length]: ${val.length}`);
          }
          body = isCompact ? `[ ${items.join(", ")} ]` : `[\n  ${items.join(",\n  ")}\n]`;
        }
      } else {
        const keys = showHidden ? Object.getOwnPropertyNames(val) : Object.keys(val);
        if (optsObj && optsObj.sorted) {
          if (typeof optsObj.sorted === "function") keys.sort(optsObj.sorted);
          else keys.sort();
        }
        const tag = val.constructor && val.constructor !== Object && val.constructor.name ? `${val.constructor.name} ` : "";
        if (keys.length === 0) {
          body = `${tag}{}`;
        } else {
          const pairs = keys.map((k) => {
            const desc = Object.getOwnPropertyDescriptor(val, k);
            const isHidden = showHidden && desc && !desc.enumerable;
            const rawKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : formatInspectString(k);
            const keyStr = isHidden ? `[${rawKey}]` : rawKey;
            if (desc && (desc.get || desc.set)) {
              const gLabel = desc.get && desc.set ? "[Getter/Setter]" : desc.get ? "[Getter]" : "[Setter]";
              return `${keyStr}: ${gLabel}`;
            }
            return `${keyStr}: ${inspectValue(val[k], depth - 1, seen, refState, showHidden, optsObj)}`;
          });
          body = isCompact ? `${tag}{ ${pairs.join(", ")} }` : `${tag}{\n  ${pairs.join(",\n  ")}\n}`;
        }
      }
      const refId = seen.get(val);
      return refId > 0 ? `<ref *${refId}> ${body}` : body;
    } finally {
      seen.delete(val);
    }
  }

  function formatArgsWithOptions(inspectOpts, ...args) {
    if (args.length === 0) return "";
    const hasOpts = inspectOpts && typeof inspectOpts === "object";
    const optDepth = hasOpts && inspectOpts.depth !== undefined ? (inspectOpts.depth === null ? Infinity : inspectOpts.depth) : 3;
    const optHidden = hasOpts && inspectOpts.showHidden !== undefined ? Boolean(inspectOpts.showHidden) : false;
    const first = args[0];
    if (typeof first !== "string") {
      return args.map((a) => (typeof a === "string" ? a : inspectValue(a, optDepth, new Map(), { nextId: 1 }, optHidden, hasOpts ? inspectOpts : null))).join(" ");
    }
    let idx = 1;
    let out = "";
    for (let i = 0; i < first.length; i++) {
      if (first[i] === "%" && i + 1 < first.length) {
        const next = first[i + 1];
        if (next === "%") {
          out += "%";
          i++;
          continue;
        }
        if (idx < args.length) {
          switch (next) {
            case "s": {
              const arg = args[idx++];
              if (typeof arg === "bigint") {
                out += `${arg}n`;
              } else if (typeof arg === "object" && arg !== null && typeof arg[Symbol.toPrimitive] !== "function" && (typeof arg.toString !== "function" || arg.toString === Object.prototype.toString)) {
                out += inspectValue(arg, 0, new Map(), { nextId: 1 }, optHidden, hasOpts ? inspectOpts : null);
              } else {
                out += String(arg);
              }
              i++;
              continue;
            }
            case "d": {
              const arg = args[idx++];
              out += typeof arg === "bigint" ? `${arg}n` : typeof arg === "symbol" ? "NaN" : Number(arg);
              i++;
              continue;
            }
            case "i": {
              const arg = args[idx++];
              out += typeof arg === "bigint" ? `${arg}n` : typeof arg === "symbol" ? "NaN" : parseInt(arg, 10);
              i++;
              continue;
            }
            case "f": {
              const arg = args[idx++];
              out += typeof arg === "symbol" ? "NaN" : parseFloat(arg);
              i++;
              continue;
            }
            case "j":
              try {
                out += JSON.stringify(args[idx++]);
              } catch (_) {
                out += "[Circular]";
              }
              i++;
              continue;
            case "o": {
              const d = hasOpts && inspectOpts.depth !== undefined ? (inspectOpts.depth === null ? Infinity : inspectOpts.depth) : 4;
              out += inspectValue(args[idx++], d, new Map(), { nextId: 1 }, true, hasOpts ? inspectOpts : null);
              i++;
              continue;
            }
            case "O": {
              const d = hasOpts && inspectOpts.depth !== undefined ? (inspectOpts.depth === null ? Infinity : inspectOpts.depth) : 4;
              out += inspectValue(args[idx++], d, new Map(), { nextId: 1 }, optHidden, hasOpts ? inspectOpts : null);
              i++;
              continue;
            }
            case "c":
              idx++;
              i++;
              continue;
          }
        }
      }
      out += first[i];
    }
    while (idx < args.length) {
      const a = args[idx++];
      out += " " + (typeof a === "string" ? a : inspectValue(a, optDepth, new Map(), { nextId: 1 }, optHidden, hasOpts ? inspectOpts : null));
    }
    return out;
  }

  function formatArgs(...args) {
    return formatArgsWithOptions(null, ...args);
  }

  const consoleTimers = new Map();
  const consoleCounts = new Map();
  class Console {
    constructor(stdout = processObj.stdout, stderr = processObj.stderr) {
      this._stdout = stdout;
      this._stderr = stderr;
      for (const m of [
        "log", "info", "debug", "warn", "error", "dir", "assert", "trace",
        "time", "timeLog", "timeEnd", "count", "countReset", "clear",
        "group", "groupCollapsed", "groupEnd", "table",
      ]) {
        if (typeof this[m] === "function") {
          this[m] = this[m].bind(this);
        }
      }
    }
    log(...args) { this._stdout.write(formatArgs(...args) + "\n"); }
    info(...args) { this._stdout.write(formatArgs(...args) + "\n"); }
    debug(...args) { this._stdout.write(formatArgs(...args) + "\n"); }
    warn(...args) { this._stderr.write(formatArgs(...args) + "\n"); }
    error(...args) { this._stderr.write(formatArgs(...args) + "\n"); }
    dir(obj, options = {}) {
      const depth = options && options.depth !== undefined ? options.depth : 2;
      this._stdout.write(inspectValue(obj, depth) + "\n");
    }
    assert(condition, ...args) {
      if (!condition) {
        const msg = args.length > 0 ? formatArgs(...args) : "Assertion failed";
        this._stderr.write(`Assertion failed: ${msg}\n`);
      }
    }
    trace(...args) {
      const err = new Error(formatArgs(...args));
      err.name = "Trace";
      this._stderr.write((err.stack || err.message) + "\n");
    }
    time(label = "default") { consoleTimers.set(String(label), perfObj.now()); }
    timeLog(label = "default", ...args) {
      const start = consoleTimers.get(String(label));
      if (start !== undefined) {
        const ms = (perfObj.now() - start).toFixed(3);
        this._stdout.write(`${label}: ${ms}ms${args.length ? " " + formatArgs(...args) : ""}\n`);
      }
    }
    timeEnd(label = "default") {
      const start = consoleTimers.get(String(label));
      if (start !== undefined) {
        const ms = (perfObj.now() - start).toFixed(3);
        consoleTimers.delete(String(label));
        this._stdout.write(`${label}: ${ms}ms\n`);
      }
    }
    count(label = "default") {
      const k = String(label);
      const n = (consoleCounts.get(k) || 0) + 1;
      consoleCounts.set(k, n);
      this._stdout.write(`${k}: ${n}\n`);
    }
    countReset(label = "default") { consoleCounts.delete(String(label)); }
    clear() {}
    group(...args) { if (args.length) this.log(...args); }
    groupCollapsed(...args) { if (args.length) this.log(...args); }
    groupEnd() {}
    table(data) { this.log(data); }
  }

  const consoleObj = new Console(processObj.stdout, processObj.stderr);
  consoleObj.Console = Console;
  globalThis.console = consoleObj;
  builtins["console"] = consoleObj;

  const untransferableObjects = new WeakSet();
  const uncloneableObjects = new WeakSet();
  const detachedBuffers = new WeakSet();

  function detachArrayBuffer(ab) {
    detachedBuffers.add(ab);
    if (typeof ab.transfer === "function") {
      try {
        return ab.transfer();
      } catch (_) {}
    }
    const copy = ab.slice(0);
    try {
      Object.defineProperty(ab, "byteLength", { value: 0, configurable: true });
      Object.defineProperty(ab, "detached", { value: true, configurable: true });
    } catch (_) {}
    return copy;
  }

  if (typeof globalThis.structuredClone !== "function") {
    globalThis.structuredClone = function structuredClone(val, options) {
      const transferSet = new Set();
      if (options !== undefined && options !== null) {
        if (typeof options !== "object") {
          throw new TypeError("The 'options' argument must be an object");
        }
        if (options.transfer !== undefined && options.transfer !== null) {
          if (typeof options.transfer[Symbol.iterator] !== "function") {
            throw new TypeError("The 'options.transfer' property must be iterable");
          }
          for (const item of options.transfer) {
            if (!item || typeof item !== "object" || untransferableObjects.has(item)) {
              throw new DOMException("Object could not be transferred.", "DataCloneError");
            }
            const isAB = item instanceof ArrayBuffer;
            const isMP = typeof MessagePort !== "undefined" && item instanceof MessagePort;
            if (!isAB && !isMP) {
              throw new DOMException("Object could not be transferred.", "DataCloneError");
            }
            if (isAB && (item.detached || detachedBuffers.has(item))) {
              throw new DOMException("ArrayBuffer is already detached.", "DataCloneError");
            }
            if (transferSet.has(item)) {
              throw new DOMException("Duplicate object in transfer list.", "DataCloneError");
            }
            transferSet.add(item);
          }
        }
      }
      const seen = new Map();
      const transferredDone = new Set();
      function clone(v) {
        if (typeof v === "function" || typeof v === "symbol") {
          throw new DOMException(`${typeof v} could not be cloned.`, "DataCloneError");
        }
        if (v === null || typeof v !== "object") return v;
        if (
          uncloneableObjects.has(v) ||
          v instanceof WeakMap ||
          v instanceof WeakSet ||
          v instanceof Promise ||
          (typeof WeakRef !== "undefined" && v instanceof WeakRef) ||
          (typeof FinalizationRegistry !== "undefined" && v instanceof FinalizationRegistry)
        ) {
          throw new DOMException("Object could not be cloned.", "DataCloneError");
        }
        if (seen.has(v)) return seen.get(v);
        if (v instanceof Date) return new Date(v.getTime());
        if (v instanceof RegExp) return new RegExp(v.source, v.flags);
        if (v instanceof Error) {
          const ctors = { Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError };
          const Ctor = ctors[v.name] || Error;
          const e = new Ctor(v.message);
          seen.set(v, e);
          e.name = v.name;
          if ("stack" in v) e.stack = v.stack;
          if ("cause" in v) e.cause = clone(v.cause);
          if ("code" in v) e.code = clone(v.code);
          for (const k of Object.keys(v)) e[k] = clone(v[k]);
          return e;
        }
        if (v instanceof ArrayBuffer) {
          if (v.detached || detachedBuffers.has(v)) {
            throw new DOMException("Cannot clone a detached ArrayBuffer.", "DataCloneError");
          }
          const out = transferSet.has(v) ? detachArrayBuffer(v) : v.slice(0);
          if (transferSet.has(v)) transferredDone.add(v);
          seen.set(v, out);
          return out;
        }
        if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) {
          const out = new SharedArrayBuffer(v.byteLength);
          new Uint8Array(out).set(new Uint8Array(v));
          seen.set(v, out);
          return out;
        }
        if (ArrayBuffer.isView(v)) {
          const origOff = v.byteOffset;
          const origByteLen = v.byteLength;
          const origLen = v.length;
          const clonedBuf = clone(v.buffer);
          const ViewCtor = v instanceof Buffer ? Uint8Array : v.constructor;
          const out = v instanceof DataView
            ? new DataView(clonedBuf, origOff, origByteLen)
            : new ViewCtor(clonedBuf, origOff, origLen);
          seen.set(v, out);
          return out;
        }
        if (typeof MessagePort !== "undefined" && v instanceof MessagePort) {
          if (!transferSet.has(v)) {
            throw new DOMException("MessagePort cannot be cloned without being in the transfer list.", "DataCloneError");
          }
          transferredDone.add(v);
          seen.set(v, v);
          return v;
        }
        if (v instanceof Map) {
          const m = new Map();
          seen.set(v, m);
          for (const [k, mv] of v.entries()) m.set(clone(k), clone(mv));
          return m;
        }
        if (v instanceof Set) {
          const s = new Set();
          seen.set(v, s);
          for (const sv of v.values()) s.add(clone(sv));
          return s;
        }
        if (Array.isArray(v)) {
          const a = new Array(v.length);
          seen.set(v, a);
          for (let i = 0; i < v.length; i++) a[i] = clone(v[i]);
          return a;
        }
        const o = {};
        seen.set(v, o);
        for (const k of Object.keys(v)) o[k] = clone(v[k]);
        return o;
      }
      const res = clone(val);
      for (const item of transferSet) {
        if (!transferredDone.has(item) && item instanceof ArrayBuffer) {
          detachArrayBuffer(item);
        }
      }
      return res;
    };
  }

  const objToString = Object.prototype.toString;

  function isDeepEqualInternal(a, b, strict, seen = new Map()) {
    if (strict ? Object.is(a, b) : (a == b || (Number.isNaN(a) && Number.isNaN(b)))) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    const tagA = objToString.call(a);
    const tagB = objToString.call(b);
    if (tagA !== tagB) return false;
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
      const ca = a.constructor && a.constructor.name;
      const cb = b.constructor && b.constructor.name;
      if (!ca || ca !== cb) return false;
    }
    if (tagA === "[object Date]" || (a instanceof Date && b instanceof Date)) {
      if (a.getTime() !== b.getTime()) return false;
    }
    if (tagA === "[object RegExp]" || (a instanceof RegExp && b instanceof RegExp)) {
      if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false;
    }
    if (tagA === "[object Error]" || (a instanceof Error && b instanceof Error)) {
      if (a.name !== b.name || a.message !== b.message) return false;
    }
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
      if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
      const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    }
    if (tagA === "[object ArrayBuffer]" || (a instanceof ArrayBuffer && b instanceof ArrayBuffer)) {
      if (a.byteLength !== b.byteLength) return false;
      const ua = new Uint8Array(a);
      const ub = new Uint8Array(b);
      for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    }
    if (seen.get(a) === b) return true;
    seen.set(a, b);
    if (tagA === "[object Map]" || (a instanceof Map && b instanceof Map)) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a.entries()) {
        if (b.has(k)) {
          if (!isDeepEqualInternal(v, b.get(k), strict, seen)) return false;
        } else {
          let matched = false;
          for (const [bk, bv] of b.entries()) {
            if (isDeepEqualInternal(k, bk, strict, seen) && isDeepEqualInternal(v, bv, strict, seen)) {
              matched = true;
              break;
            }
          }
          if (!matched) return false;
        }
      }
    }
    if (tagA === "[object Set]" || (a instanceof Set && b instanceof Set)) {
      if (a.size !== b.size) return false;
      for (const v of a.values()) {
        if (b.has(v)) continue;
        let matched = false;
        for (const bv of b.values()) {
          if (isDeepEqualInternal(v, bv, strict, seen)) {
            matched = true;
            break;
          }
        }
        if (!matched) return false;
      }
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (strict && (i in a) !== (i in b)) return false;
        if (!isDeepEqualInternal(a[i], b[i], strict, seen)) return false;
      }
    }
    const getOwnKeys = (obj) => {
      const strKeys = Object.keys(obj);
      if (!strict) return strKeys;
      const symKeys = Object.getOwnPropertySymbols(obj).filter(
        (s) => s !== vmPinSym && Object.prototype.propertyIsEnumerable.call(obj, s)
      );
      return symKeys.length > 0 ? strKeys.concat(symKeys) : strKeys;
    };
    const ka = getOwnKeys(a);
    const kb = getOwnKeys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!isDeepEqualInternal(a[k], b[k], strict, seen)) return false;
    }
    return true;
  }

  function isDeepStrictEqual(a, b) {
    return isDeepEqualInternal(a, b, true);
  }

  function promisify(original) {
    if (typeof original !== "function") throw new TypeError("The 'original' argument must be of type Function");
    if (original[kCustomPromisifySymbol]) {
      const fn = original[kCustomPromisifySymbol];
      if (typeof fn !== "function") throw new TypeError("The [util.promisify.custom] property must be of type Function");
      return Object.defineProperty(fn, kCustomPromisifySymbol, { value: fn, enumerable: false, writable: false, configurable: true });
    }
    function fn(...args) {
      return new Promise((resolve, reject) => {
        original.call(this, ...args, (err, ...values) => {
          if (err) return reject(err);
          resolve(values.length <= 1 ? values[0] : values);
        });
      });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisifySymbol, { value: fn, enumerable: false, writable: false, configurable: true });
    return fn;
  }
  promisify.custom = kCustomPromisifySymbol;

  function callbackify(original) {
    if (typeof original !== "function") throw new TypeError("The 'original' argument must be of type Function");
    return function (...args) {
      const cb = args.pop();
      if (typeof cb !== "function") throw new TypeError("The last argument must be of type Function");
      Promise.resolve()
        .then(() => original.apply(this, args))
        .then(
          (ret) => queueMicrotask(() => cb(null, ret)),
          (err) => queueMicrotask(() => cb(err || new Error("Rejected with falsy value")))
        );
    };
  }

  function inherits(ctor, superCtor) {
    if (ctor === undefined || ctor === null) throw new TypeError("The constructor to 'inherits' must not be null or undefined");
    if (superCtor === undefined || superCtor === null) throw new TypeError("The super constructor to 'inherits' must not be null or undefined");
    if (superCtor.prototype === undefined) throw new TypeError("The super constructor to 'inherits' must have a prototype");
    Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }

  function parseArgs(config = {}) {
    const args = config.args || processObj.argv.slice(2);
    const options = config.options || {};
    const strict = config.strict !== undefined ? Boolean(config.strict) : true;
    const allowPositionals = config.allowPositionals !== undefined ? Boolean(config.allowPositionals) : !strict;
    const values = Object.create(null);
    const positionals = [];
    const shortMap = Object.create(null);
    for (const [name, def] of Object.entries(options)) {
      if (def.default !== undefined) values[name] = def.default;
      if (def.short) shortMap[def.short] = name;
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        positionals.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        const rawName = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
        const def = options[rawName] || {};
        if (def.type === "string") {
          const v = eq >= 0 ? arg.slice(eq + 1) : args[++i];
          if (def.multiple) {
            if (!values[rawName]) values[rawName] = [];
            values[rawName].push(v);
          } else {
            values[rawName] = v;
          }
        } else {
          const v = eq >= 0 ? arg.slice(eq + 1) !== "false" : true;
          if (def.multiple) {
            if (!values[rawName]) values[rawName] = [];
            values[rawName].push(v);
          } else {
            values[rawName] = v;
          }
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        const shortChar = arg[1];
        const mapped = shortMap[shortChar] || shortChar;
        const def = options[mapped] || {};
        if (def.type === "string") {
          const v = arg.length > 2 ? arg.slice(2) : args[++i];
          values[mapped] = v;
        } else {
          values[mapped] = true;
        }
      } else {
        positionals.push(arg);
      }
    }
    if (!allowPositionals && positionals.length > 0) {
      throw makeNodeError(
        "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
        `Unexpected argument '${positionals[0]}'. This command does not take positional arguments`,
        TypeError
      );
    }
    return { values, positionals };
  }

  const utilTypes = {
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
    isPromise: (v) => v instanceof Promise,
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isWeakMap: (v) => v instanceof WeakMap,
    isWeakSet: (v) => v instanceof WeakSet,
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isUint8Array: (v) => v instanceof Uint8Array,
    isDataView: (v) => v instanceof DataView,
    isNativeError: (v) => v instanceof Error,
    isBigIntObject: (v) => typeof v === "object" && v !== null && objToString.call(v) === "[object BigInt]",
    isBoxedPrimitive: (v) =>
      v instanceof Number ||
      v instanceof String ||
      v instanceof Boolean ||
      (typeof v === "object" && v !== null && (objToString.call(v) === "[object BigInt]" || objToString.call(v) === "[object Symbol]")),
    isAsyncFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction",
    isGeneratorFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "GeneratorFunction",
    isProxy: (v) => Boolean(rawIsProxy && rawIsProxy(v)),
  };

  const inspectDefaultOptions = {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3,
    sorted: false,
    getters: false,
    numericSeparator: false,
  };

  const inspectFn = Object.assign(
    function inspect(obj, opts, depthArg) {
      let showHidden = inspectDefaultOptions.showHidden;
      let depth = inspectDefaultOptions.depth;
      const mergedOpts = Object.assign({}, inspectDefaultOptions);
      if (typeof opts === "boolean") {
        showHidden = opts;
        mergedOpts.showHidden = showHidden;
        if (depthArg !== undefined) depth = depthArg === null ? Infinity : depthArg;
      } else if (typeof opts === "number") {
        depth = opts;
      } else if (opts && typeof opts === "object") {
        Object.assign(mergedOpts, opts);
        if (opts.showHidden !== undefined) showHidden = Boolean(opts.showHidden);
        if (opts.depth !== undefined) depth = opts.depth === null ? Infinity : opts.depth;
      }
      if (depth === null) depth = Infinity;
      mergedOpts.depth = depth;
      mergedOpts.showHidden = showHidden;
      return inspectValue(obj, depth, new Map(), { nextId: 1 }, showHidden, mergedOpts);
    },
    {
      custom: kCustomInspectSymbol,
      defaultOptions: inspectDefaultOptions,
    }
  );

  const STYLE_TEXT_CODES = {
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    gray: [90, 39],
    grey: [90, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
  };

  function styleText(format, text) {
    const fmts = Array.isArray(format) ? format : [format];
    let out = String(text);
    for (let i = fmts.length - 1; i >= 0; i--) {
      const code = STYLE_TEXT_CODES[fmts[i]];
      if (!code) {
        throw makeNodeError("ERR_INVALID_ARG_VALUE", `Unknown style format: ${fmts[i]}`, TypeError);
      }
      out = `\u001b[${code[0]}m${out}\u001b[${code[1]}m`;
    }
    return out;
  }

  function parseEnv(content) {
    const out = Object.create(null);
    const lines = String(content).split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const hashIdx = val.indexOf(" #");
        if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
      }
      out[key] = val;
    }
    return out;
  }

  function getCallSites() {
    const raw = (new Error().stack || "").split(/\r?\n/).slice(1);
    const sites = [];
    for (const line of raw) {
      const m = /^\s*at\s+(?:([^\s(]+)\s+\()?([^):]+):(\d+)(?::(\d+))?\)?/.exec(line);
      if (m) {
        sites.push({
          functionName: m[1] || "",
          scriptName: m[2] || "",
          lineNumber: Number(m[3]) || 1,
          columnNumber: Number(m[4]) || 1,
        });
      }
    }
    return sites;
  }

  class MIMEParams {
    constructor() {
      this._map = new Map();
    }
    delete(name) { this._map.delete(String(name).toLowerCase()); }
    get(name) { const v = this._map.get(String(name).toLowerCase()); return v === undefined ? null : v; }
    has(name) { return this._map.has(String(name).toLowerCase()); }
    set(name, value) { this._map.set(String(name).toLowerCase(), String(value)); }
    *entries() { yield* this._map.entries(); }
    *keys() { yield* this._map.keys(); }
    *values() { yield* this._map.values(); }
    [Symbol.iterator]() { return this._map.entries(); }
    toString() {
      const parts = [];
      for (const [k, v] of this._map.entries()) parts.push(`${k}=${v}`);
      return parts.join("; ");
    }
  }

  class MIMEType {
    constructor(input) {
      const parts = String(input).split(";");
      const main = (parts[0] || "").trim().toLowerCase();
      const slash = main.indexOf("/");
      if (slash <= 0 || slash === main.length - 1) {
        throw makeNodeError("ERR_INVALID_MIME_SYNTAX", `Invalid MIME syntax: ${input}`, TypeError);
      }
      this.type = main.slice(0, slash);
      this.subtype = main.slice(slash + 1);
      this.params = new MIMEParams();
      for (let i = 1; i < parts.length; i++) {
        const seg = parts[i].trim();
        const eq = seg.indexOf("=");
        if (eq > 0) {
          this.params.set(seg.slice(0, eq).trim(), seg.slice(eq + 1).trim().replace(/^"|"$/g, ""));
        }
      }
    }
    get essence() { return `${this.type}/${this.subtype}`; }
    toString() {
      const p = this.params.toString();
      return p ? `${this.essence};${p.replace(/; /g, ";")}` : this.essence;
    }
  }

  const SYSTEM_ERROR_NAMES = {
    [-1]: ["EPERM", "operation not permitted"],
    [-2]: ["ENOENT", "no such file or directory"],
    [-3]: ["ESRCH", "no such process"],
    [-4]: ["EINTR", "interrupted system call"],
    [-5]: ["EIO", "i/o error"],
    [-9]: ["EBADF", "bad file descriptor"],
    [-11]: ["EAGAIN", "resource temporarily unavailable"],
    [-12]: ["ENOMEM", "not enough memory"],
    [-13]: ["EACCES", "permission denied"],
    [-17]: ["EEXIST", "file already exists"],
    [-18]: ["EXDEV", "cross-device link not permitted"],
    [-20]: ["ENOTDIR", "not a directory"],
    [-21]: ["EISDIR", "illegal operation on a directory"],
    [-22]: ["EINVAL", "invalid argument"],
    [-28]: ["ENOSPC", "no space left on device"],
    [-32]: ["EPIPE", "broken pipe"],
    [-39]: ["ENOTEMPTY", "directory not empty"],
    [-98]: ["EADDRINUSE", "address already in use"],
    [-104]: ["ECONNRESET", "connection reset by peer"],
    [-110]: ["ETIMEDOUT", "connection timed out"],
    [-111]: ["ECONNREFUSED", "connection refused"],
    [-3008]: ["ENOTFOUND", "domain name not found"],
    [-4058]: ["ENOENT", "no such file or directory"],
  };

  builtins["util"] = {
    format: formatArgs,
    formatWithOptions: (opts, ...args) => formatArgsWithOptions(opts, ...args),
    log: (...args) => {
      globalThis.console.log(`${new Date().toISOString()} - ${formatArgs(...args)}`);
    },
    inspect: inspectFn,
    promisify,
    callbackify,
    inherits,
    deprecate: (fn) => fn,
    debuglog: () => () => {},
    debug: () => () => {},
    isDeepStrictEqual,
    parseArgs,
    parseEnv,
    styleText,
    getCallSites,
    MIMEType,
    MIMEParams,
    stripVTControlCharacters: (str) => String(str).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g"), ""),
    toUSVString: (str) => {
      const s = String(str);
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          if (i + 1 < s.length) {
            const next = s.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
              out += s[i] + s[i + 1];
              i++;
              continue;
            }
          }
          out += "\ufffd";
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          out += "\ufffd";
        } else {
          out += s[i];
        }
      }
      return out;
    },
    getSystemErrorMap: () => {
      const m = new Map();
      for (const [k, v] of Object.entries(SYSTEM_ERROR_NAMES)) {
        m.set(Number(k), v);
      }
      return m;
    },
    getSystemErrorName: (err) => {
      if (typeof err !== "number" || !Number.isInteger(err) || err >= 0) {
        throw makeNodeError("ERR_OUT_OF_RANGE", "The value of 'err' is out of range. It must be a negative integer", RangeError);
      }
      return (SYSTEM_ERROR_NAMES[err] && SYSTEM_ERROR_NAMES[err][0]) || `Unknown system error ${err}`;
    },
    getSystemErrorMessage: (err) => {
      if (typeof err !== "number" || !Number.isInteger(err) || err >= 0) {
        throw makeNodeError("ERR_OUT_OF_RANGE", "The value of 'err' is out of range. It must be a negative integer", RangeError);
      }
      return (SYSTEM_ERROR_NAMES[err] && SYSTEM_ERROR_NAMES[err][1]) || `Unknown system error ${err}`;
    },
    transferableAbortController: () => new AbortController(),
    transferableAbortSignal: (sig) => sig,
    isArray: Array.isArray,
    isBoolean: (v) => typeof v === "boolean",
    isBuffer: (v) => Buffer.isBuffer(v),
    isDate: (v) => v instanceof Date,
    isError: (v) => v instanceof Error,
    isFunction: (v) => typeof v === "function",
    isNull: (v) => v === null,
    isNullOrUndefined: (v) => v === null || v === undefined,
    isNumber: (v) => typeof v === "number",
    isObject: (v) => v !== null && typeof v === "object",
    isPrimitive: (v) => v === null || (typeof v !== "object" && typeof v !== "function"),
    isRegExp: (v) => v instanceof RegExp,
    isString: (v) => typeof v === "string",
    isSymbol: (v) => typeof v === "symbol",
    isUndefined: (v) => v === undefined,
    TextEncoder,
    TextDecoder,
    types: utilTypes,
  };
  builtins["util/types"] = utilTypes;

  // =========================================================================
  // 6b. Intl (NumberFormat, DateTimeFormat, Collator, PluralRules, Segmenter)
  // =========================================================================
  {
    const CURRENCY_SYMBOLS = {
      USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", BRL: "R$", CAD: "CA$",
      AUD: "A$", INR: "₹", KRW: "₩", CHF: "CHF", MXN: "MX$", RUB: "₽",
    };
    const DECIMAL_COMMA_LOCALES = /^(de|pt|es|fr|it|nl|pl|ru|tr|vi|id|sv|da|fi|no|nb|nn|cs|sk|hu|ro|bg|uk|el|ca)\b/i;

    function canonicalizeLocaleTag(tag) {
      const parts = String(tag).trim().replace(/_/g, "-").split("-");
      return parts.map((p, idx) => {
        if (idx === 0) return p.toLowerCase();
        if (p.length === 2 || /^\d{3}$/.test(p)) return p.toUpperCase();
        if (p.length === 4) return p[0].toUpperCase() + p.slice(1).toLowerCase();
        return p.toLowerCase();
      }).join("-");
    }

    function resolvePrimaryLocale(locales) {
      if (!locales) return "en-US";
      const first = Array.isArray(locales) ? locales[0] : locales;
      if (!first) return "en-US";
      return canonicalizeLocaleTag(first);
    }

    class IntlNumberFormat {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlNumberFormat)) return new IntlNumberFormat(locales, options);
        options = options || {};
        this._locale = resolvePrimaryLocale(locales);
        this._style = options.style || "decimal";
        this._currency = options.currency ? String(options.currency).toUpperCase() : undefined;
        if (this._style === "currency" && !this._currency) {
          throw new TypeError("Currency code is required with currency style");
        }
        this._currencyDisplay = options.currencyDisplay || "symbol";
        this._unit = options.unit || undefined;
        this._useGrouping = options.useGrouping !== undefined ? Boolean(options.useGrouping) : true;
        this._minInt = options.minimumIntegerDigits !== undefined ? Math.max(1, Number(options.minimumIntegerDigits)) : 1;
        const defaultMaxFrac = this._style === "currency" ? (this._currency === "JPY" || this._currency === "KRW" ? 0 : 2) : (this._style === "percent" ? 0 : 3);
        const defaultMinFrac = this._style === "currency" ? defaultMaxFrac : 0;
        this._minFrac = options.minimumFractionDigits !== undefined ? Math.max(0, Number(options.minimumFractionDigits)) : defaultMinFrac;
        this._maxFrac = options.maximumFractionDigits !== undefined ? Math.max(this._minFrac, Number(options.maximumFractionDigits)) : Math.max(this._minFrac, defaultMaxFrac);
        this._notation = options.notation || "standard";
        this._signDisplay = options.signDisplay || "auto";
      }
      format(val) {
        const isBig = typeof val === "bigint";
        let n = isBig ? Number(val) : Number(val);
        if (Number.isNaN(n)) return "NaN";
        if (!Number.isFinite(n)) return n < 0 ? "-∞" : "∞";
        const isComma = DECIMAL_COMMA_LOCALES.test(this._locale);
        const groupSep = isComma ? (this._locale.toLowerCase().startsWith("fr") ? "\u202f" : ".") : ",";
        const decSep = isComma ? "," : ".";
        if (this._style === "percent") n *= 100;
        const neg = n < 0 || Object.is(n, -0);
        let abs = Math.abs(n);
        let suffix = "";
        if (this._notation === "compact") {
          if (abs >= 1e9) { abs /= 1e9; suffix = "B"; }
          else if (abs >= 1e6) { abs /= 1e6; suffix = "M"; }
          else if (abs >= 1e3) { abs /= 1e3; suffix = "K"; }
        }
        const maxDigits = this._notation === "compact" && suffix ? Math.min(this._maxFrac, 1) : this._maxFrac;
        const factor = 10 ** maxDigits;
        const rounded = Math.round(Number((abs * factor).toPrecision(15))) / factor;
        const fixed = rounded.toFixed(maxDigits);
        let [intPart, fracPart = ""] = fixed.split(".");
        while (intPart.length < this._minInt) intPart = "0" + intPart;
        while (fracPart.length > this._minFrac && fracPart.endsWith("0")) {
          fracPart = fracPart.slice(0, -1);
        }
        if (this._useGrouping && intPart.length > 3) {
          let grouped = "";
          for (let i = 0; i < intPart.length; i++) {
            if (i > 0 && (intPart.length - i) % 3 === 0) grouped += groupSep;
            grouped += intPart[i];
          }
          intPart = grouped;
        }
        let core = fracPart.length > 0 ? `${intPart}${decSep}${fracPart}` : intPart;
        core += suffix;
        let signStr = "";
        if (neg && (n !== 0 || this._signDisplay !== "exceptZero") && this._signDisplay !== "never") {
          signStr = "-";
        } else if (!neg && (this._signDisplay === "always" || (this._signDisplay === "exceptZero" && n !== 0))) {
          signStr = "+";
        }
        if (this._style === "currency") {
          const sym = this._currencyDisplay === "code" || this._currencyDisplay === "name"
            ? `${this._currency}\u00a0`
            : (CURRENCY_SYMBOLS[this._currency] || `${this._currency}\u00a0`);
          if (isComma && this._currency === "EUR") {
            return `${signStr}${core}\u00a0${sym.trim()}`;
          }
          return `${signStr}${sym}${core}`;
        }
        if (this._style === "percent") {
          if (/^(de|fr)\b/i.test(this._locale)) {
            return `${signStr}${core}\u00a0%`;
          }
          return `${signStr}${core}%`;
        }
        if (this._style === "unit" && this._unit) {
          return `${signStr}${core} ${this._unit}`;
        }
        return `${signStr}${core}`;
      }
      formatToParts(val) {
        return [{ type: "integer", value: this.format(val) }];
      }
      resolvedOptions() {
        return {
          locale: this._locale,
          numberingSystem: "latn",
          style: this._style,
          currency: this._currency,
          currencyDisplay: this._currency ? this._currencyDisplay : undefined,
          useGrouping: this._useGrouping,
          minimumIntegerDigits: this._minInt,
          minimumFractionDigits: this._minFrac,
          maximumFractionDigits: this._maxFrac,
          notation: this._notation,
          signDisplay: this._signDisplay,
        };
      }
      static supportedLocalesOf(locales) {
        if (!locales) return [];
        return (Array.isArray(locales) ? locales : [locales]).map(String);
      }
    }

    const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const LOCALE_CALENDAR_NAMES = {
      de: {
        monthLong: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
        monthShort: ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."],
        weekdayLong: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
        weekdayShort: ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."],
      },
      fr: {
        monthLong: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
        monthShort: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
        weekdayLong: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
        weekdayShort: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
      },
      es: {
        monthLong: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
        monthShort: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
        weekdayLong: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
        weekdayShort: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
      },
      pt: {
        monthLong: ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
        monthShort: ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."],
        weekdayLong: ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"],
        weekdayShort: ["dom.", "seg.", "ter.", "qua.", "qui.", "sex.", "sáb."],
      },
    };
    function getLocaleCal(loc) {
      const lang = String(loc || "en").split("-")[0].toLowerCase();
      return LOCALE_CALENDAR_NAMES[lang] || {
        monthLong: MONTH_LONG,
        monthShort: MONTH_SHORT,
        weekdayLong: WEEKDAY_LONG,
        weekdayShort: WEEKDAY_SHORT,
      };
    }
    const TZ_OFFSETS_MIN = {
      UTC: 0, GMT: 0, Z: 0,
      "AMERICA/NEW_YORK": -300, "AMERICA/CHICAGO": -360, "AMERICA/DENVER": -420, "AMERICA/LOS_ANGELES": -480,
      "AMERICA/SAO_PAULO": -180, "EUROPE/LONDON": 0, "EUROPE/PARIS": 60, "EUROPE/BERLIN": 60,
      "ASIA/TOKYO": 540, "ASIA/SHANGHAI": 480, "ASIA/KOLKATA": 330, "AUSTRALIA/SYDNEY": 600,
    };

    const tzCache = new Map();
    function queryTzInfo(ms, tz) {
      const tzStr = tz ? String(tz) : "";
      const truncMs = Number.isFinite(ms) ? Math.trunc(ms) : 0;
      const cacheKey = `${tzStr}:${Math.floor(truncMs / 1800000)}`;
      const cached = tzCache.get(cacheKey);
      if (cached) return cached;
      let info;
      try {
        info = JSON.parse(hostCall("time.tzOffset", JSON.stringify({ ms: truncMs, tz: tzStr })));
      } catch (err) {
        if (err && err.code === "RangeError") {
          throw new RangeError(err.message || `Invalid time zone specified: ${tz}`, { cause: err });
        }
        throw err;
      }
      if (info.offsetMin === undefined && info.offsetSec !== undefined) {
        info.offsetMin = Math.trunc(info.offsetSec / 60);
      }
      if (!info.tz && info.timeZone) {
        info.tz = info.timeZone;
      }
      if (tzCache.size > 256) tzCache.clear();
      tzCache.set(cacheKey, info);
      return info;
    }

    class IntlDateTimeFormat {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlDateTimeFormat)) return new IntlDateTimeFormat(locales, options);
        this._locale = resolvePrimaryLocale(locales);
        this._options = Object.assign({}, options || {});
        if (this._options.timeZone !== undefined) {
          const info = queryTzInfo(Date.now(), String(this._options.timeZone));
          this._timeZone = info.tz || String(this._options.timeZone);
        } else {
          try {
            const info = queryTzInfo(Date.now(), processObj.env.TZ || "");
            this._timeZone = info.tz || "UTC";
          } catch (_) {
            this._timeZone = "UTC";
          }
        }
      }
      _extractParts(d) {
        const dt = d instanceof Date ? d : new Date(d === undefined ? Date.now() : d);
        if (Number.isNaN(dt.getTime())) throw new RangeError("Invalid time value");
        let useUTC = false;
        let shifted = dt;
        let zoneName = "UTC";
        const tzTarget = this._options.timeZone ? String(this._options.timeZone) : (processObj.env.TZ ? String(processObj.env.TZ) : "");
        try {
          const info = queryTzInfo(dt.getTime(), tzTarget);
          useUTC = true;
          shifted = new Date(dt.getTime() + info.offsetMin * 60000);
          zoneName = info.zone || info.tz || tzTarget || "UTC";
        } catch (e) {
          if (this._options.timeZone) throw e;
        }
        return {
          year: useUTC ? shifted.getUTCFullYear() : shifted.getFullYear(),
          month: (useUTC ? shifted.getUTCMonth() : shifted.getMonth()) + 1,
          day: useUTC ? shifted.getUTCDate() : shifted.getDate(),
          weekday: useUTC ? shifted.getUTCDay() : shifted.getDay(),
          hour: useUTC ? shifted.getUTCHours() : shifted.getHours(),
          minute: useUTC ? shifted.getUTCMinutes() : shifted.getMinutes(),
          second: useUTC ? shifted.getUTCSeconds() : shifted.getSeconds(),
          zoneName,
        };
      }
      formatToParts(date) {
        const p = this._extractParts(date);
        const o = Object.assign({}, this._options);
        const cal = getLocaleCal(this._locale);
        if (o.dateStyle) {
          if (o.dateStyle === "full") {
            o.weekday = "long";
            o.year = "numeric";
            o.month = "long";
            o.day = "numeric";
          } else if (o.dateStyle === "long") {
            o.year = "numeric";
            o.month = "long";
            o.day = "numeric";
          } else if (o.dateStyle === "medium") {
            o.year = "numeric";
            o.month = "short";
            o.day = "numeric";
          } else if (o.dateStyle === "short") {
            const isUS = /^en(?:-US)?$/i.test(this._locale);
            o.year = "2-digit";
            o.month = isUS ? "numeric" : "2-digit";
            o.day = isUS ? "numeric" : "2-digit";
          }
        }
        const hasAny = o.year || o.month || o.day || o.weekday || o.hour || o.minute || o.second || o.dateStyle || o.timeStyle;
        const wantDate = !hasAny || o.year || o.month || o.day || o.dateStyle;
        const wantTime = o.hour || o.minute || o.second || o.timeStyle;
        const parts = [];
        const pad2 = (n) => (n < 10 ? "0" + n : String(n));
        if (o.weekday) {
          const w = o.weekday === "long" ? cal.weekdayLong[p.weekday] : o.weekday === "narrow" ? cal.weekdayShort[p.weekday][0] : cal.weekdayShort[p.weekday];
          parts.push({ type: "weekday", value: w });
          if (wantDate || wantTime) parts.push({ type: "literal", value: ", " });
        }
        if (wantDate) {
          const isISO = /^sv|ja|zh|ko|hu|lt/i.test(this._locale);
          const isDE = /^de/i.test(this._locale);
          const isDMY = /^(en-GB|pt|es|fr|de|it|nl|ru|pl|tr|au)/i.test(this._locale);
          const yVal = o.year === "2-digit" ? pad2(p.year % 100) : String(p.year);
          let mVal = o.month === "2-digit" ? pad2(p.month) : String(p.month);
          if (o.month === "long") mVal = cal.monthLong[p.month - 1];
          else if (o.month === "short") mVal = cal.monthShort[p.month - 1];
          else if (o.month === "narrow") mVal = cal.monthShort[p.month - 1][0];
          const dVal = o.day === "2-digit" ? pad2(p.day) : String(p.day);
          if (o.month === "long" || o.month === "short") {
            if (isDE) {
              if (o.day) parts.push({ type: "day", value: dVal }, { type: "literal", value: ". " });
              if (o.month) parts.push({ type: "month", value: mVal });
              if (o.year) {
                if (parts.length > 0 && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: " " });
                parts.push({ type: "year", value: yVal });
              }
            } else if (isDMY) {
              if (o.day) parts.push({ type: "day", value: dVal }, { type: "literal", value: " " });
              if (o.month) parts.push({ type: "month", value: mVal });
              if (o.year) {
                if (parts.length > 0 && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: " " });
                parts.push({ type: "year", value: yVal });
              }
            } else {
              if (o.month) parts.push({ type: "month", value: mVal });
              if (o.day) {
                if (parts.length > 0 && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: " " });
                parts.push({ type: "day", value: dVal });
              }
              if (o.year) {
                if (parts.length > 0 && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: ", " });
                parts.push({ type: "year", value: yVal });
              }
            }
          } else if (isISO) {
            if (!hasAny || o.year || o.dateStyle) parts.push({ type: "year", value: yVal });
            if (!hasAny || o.month || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "-" });
              parts.push({ type: "month", value: pad2(p.month) });
            }
            if (!hasAny || o.day || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "-" });
              parts.push({ type: "day", value: pad2(p.day) });
            }
          } else if (isDE) {
            if (!hasAny || o.day || o.dateStyle) parts.push({ type: "day", value: dVal });
            if (!hasAny || o.month || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "." });
              parts.push({ type: "month", value: mVal });
            }
            if (!hasAny || o.year || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "." });
              parts.push({ type: "year", value: yVal });
            }
          } else if (isDMY) {
            if (!hasAny || o.day || o.dateStyle) parts.push({ type: "day", value: pad2(p.day) });
            if (!hasAny || o.month || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "/" });
              parts.push({ type: "month", value: pad2(p.month) });
            }
            if (!hasAny || o.year || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "/" });
              parts.push({ type: "year", value: yVal });
            }
          } else {
            if (!hasAny || o.month || o.dateStyle) parts.push({ type: "month", value: mVal });
            if (!hasAny || o.day || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "/" });
              parts.push({ type: "day", value: dVal });
            }
            if (!hasAny || o.year || o.dateStyle) {
              if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: "/" });
              parts.push({ type: "year", value: yVal });
            }
          }
        }
        if (wantTime) {
          if (parts.length > 0 && parts[parts.length - 1].type !== "literal") {
            parts.push({ type: "literal", value: ", " });
          }
          const defaultH12 = Boolean(o.timeStyle && /^en(?:-US)?$/i.test(this._locale));
          const h12 = o.hour12 !== undefined ? Boolean(o.hour12) : (o.hourCycle ? (o.hourCycle === "h11" || o.hourCycle === "h12") : defaultH12);
          let hr = p.hour;
          let ampm = "";
          if (h12) {
            ampm = hr >= 12 ? "PM" : "AM";
            hr = hr % 12 || 12;
          }
          const hVal = (o.hour === "numeric" || (o.timeStyle && !o.hour)) && h12 ? String(hr) : pad2(hr);
          if (o.hour || o.timeStyle) parts.push({ type: "hour", value: hVal });
          if (o.minute || o.timeStyle) {
            if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: ":" });
            parts.push({ type: "minute", value: pad2(p.minute) });
          }
          if (o.second || (o.timeStyle && o.timeStyle !== "short")) {
            if (parts.length && parts[parts.length - 1].type !== "literal") parts.push({ type: "literal", value: ":" });
            parts.push({ type: "second", value: pad2(p.second) });
          }
          if (ampm) {
            parts.push({ type: "literal", value: " " });
            parts.push({ type: "dayPeriod", value: ampm });
          }
          if (o.timeZoneName) {
            parts.push({ type: "literal", value: " " });
            parts.push({ type: "timeZoneName", value: p.zoneName || this._timeZone });
          }
        }
        return parts;
      }
      format(date) {
        return this.formatToParts(date).map((p) => p.value).join("");
      }
      resolvedOptions() {
        return Object.assign({
          locale: this._locale,
          calendar: "gregory",
          numberingSystem: "latn",
          timeZone: this._timeZone,
        }, this._options);
      }
      static supportedLocalesOf(locales) {
        if (!locales) return [];
        return (Array.isArray(locales) ? locales : [locales]).map(String);
      }
    }

    function stripDiacritics(str) {
      return str.normalize ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : str;
    }

    class IntlCollator {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlCollator)) return new IntlCollator(locales, options);
        options = options || {};
        this._locale = resolvePrimaryLocale(locales);
        this._usage = options.usage || "sort";
        this._sensitivity = options.sensitivity || "variant";
        this._ignorePunctuation = Boolean(options.ignorePunctuation);
        this._numeric = Boolean(options.numeric);
        this._caseFirst = options.caseFirst || "false";
        this.compare = this.compare.bind(this);
      }
      compare(a, b) {
        let sa = String(a);
        let sb = String(b);
        if (this._ignorePunctuation) {
          sa = sa.replace(/[\p{P}\p{S}\s]+/gu, "");
          sb = sb.replace(/[\p{P}\p{S}\s]+/gu, "");
        }
        if (this._sensitivity === "base") {
          sa = stripDiacritics(sa).toLowerCase();
          sb = stripDiacritics(sb).toLowerCase();
        } else if (this._sensitivity === "accent") {
          sa = sa.toLowerCase();
          sb = sb.toLowerCase();
        } else if (this._sensitivity === "case") {
          sa = stripDiacritics(sa);
          sb = stripDiacritics(sb);
        }
        if (this._numeric) {
          const ra = /(\d+|\D+)/g;
          const rb = /(\d+|\D+)/g;
          const pa = sa.match(ra) || [];
          const pb = sb.match(rb) || [];
          const len = Math.min(pa.length, pb.length);
          for (let i = 0; i < len; i++) {
            const ca = pa[i];
            const cb = pb[i];
            if (ca === cb) continue;
            const na = /^\d+$/.test(ca) ? BigInt(ca) : null;
            const nb = /^\d+$/.test(cb) ? BigInt(cb) : null;
            if (na !== null && nb !== null) {
              if (na !== nb) return na < nb ? -1 : 1;
              continue;
            }
            return ca < cb ? -1 : 1;
          }
          return pa.length === pb.length ? 0 : (pa.length < pb.length ? -1 : 1);
        }
        if (sa === sb) return 0;
        if (this._sensitivity === "variant") {
          const la = stripDiacritics(sa).toLowerCase();
          const lb = stripDiacritics(sb).toLowerCase();
          if (la !== lb) return la < lb ? -1 : 1;
        }
        return sa < sb ? -1 : 1;
      }
      resolvedOptions() {
        return {
          locale: this._locale,
          usage: this._usage,
          sensitivity: this._sensitivity,
          ignorePunctuation: this._ignorePunctuation,
          numeric: this._numeric,
          caseFirst: this._caseFirst,
          collation: "default",
        };
      }
      static supportedLocalesOf(locales) {
        if (!locales) return [];
        return (Array.isArray(locales) ? locales : [locales]).map(String);
      }
    }

    class IntlPluralRules {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlPluralRules)) return new IntlPluralRules(locales, options);
        options = options || {};
        this._locale = resolvePrimaryLocale(locales);
        this._type = options.type || "cardinal";
      }
      select(n) {
        const num = Math.abs(Number(n));
        if (this._type === "ordinal") {
          const mod10 = num % 10;
          const mod100 = num % 100;
          if (mod10 === 1 && mod100 !== 11) return "one";
          if (mod10 === 2 && mod100 !== 12) return "two";
          if (mod10 === 3 && mod100 !== 13) return "few";
          return "other";
        }
        return num === 1 ? "one" : "other";
      }
      resolvedOptions() {
        return {
          locale: this._locale,
          type: this._type,
          pluralCategories: this._type === "ordinal" ? ["one", "two", "few", "other"] : ["one", "other"],
        };
      }
      static supportedLocalesOf(locales) {
        if (!locales) return [];
        return (Array.isArray(locales) ? locales : [locales]).map(String);
      }
    }

    class IntlSegmenter {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlSegmenter)) return new IntlSegmenter(locales, options);
        options = options || {};
        this._locale = resolvePrimaryLocale(locales);
        this._granularity = options.granularity || "grapheme";
      }
      segment(input) {
        const str = String(input);
        const gran = this._granularity;
        return {
          *[Symbol.iterator]() {
            if (gran === "word") {
              const re = /([\p{L}\p{N}_]+|[^\p{L}\p{N}_])/gu;
              let m;
              while ((m = re.exec(str)) !== null) {
                const seg = m[0];
                yield {
                  segment: seg,
                  index: m.index,
                  input: str,
                  isWordLike: /[\p{L}\p{N}_]/u.test(seg),
                };
              }
            } else if (gran === "sentence") {
              const re = /[^.!?]+[.!?]*\s*/g;
              let m;
              while ((m = re.exec(str)) !== null) {
                yield { segment: m[0], index: m.index, input: str };
              }
            } else {
              let idx = 0;
              for (const ch of str) {
                yield { segment: ch, index: idx, input: str };
                idx += ch.length;
              }
            }
          },
          containing(codeUnitIndex = 0) {
            const pos = Math.trunc(Number(codeUnitIndex) || 0);
            if (pos < 0 || pos >= str.length) return undefined;
            for (const item of this) {
              if (pos >= item.index && pos < item.index + item.segment.length) return item;
            }
            return undefined;
          },
        };
      }
      resolvedOptions() {
        return { locale: this._locale, granularity: this._granularity };
      }
      static supportedLocalesOf(locales) {
        if (!locales) return [];
        return (Array.isArray(locales) ? locales : [locales]).map(String);
      }
    }

    class IntlListFormat {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlListFormat)) return new IntlListFormat(locales, options);
        options = options || {};
        this._locale = resolvePrimaryLocale(locales);
        this._type = options.type || "conjunction";
        this._style = options.style || "long";
      }
      format(list) {
        const items = Array.from(list || [], String);
        if (items.length === 0) return "";
        if (items.length === 1) return items[0];
        if (this._type === "unit" && this._style === "narrow") return items.join(" ");
        if (this._type === "unit") return items.join(", ");
        const conj = this._type === "disjunction" ? "or" : "and";
        if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
        return `${items.slice(0, -1).join(", ")}, ${conj} ${items[items.length - 1]}`;
      }
      formatToParts(list) {
        return [{ type: "element", value: this.format(list) }];
      }
      resolvedOptions() {
        return { locale: this._locale, type: this._type, style: this._style };
      }
    }

    class IntlRelativeTimeFormat {
      constructor(locales, options = {}) {
        if (!(this instanceof IntlRelativeTimeFormat)) return new IntlRelativeTimeFormat(locales, options);
        options = options || {};
        this._locale = resolvePrimaryLocale(locales);
        this._numeric = options.numeric || "always";
        this._style = options.style || "long";
      }
      format(value, unit) {
        const n = Number(value);
        const u = String(unit).replace(/s$/, "");
        if (this._numeric === "auto" && u === "day") {
          if (n === 0) return "today";
          if (n === 1) return "tomorrow";
          if (n === -1) return "yesterday";
        }
        const abs = Math.abs(n);
        const label = abs === 1 ? u : `${u}s`;
        return n < 0 ? `${abs} ${label} ago` : `in ${abs} ${label}`;
      }
      formatToParts(value, unit) {
        return [{ type: "literal", value: this.format(value, unit) }];
      }
      resolvedOptions() {
        return { locale: this._locale, numeric: this._numeric, style: this._style, numberingSystem: "latn" };
      }
    }

    function makeCallableIntlClass(Cls) {
      return new Proxy(Cls, {
        apply(Target, _thisArg, args) {
          return new Target(...args);
        },
      });
    }

    const intlObj = {
      NumberFormat: makeCallableIntlClass(IntlNumberFormat),
      DateTimeFormat: makeCallableIntlClass(IntlDateTimeFormat),
      Collator: makeCallableIntlClass(IntlCollator),
      PluralRules: IntlPluralRules,
      Segmenter: IntlSegmenter,
      ListFormat: IntlListFormat,
      RelativeTimeFormat: IntlRelativeTimeFormat,
      getCanonicalLocales(locales) {
        if (!locales) return [];
        const arr = Array.isArray(locales) ? locales : [locales];
        const seen = new Set();
        const out = [];
        for (const l of arr) {
          const c = canonicalizeLocaleTag(l);
          if (!seen.has(c)) {
            seen.add(c);
            out.push(c);
          }
        }
        return out;
      },
      supportedValuesOf(key) {
        if (key === "timeZone") return Object.keys(TZ_OFFSETS_MIN);
        if (key === "currency") return Object.keys(CURRENCY_SYMBOLS);
        if (key === "calendar") return ["gregory", "iso8601"];
        if (key === "numberingSystem") return ["latn"];
        return [];
      },
    };
    globalThis.Intl = intlObj;

    Number.prototype.toLocaleString = function toLocaleString(locales, options) {
      return new IntlNumberFormat(locales, options).format(Number(this));
    };
    if (typeof BigInt !== "undefined") {
      BigInt.prototype.toLocaleString = function toLocaleString(locales, options) {
        return new IntlNumberFormat(locales, options).format(this);
      };
    }
    String.prototype.localeCompare = function localeCompare(that, locales, options) {
      if (this === null || this === undefined) throw new TypeError("String.prototype.localeCompare called on null or undefined");
      return new IntlCollator(locales, options).compare(String(this), String(that));
    };
    Date.prototype.toLocaleString = function toLocaleString(locales, options) {
      const opts = Object.assign({ year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }, options || {});
      return new IntlDateTimeFormat(locales, opts).format(this);
    };
    Date.prototype.toLocaleDateString = function toLocaleDateString(locales, options) {
      const opts = Object.assign({ year: "numeric", month: "numeric", day: "numeric" }, options || {});
      return new IntlDateTimeFormat(locales, opts).format(this);
    };
    Date.prototype.toLocaleTimeString = function toLocaleTimeString(locales, options) {
      const opts = Object.assign({ hour: "numeric", minute: "2-digit", second: "2-digit" }, options || {});
      return new IntlDateTimeFormat(locales, opts).format(this);
    };

    const OrigDate = globalThis.Date;
    const origGetTime = OrigDate.prototype.getTime;
    const origSetTime = OrigDate.prototype.setTime;
    const origDateParse = OrigDate.parse;
    const origGetTimezoneOffset = OrigDate.prototype.getTimezoneOffset;
    const origGetFullYear = OrigDate.prototype.getFullYear;
    const origGetMonth = OrigDate.prototype.getMonth;
    const origGetDate = OrigDate.prototype.getDate;
    const origGetDay = OrigDate.prototype.getDay;
    const origGetHours = OrigDate.prototype.getHours;
    const origGetMinutes = OrigDate.prototype.getMinutes;
    const origGetSeconds = OrigDate.prototype.getSeconds;
    const origToString = OrigDate.prototype.toString;
    const origToDateString = OrigDate.prototype.toDateString;
    const origToTimeString = OrigDate.prototype.toTimeString;

    function getTzShiftedDate(d) {
      const ms = origGetTime.call(d);
      if (Number.isNaN(ms)) return null;
      const tz = processObj.env.TZ || "";
      try {
        const info = queryTzInfo(ms, tz);
        return {
          shifted: new OrigDate(ms + info.offsetMin * 60000),
          offsetMin: info.offsetMin,
          zone: info.zone || info.tz || tz || "UTC",
        };
      } catch (_) {
        return null;
      }
    }

    function localFieldsToUTCMs(localAsUTC) {
      if (Number.isNaN(localAsUTC)) return NaN;
      const tz = processObj.env.TZ || "";
      try {
        const info1 = queryTzInfo(localAsUTC, tz);
        const guess1 = localAsUTC - info1.offsetMin * 60000;
        const info2 = queryTzInfo(guess1, tz);
        return localAsUTC - info2.offsetMin * 60000;
      } catch (_) {
        return localAsUTC;
      }
    }

    function parseDateString(str) {
      const s = String(str);
      if (/^\s*[+-]?\d{4,6}(?:-\d{2}(?:-\d{2})?)?\s*$/.test(s)) {
        return origDateParse.call(OrigDate, s);
      }
      if (/(?:Z|GMT|UTC|[+-]\d{1,2}(?::?\d{2})?)\s*(?:\([^)]*\))?\s*$/i.test(s)) {
        return origDateParse.call(OrigDate, s);
      }
      const trimmed = s.trim();
      const utcCandidate = /^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)
        ? trimmed.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T") + "Z"
        : trimmed + " GMT";
      const utcMs = origDateParse.call(OrigDate, utcCandidate);
      if (!Number.isNaN(utcMs)) {
        return localFieldsToUTCMs(utcMs);
      }
      const rawMs = origDateParse.call(OrigDate, s);
      if (Number.isNaN(rawMs)) return NaN;
      return localFieldsToUTCMs(rawMs);
    }

    OrigDate.prototype.getTimezoneOffset = function getTimezoneOffset() {
      const s = getTzShiftedDate(this);
      if (s) return s.offsetMin === 0 ? 0 : -s.offsetMin;
      return origGetTimezoneOffset.call(this);
    };
    OrigDate.prototype.getFullYear = function getFullYear() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCFullYear() : origGetFullYear.call(this);
    };
    OrigDate.prototype.getYear = function getYear() {
      return this.getFullYear() - 1900;
    };
    OrigDate.prototype.getMonth = function getMonth() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCMonth() : origGetMonth.call(this);
    };
    OrigDate.prototype.getDate = function getDate() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCDate() : origGetDate.call(this);
    };
    OrigDate.prototype.getDay = function getDay() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCDay() : origGetDay.call(this);
    };
    OrigDate.prototype.getHours = function getHours() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCHours() : origGetHours.call(this);
    };
    OrigDate.prototype.getMinutes = function getMinutes() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCMinutes() : origGetMinutes.call(this);
    };
    OrigDate.prototype.getSeconds = function getSeconds() {
      const s = getTzShiftedDate(this);
      return s ? s.shifted.getUTCSeconds() : origGetSeconds.call(this);
    };
    OrigDate.prototype.setMilliseconds = function setMilliseconds(ms) {
      const s = getTzShiftedDate(this);
      if (!s) return origSetTime.call(this, NaN);
      s.shifted.setUTCMilliseconds(ms);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(s.shifted)));
    };
    OrigDate.prototype.setSeconds = function setSeconds(sec, ...rest) {
      const s = getTzShiftedDate(this);
      if (!s) return origSetTime.call(this, NaN);
      s.shifted.setUTCSeconds(sec, ...rest);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(s.shifted)));
    };
    OrigDate.prototype.setMinutes = function setMinutes(min, ...rest) {
      const s = getTzShiftedDate(this);
      if (!s) return origSetTime.call(this, NaN);
      s.shifted.setUTCMinutes(min, ...rest);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(s.shifted)));
    };
    OrigDate.prototype.setHours = function setHours(hr, ...rest) {
      const s = getTzShiftedDate(this);
      if (!s) return origSetTime.call(this, NaN);
      s.shifted.setUTCHours(hr, ...rest);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(s.shifted)));
    };
    OrigDate.prototype.setDate = function setDate(d) {
      const s = getTzShiftedDate(this);
      if (!s) return origSetTime.call(this, NaN);
      s.shifted.setUTCDate(d);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(s.shifted)));
    };
    OrigDate.prototype.setMonth = function setMonth(m, ...rest) {
      const s = getTzShiftedDate(this);
      if (!s) return origSetTime.call(this, NaN);
      s.shifted.setUTCMonth(m, ...rest);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(s.shifted)));
    };
    OrigDate.prototype.setFullYear = function setFullYear(y, ...rest) {
      const s = getTzShiftedDate(this);
      const base = s ? s.shifted : new OrigDate(0);
      base.setUTCFullYear(y, ...rest);
      return origSetTime.call(this, localFieldsToUTCMs(origGetTime.call(base)));
    };
    OrigDate.prototype.setYear = function setYear(y) {
      const yr = Number(y);
      if (Number.isNaN(yr)) return origSetTime.call(this, NaN);
      const full = yr >= 0 && yr <= 99 ? 1900 + Math.trunc(yr) : yr;
      return this.setFullYear(full);
    };
    OrigDate.prototype.toDateString = function toDateString() {
      const s = getTzShiftedDate(this);
      if (!s) return origToDateString.call(this);
      const pad2 = (n) => (n < 10 ? "0" + n : String(n));
      return `${WEEKDAY_SHORT[s.shifted.getUTCDay()]} ${MONTH_SHORT[s.shifted.getUTCMonth()]} ${pad2(s.shifted.getUTCDate())} ${s.shifted.getUTCFullYear()}`;
    };
    OrigDate.prototype.toTimeString = function toTimeString() {
      const s = getTzShiftedDate(this);
      if (!s) return origToTimeString.call(this);
      const pad2 = (n) => (n < 10 ? "0" + n : String(n));
      const sign = s.offsetMin >= 0 ? "+" : "-";
      const absMin = Math.abs(s.offsetMin);
      const offStr = `${sign}${pad2(Math.floor(absMin / 60))}${pad2(absMin % 60)}`;
      return `${pad2(s.shifted.getUTCHours())}:${pad2(s.shifted.getUTCMinutes())}:${pad2(s.shifted.getUTCSeconds())} GMT${offStr} (${s.zone})`;
    };
    OrigDate.prototype.toString = function toString() {
      const s = getTzShiftedDate(this);
      if (!s) return origToString.call(this);
      return `${this.toDateString()} ${this.toTimeString()}`;
    };
    const WrappedDate = function Date(...args) {
      if (!new.target) {
        return new WrappedDate().toString();
      }
      const ctorTarget = new.target === WrappedDate ? OrigDate : new.target;
      if (args.length === 0) {
        return Reflect.construct(OrigDate, [], ctorTarget);
      }
      if (args.length === 1) {
        const a0 = args[0];
        if (typeof a0 === "string") {
          return Reflect.construct(OrigDate, [parseDateString(a0)], ctorTarget);
        }
        if (a0 instanceof OrigDate) {
          return Reflect.construct(OrigDate, [origGetTime.call(a0)], ctorTarget);
        }
        return Reflect.construct(OrigDate, [a0], ctorTarget);
      }
      const localAsUTC = OrigDate.UTC(...args);
      return Reflect.construct(OrigDate, [localFieldsToUTCMs(localAsUTC)], ctorTarget);
    };
    Object.defineProperty(WrappedDate, "length", { value: 7, writable: false, enumerable: false, configurable: true });
    Object.defineProperty(WrappedDate, "prototype", { value: OrigDate.prototype, writable: false, enumerable: false, configurable: false });
    WrappedDate.now = OrigDate.now.bind(OrigDate);
    WrappedDate.UTC = OrigDate.UTC.bind(OrigDate);
    WrappedDate.parse = parseDateString;
    OrigDate.prototype.constructor = WrappedDate;
    globalThis.Date = WrappedDate;
  }

  // =========================================================================
  // 7. Assert
  // =========================================================================

  class AssertionError extends Error {
    constructor(options = {}) {
      const { message, actual, expected, operator = "==" } = options;
      super(message || `${inspectValue(actual)} ${operator} ${inspectValue(expected)}`);
      this.name = "AssertionError";
      this.code = "ERR_ASSERTION";
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
      this.generatedMessage = !message;
    }
  }

  function assertOk(value, message) {
    if (!value) {
      if (message instanceof Error) throw message;
      throw new AssertionError({ message, actual: value, expected: true, operator: "==" });
    }
  }

  const assertMod = Object.assign(assertOk, {
    AssertionError,
    ok: assertOk,
    fail(message) {
      if (message instanceof Error) throw message;
      throw new AssertionError({ message: message || "Failed", operator: "fail" });
    },
    equal(actual, expected, message) {
      if (actual != expected && !(Number.isNaN(actual) && Number.isNaN(expected))) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "==" });
      }
    },
    notEqual(actual, expected, message) {
      if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "!=" });
      }
    },
    strictEqual(actual, expected, message) {
      if (!Object.is(actual, expected)) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "strictEqual" });
      }
    },
    notStrictEqual(actual, expected, message) {
      if (Object.is(actual, expected)) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "notStrictEqual" });
      }
    },
    deepEqual(actual, expected, message) {
      if (!isDeepEqualInternal(actual, expected, false)) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "deepEqual" });
      }
    },
    notDeepEqual(actual, expected, message) {
      if (isDeepEqualInternal(actual, expected, false)) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "notDeepEqual" });
      }
    },
    deepStrictEqual(actual, expected, message) {
      if (!isDeepStrictEqual(actual, expected)) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "deepStrictEqual" });
      }
    },
    notDeepStrictEqual(actual, expected, message) {
      if (isDeepStrictEqual(actual, expected)) {
        if (message instanceof Error) throw message;
        throw new AssertionError({ message, actual, expected, operator: "notDeepStrictEqual" });
      }
    },
    throws(block, error, message) {
      if (typeof block !== "function") {
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "fn" argument must be of type function. Received ${block === null ? "null" : typeof block}`,
          TypeError
        );
      }
      let threw = false;
      let caught = null;
      try {
        block();
      } catch (e) {
        threw = true;
        caught = e;
      }
      if (!threw) throw new AssertionError({ message: message || "Missing expected exception", operator: "throws" });
      if (error) {
        if (error instanceof RegExp) {
          const str1 = String(caught);
          const str2 = caught && typeof caught === "object" ? String(caught.message || "") : "";
          const str3 = caught && typeof caught === "object" ? `${caught.name || "Error"}: ${caught.message || ""}` : "";
          if (!error.test(str1) && !error.test(str2) && !error.test(str3)) {
            throw new AssertionError({ message: message || `Error ${caught} did not match ${error}`, actual: caught, expected: error, operator: "throws" });
          }
        } else if (typeof error === "function") {
          const isInst = Boolean(error.prototype && typeof error.prototype === "object" && caught instanceof error);
          if (!isInst && error(caught) !== true) {
            throw new AssertionError({ message: message || "Unexpected exception type", actual: caught, expected: error, operator: "throws" });
          }
        } else if (typeof error === "object") {
          for (const k of Reflect.ownKeys(error)) {
            const v = error[k];
            if (!caught || !(k in Object(caught)) || (v instanceof RegExp ? !v.test(String(caught[k])) : !isDeepEqualInternal(caught[k], v, true))) {
              throw new AssertionError({ message: message || `Unexpected exception property ${String(k)}`, actual: caught, expected: error, operator: "throws" });
            }
          }
        }
      }
    },
    doesNotThrow(block, message) {
      if (typeof block !== "function") {
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "fn" argument must be of type function. Received ${block === null ? "null" : typeof block}`,
          TypeError
        );
      }
      try {
        block();
      } catch (e) {
        throw new AssertionError({ message: message || `Got unwanted exception: ${e}`, actual: e, operator: "doesNotThrow" });
      }
    },
    async rejects(asyncFn, error, message) {
      if (typeof asyncFn !== "function" && (!asyncFn || typeof asyncFn.then !== "function")) {
        throw makeNodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "asyncFn" argument must be of type function or an instance of Promise. Received ${asyncFn === null ? "null" : typeof asyncFn}`,
          TypeError
        );
      }
      let threw = false;
      let caught = null;
      try {
        const p = typeof asyncFn === "function" ? asyncFn() : asyncFn;
        await p;
      } catch (e) {
        threw = true;
        caught = e;
      }
      if (!threw) throw new AssertionError({ message: message || "Missing expected rejection", operator: "rejects" });
      if (error) {
        if (error instanceof RegExp) {
          const str1 = String(caught);
          const str2 = caught && typeof caught === "object" ? String(caught.message || "") : "";
          const str3 = caught && typeof caught === "object" ? `${caught.name || "Error"}: ${caught.message || ""}` : "";
          if (!error.test(str1) && !error.test(str2) && !error.test(str3)) {
            throw new AssertionError({ message, actual: caught, expected: error, operator: "rejects" });
          }
        } else if (typeof error === "function") {
          const isInst = Boolean(error.prototype && typeof error.prototype === "object" && caught instanceof error);
          if (!isInst && error(caught) !== true) {
            throw new AssertionError({ message: message || "Unexpected rejection type", actual: caught, expected: error, operator: "rejects" });
          }
        } else if (typeof error === "object") {
          for (const k of Reflect.ownKeys(error)) {
            const v = error[k];
            if (!caught || !(k in Object(caught)) || (v instanceof RegExp ? !v.test(String(caught[k])) : !isDeepEqualInternal(caught[k], v, true))) {
              throw new AssertionError({ message: message || `Unexpected rejection property ${String(k)}`, actual: caught, expected: error, operator: "rejects" });
            }
          }
        }
      }
    },
    async doesNotReject(asyncFn, message) {
      const p = typeof asyncFn === "function" ? asyncFn() : asyncFn;
      try {
        await p;
      } catch (e) {
        throw new AssertionError({ message: message || `Got unwanted rejection: ${e}`, actual: e, operator: "doesNotReject" });
      }
    },
    match(string, regexp, message) {
      if (!regexp.test(String(string))) {
        throw new AssertionError({ message, actual: string, expected: regexp, operator: "match" });
      }
    },
    doesNotMatch(string, regexp, message) {
      if (regexp.test(String(string))) {
        throw new AssertionError({ message, actual: string, expected: regexp, operator: "doesNotMatch" });
      }
    },
    ifError(err) {
      if (err !== null && err !== undefined) throw err;
    },
    partialDeepStrictEqual(actual, expected, message) {
      function isPartialMatch(act, exp, seen = new Map()) {
        if (Object.is(act, exp)) return true;
        if (exp === null || exp === undefined || typeof exp !== "object") return false;
        if (act === null || act === undefined || typeof act !== "object") return false;
        if (exp instanceof Date) return act instanceof Date && act.getTime() === exp.getTime();
        if (exp instanceof RegExp) return act instanceof RegExp && act.source === exp.source && act.flags === exp.flags;
        if (seen.get(act) === exp) return true;
        seen.set(act, exp);
        if (Array.isArray(exp)) {
          if (!Array.isArray(act) || act.length < exp.length) return false;
          let ai = 0;
          for (let ei = 0; ei < exp.length; ei++) {
            let matched = false;
            while (ai < act.length) {
              if (isPartialMatch(act[ai++], exp[ei], seen)) {
                matched = true;
                break;
              }
            }
            if (!matched) return false;
          }
          return true;
        }
        if (exp instanceof Map) {
          if (!(act instanceof Map)) return false;
          for (const [k, v] of exp.entries()) {
            if (!act.has(k) || !isPartialMatch(act.get(k), v, seen)) return false;
          }
          return true;
        }
        if (exp instanceof Set) {
          if (!(act instanceof Set)) return false;
          for (const v of exp.values()) {
            let found = false;
            for (const av of act.values()) {
              if (isPartialMatch(av, v, seen)) { found = true; break; }
            }
            if (!found) return false;
          }
          return true;
        }
        for (const k of Reflect.ownKeys(exp)) {
          if (!(k in act) || !isPartialMatch(act[k], exp[k], seen)) return false;
        }
        return true;
      }
      if (!isPartialMatch(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "partialDeepStrictEqual" });
      }
    },
  });
  const strictAssert = Object.assign(
    function strict(value, message) {
      return assertOk(value, message);
    },
    assertMod,
    {
      equal: assertMod.strictEqual,
      notEqual: assertMod.notStrictEqual,
      deepEqual: assertMod.deepStrictEqual,
      notDeepEqual: assertMod.notDeepStrictEqual,
    }
  );
  strictAssert.strict = strictAssert;
  assertMod.strict = strictAssert;
  builtins["assert"] = assertMod;
  builtins["assert/strict"] = strictAssert;

  // =========================================================================
  // 8. Path (posix & win32)
  // =========================================================================

  function normalizeSegments(parts, allowAboveRoot) {
    const res = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || p === ".") continue;
      if (p === "..") {
        if (res.length > 0 && res[res.length - 1] !== "..") {
          res.pop();
        } else if (allowAboveRoot) {
          res.push("..");
        }
      } else {
        res.push(p);
      }
    }
    return res;
  }

  const posixPath = {
    sep: "/",
    delimiter: ":",
    normalize(p) {
      p = String(p);
      if (p.length === 0) return ".";
      const isAbs = p.charCodeAt(0) === 47;
      const trailing = p.charCodeAt(p.length - 1) === 47;
      const segs = normalizeSegments(p.split("/"), !isAbs);
      let out = segs.join("/");
      if (!out && !isAbs) out = ".";
      if (out && trailing) out += "/";
      return (isAbs ? "/" : "") + out;
    },
    isAbsolute(p) {
      return String(p).startsWith("/");
    },
    join(...paths) {
      if (paths.length === 0) return ".";
      const joined = paths.filter((p) => p && String(p).length > 0).join("/");
      return joined ? posixPath.normalize(joined) : ".";
    },
    resolve(...paths) {
      let resolvedPath = "";
      let resolvedAbsolute = false;
      for (let i = paths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        const path = i >= 0 ? String(paths[i]) : processObj.cwd().replace(/\\/g, "/");
        if (!path) continue;
        resolvedPath = path + "/" + resolvedPath;
        resolvedAbsolute = path.charCodeAt(0) === 47;
      }
      resolvedPath = normalizeSegments(resolvedPath.split("/"), !resolvedAbsolute).join("/");
      return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
    },
    dirname(p) {
      p = String(p);
      if (p.length === 0) return ".";
      const hadLeadingSlash = p.charCodeAt(0) === 47;
      p = p.replace(/\/+$/, "");
      if (!p) return hadLeadingSlash ? "/" : ".";
      const idx = p.lastIndexOf("/");
      if (idx === -1) return ".";
      if (idx === 0) return "/";
      return p.slice(0, idx);
    },
    basename(p, ext) {
      p = String(p).replace(/\/+$/, "");
      const idx = p.lastIndexOf("/");
      let base = idx === -1 ? p : p.slice(idx + 1);
      if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
      return base;
    },
    extname(p) {
      const base = posixPath.basename(p);
      if (base === "." || base === "..") return "";
      const idx = base.lastIndexOf(".");
      if (idx <= 0) return "";
      return base.slice(idx);
    },
    relative(from, to) {
      from = posixPath.resolve(from);
      to = posixPath.resolve(to);
      if (from === to) return "";
      const fromParts = from.split("/").filter(Boolean);
      const toParts = to.split("/").filter(Boolean);
      let common = 0;
      while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
        common++;
      }
      const up = new Array(fromParts.length - common).fill("..");
      return [...up, ...toParts.slice(common)].join("/");
    },
    parse(p) {
      p = String(p);
      const root = p.startsWith("/") ? "/" : "";
      const dir = posixPath.dirname(p);
      const base = posixPath.basename(p);
      const ext = posixPath.extname(p);
      const name = ext ? base.slice(0, base.length - ext.length) : base;
      return { root, dir: dir === "." && !p.startsWith("./") ? "" : dir, base, ext, name };
    },
    format(pathObject) {
      if (!pathObject || typeof pathObject !== "object") {
        const err = new TypeError(`The "pathObject" argument must be of type Object. Received ${pathObject === null ? "null" : typeof pathObject}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      const dir = pathObject.dir || pathObject.root || "";
      const extRaw = pathObject.ext ? String(pathObject.ext) : "";
      const ext = extRaw ? (extRaw.startsWith(".") ? extRaw : "." + extRaw) : "";
      const base = pathObject.base || (pathObject.name || "") + ext;
      if (!dir) return base;
      return dir === pathObject.root || dir.endsWith("/") ? dir + base : dir + "/" + base;
    },
    toNamespacedPath(p) { return p; },
  };

  function splitWinRoot(p) {
    p = String(p).replace(/\//g, "\\");
    const unc = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/.exec(p);
    if (unc) {
      const root = "\\\\" + unc[1] + "\\" + unc[2] + "\\";
      const rest = unc[3] ? unc[3].replace(/^\\+/, "") : "";
      return { root, drive: "\\\\" + unc[1] + "\\" + unc[2], isAbs: true, isUnc: true, rest };
    }
    const m = /^([a-zA-Z]:)?(\\+)?(.*)$/.exec(p);
    const drive = m && m[1] ? m[1] : "";
    const slash = m && m[2] ? "\\" : "";
    const rest = m && m[3] ? m[3] : "";
    return { root: drive + slash, drive, isAbs: Boolean(slash), isUnc: false, rest };
  }

  const win32Path = {
    sep: "\\",
    delimiter: ";",
    normalize(p) {
      p = String(p);
      if (!p) return ".";
      const { root, isAbs, rest } = splitWinRoot(p);
      const trailing = /[\\/]$/.test(p);
      const segs = normalizeSegments(rest.split("\\"), !isAbs);
      let out = segs.join("\\");
      if (!out && !isAbs) out = ".";
      if (out && trailing) out += "\\";
      return root + out;
    },
    isAbsolute(p) {
      p = String(p);
      return /^[\\/]|^[a-zA-Z]:[\\/]/.test(p);
    },
    join(...paths) {
      if (paths.length === 0) return ".";
      const joined = paths.filter((p) => p && String(p).length > 0).join("\\");
      return joined ? win32Path.normalize(joined) : ".";
    },
    resolve(...paths) {
      let resolvedDrive = "";
      let resolvedTail = "";
      let resolvedAbsolute = false;
      for (let i = paths.length - 1; i >= -1; i--) {
        const path = i >= 0 ? String(paths[i]) : processObj.cwd();
        if (!path) continue;
        const { drive, isAbs, rest } = splitWinRoot(path);
        if (drive && resolvedDrive && drive.toLowerCase() !== resolvedDrive.toLowerCase()) continue;
        if (drive && !resolvedDrive) resolvedDrive = drive;
        if (!resolvedAbsolute) {
          resolvedTail = rest + "\\" + resolvedTail;
          resolvedAbsolute = isAbs;
        }
        if (resolvedDrive && resolvedAbsolute) break;
      }
      const segs = normalizeSegments(resolvedTail.split("\\"), !resolvedAbsolute);
      return (resolvedDrive + (resolvedAbsolute ? "\\" : "") + segs.join("\\")) || ".";
    },
    dirname(p) {
      p = String(p);
      if (!p) return ".";
      const unc = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)([\\/].*)?$/.exec(p);
      if (unc) {
        const prefix = unc[1];
        const tail = unc[2] || "";
        const trimmed = tail.replace(/[\\/]+$/, "");
        if (!trimmed) return prefix + (tail ? tail[0] : "");
        const lastSlash = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
        if (lastSlash <= 0) return prefix + trimmed[0];
        return prefix + trimmed.slice(0, lastSlash);
      }
      const m = /^([a-zA-Z]:)?([\\/]+)?(.*)$/.exec(p);
      const drive = (m && m[1]) || "";
      const rootSlash = m && m[2] ? m[2][0] : "";
      const root = drive + rootSlash;
      const rawRest = (m && m[3]) || "";
      const rest = rawRest.replace(/[\\/]+$/, "");
      if (!rest) return root || ".";
      const idx = Math.max(rest.lastIndexOf("\\"), rest.lastIndexOf("/"));
      if (idx === -1) return root || ".";
      return root + rest.slice(0, idx);
    },
    basename(p, ext) {
      p = String(p);
      const { rest: rawRest } = splitWinRoot(p);
      const rest = rawRest.replace(/\\+$/, "");
      const idx = rest.lastIndexOf("\\");
      let base = idx === -1 ? rest : rest.slice(idx + 1);
      if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
      return base;
    },
    extname(p) {
      const base = win32Path.basename(p);
      if (base === "." || base === "..") return "";
      const idx = base.lastIndexOf(".");
      if (idx <= 0) return "";
      return base.slice(idx);
    },
    relative(from, to) {
      from = win32Path.resolve(from);
      to = win32Path.resolve(to);
      if (from.toLowerCase() === to.toLowerCase()) return "";
      const f = splitWinRoot(from);
      const t = splitWinRoot(to);
      if (f.drive.toLowerCase() !== t.drive.toLowerCase()) return to;
      const fromParts = f.rest.split("\\").filter(Boolean);
      const toParts = t.rest.split("\\").filter(Boolean);
      let common = 0;
      while (common < fromParts.length && common < toParts.length && fromParts[common].toLowerCase() === toParts[common].toLowerCase()) {
        common++;
      }
      const up = new Array(fromParts.length - common).fill("..");
      return [...up, ...toParts.slice(common)].join("\\");
    },
    parse(p) {
      p = String(p);
      if (!p) return { root: "", dir: "", base: "", ext: "", name: "" };
      let root;
      const unc = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)([\\/])?/.exec(p);
      if (unc) {
        root = unc[1] + (unc[2] || "");
      } else {
        const m = /^([a-zA-Z]:)?([\\/])?/.exec(p);
        root = ((m && m[1]) || "") + ((m && m[2]) || "");
      }
      const dir = win32Path.dirname(p);
      const base = win32Path.basename(p);
      const ext = win32Path.extname(p);
      const name = ext ? base.slice(0, base.length - ext.length) : base;
      return { root, dir: dir === "." && !/^\.[\\/]/.test(p) && p !== "." ? "" : dir, base, ext, name };
    },
    format(pathObject) {
      if (!pathObject || typeof pathObject !== "object") {
        const err = new TypeError(`The "pathObject" argument must be of type Object. Received ${pathObject === null ? "null" : typeof pathObject}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      const dir = pathObject.dir || pathObject.root || "";
      const extRaw = pathObject.ext ? String(pathObject.ext) : "";
      const ext = extRaw ? (extRaw.startsWith(".") ? extRaw : "." + extRaw) : "";
      const base = pathObject.base || (pathObject.name || "") + ext;
      if (!dir) return base;
      return dir === pathObject.root || /[\\/]$/.test(dir) ? dir + base : dir + "\\" + base;
    },
    toNamespacedPath(p) {
      if (typeof p !== "string" || p.length === 0) return p;
      const resolved = win32Path.resolve(p);
      if (resolved.length <= 2) return p;
      if (resolved.startsWith("\\\\?\\") || resolved.startsWith("\\\\.\\")) return p;
      if (resolved.startsWith("\\\\")) return "\\\\?\\UNC\\" + resolved.slice(2);
      if (/^[a-zA-Z]:\\/.test(resolved)) return "\\\\?\\" + resolved;
      return p;
    },
  };

  function globToRegExp(pattern, isWin) {
    let p = String(pattern);
    if (isWin) p = p.replace(/\\/g, "/");
    let re = "^";
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === "*") {
        if (p[i + 1] === "*") {
          if (p[i + 2] === "/") {
            re += "(?:.*/)?";
            i += 2;
          } else {
            re += ".*";
            i++;
          }
        } else {
          re += "[^/]*";
        }
      } else if (ch === "?") {
        re += "[^/]";
      } else if (ch === "{") {
        const close = p.indexOf("}", i);
        if (close > i) {
          const alts = p.slice(i + 1, close).split(",").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          re += `(?:${alts.join("|")})`;
          i = close;
        } else {
          re += "\\{";
        }
      } else if (/[.+^$()|[\]\\]/.test(ch)) {
        re += "\\" + ch;
      } else {
        re += ch;
      }
    }
    re += "$";
    return new RegExp(re, isWin ? "i" : "");
  }

  posixPath.matchesGlob = function matchesGlob(p, pattern) {
    if (typeof p !== "string") throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'path' argument must be of type string", TypeError);
    if (typeof pattern !== "string") throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'pattern' argument must be of type string", TypeError);
    return globToRegExp(pattern, false).test(p);
  };
  win32Path.matchesGlob = function matchesGlob(p, pattern) {
    if (typeof p !== "string") throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'path' argument must be of type string", TypeError);
    if (typeof pattern !== "string") throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'pattern' argument must be of type string", TypeError);
    return globToRegExp(pattern, true).test(p.replace(/\\/g, "/"));
  };

  posixPath.posix = posixPath;
  posixPath.win32 = win32Path;
  win32Path.posix = posixPath;
  win32Path.win32 = win32Path;

  const activePath = processObj.platform === "win32" ? Object.assign({}, win32Path) : Object.assign({}, posixPath);
  builtins["path"] = activePath;
  builtins["path/posix"] = posixPath;
  builtins["path/win32"] = win32Path;

  // =========================================================================
  // 9. URL & QueryString
  // =========================================================================

  function unescapePercentBuffer(s, decodeSpaces) {
    const str = String(s);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 0x2b && decodeSpaces) {
        out.push(0x20);
        continue;
      }
      if (c === 0x25 && i + 2 < str.length) {
        const hex = str.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      const enc = utf8Encode(str[i]);
      for (let j = 0; j < enc.length; j++) out.push(enc[j]);
    }
    return Buffer.from(out);
  }

  function safeDecodeURIComponent(str) {
    try {
      return decodeURIComponent(str);
    } catch (_) {
      return unescapePercentBuffer(str, false).toString("utf8");
    }
  }

  class URLSearchParams {
    constructor(initVal = "", ownerUrl = null) {
      this._entries = [];
      this._url = ownerUrl || null;
      if (typeof initVal === "string") {
        const s = initVal.startsWith("?") ? initVal.slice(1) : initVal;
        if (s) {
          for (const pair of s.split("&")) {
            if (!pair) continue;
            const eq = pair.indexOf("=");
            if (eq === -1) {
              this._entries.push([safeDecodeURIComponent(pair.replace(/\+/g, " ")), ""]);
            } else {
              this._entries.push([
                safeDecodeURIComponent(pair.slice(0, eq).replace(/\+/g, " ")),
                safeDecodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")),
              ]);
            }
          }
        }
      } else if (initVal instanceof URLSearchParams) {
        this._entries = initVal._entries.map(([k, v]) => [k, v]);
      } else if (initVal && typeof initVal[Symbol.iterator] === "function") {
        for (const pair of initVal) {
          if (!pair || typeof pair !== "object" || pair.length !== 2) {
            throw new TypeError("Each query pair must be an iterable [name, value] tuple");
          }
          this.append(pair[0], pair[1]);
        }
      } else if (initVal && typeof initVal === "object") {
        for (const [k, v] of Object.entries(initVal)) this.append(k, v);
      }
    }
    _markDirty() {
      if (this._url) this._url._rawSearch = null;
    }
    get size() { return this._entries.length; }
    append(name, value) {
      this._entries.push([String(name), String(value)]);
      this._markDirty();
    }
    delete(name, value) {
      const k = String(name);
      this._entries = this._entries.filter(([ek, ev]) => ek !== k || (value !== undefined && ev !== String(value)));
      this._markDirty();
    }
    get(name) {
      const k = String(name);
      const found = this._entries.find(([ek]) => ek === k);
      return found ? found[1] : null;
    }
    getAll(name) {
      const k = String(name);
      return this._entries.filter(([ek]) => ek === k).map(([, ev]) => ev);
    }
    has(name, value) {
      const k = String(name);
      return this._entries.some(([ek, ev]) => ek === k && (value === undefined || ev === String(value)));
    }
    set(name, value) {
      const k = String(name);
      const v = String(value);
      let first = true;
      const next = [];
      for (const entry of this._entries) {
        if (entry[0] === k) {
          if (first) {
            next.push([k, v]);
            first = false;
          }
        } else {
          next.push(entry);
        }
      }
      if (first) next.push([k, v]);
      this._entries = next;
      this._markDirty();
    }
    sort() {
      this._entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this._markDirty();
    }
    forEach(cb, thisArg) {
      for (const [k, v] of this._entries) cb.call(thisArg, v, k, this);
    }
    *entries() {
      for (const pair of this._entries) yield pair;
    }
    *keys() {
      for (const [k] of this._entries) yield k;
    }
    *values() {
      for (const [, v] of this._entries) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this._entries
        .map(([k, v]) => `${encodeFormURLEncoded(k)}=${encodeFormURLEncoded(v)}`)
        .join("&");
    }
  }

  function encodeFormURLEncoded(str) {
    const bytes = utf8Encode(String(str));
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x20) {
        out += "+";
      } else if (
        b === 0x2a || // *
        b === 0x2d || // -
        b === 0x2e || // .
        (b >= 0x30 && b <= 0x39) || // 0-9
        (b >= 0x41 && b <= 0x5a) || // A-Z
        b === 0x5f || // _
        (b >= 0x61 && b <= 0x7a) // a-z
      ) {
        out += String.fromCharCode(b);
      } else {
        out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
      }
    }
    return out;
  }

  const DEFAULT_SCHEME_PORTS = {
    "http:": "80",
    "https:": "443",
    "ws:": "80",
    "wss:": "443",
    "ftp:": "21",
  };

  const SPECIAL_URL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);

  function makeInvalidURLError(input) {
    const err = new TypeError(`Invalid URL: ${input}`);
    err.code = "ERR_INVALID_URL";
    err.input = String(input);
    return err;
  }

  function normalizeURLPathname(rawPath, isSpecial) {
    if (!rawPath) return isSpecial ? "/" : "";
    const input = isSpecial ? rawPath.replace(/\\/g, "/") : rawPath;
    if (!input.includes("/.") && !/%2e/i.test(input) && !input.includes("\\") && (!isSpecial || input.startsWith("/"))) {
      return input;
    }
    const parts = input.split("/");
    const out = [];
    let trailingSlash = input.endsWith("/");
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const lower = seg.toLowerCase();
      if (i === 0 && seg === "") continue;
      if (seg === "." || lower === "%2e") {
        trailingSlash = true;
        continue;
      }
      if (seg === ".." || lower === ".%2e" || lower === "%2e." || lower === "%2e%2e") {
        if (out.length > 1 || (out.length === 1 && !/^[a-zA-Z]:$/.test(out[0]))) {
          out.pop();
        }
        trailingSlash = true;
        continue;
      }
      if (seg === "" && i === parts.length - 1) {
        trailingSlash = true;
        continue;
      }
      out.push(seg);
      trailingSlash = false;
    }
    if (out.length === 0) return input.startsWith("/") || isSpecial ? "/" : "";
    const prefix = input.startsWith("/") || isSpecial ? "/" : "";
    return prefix + out.join("/") + (trailingSlash ? "/" : "");
  }

  function punycodeAdapt(delta, numPoints, firstTime) {
    delta = firstTime ? Math.floor(delta / 700) : (delta >> 1);
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > 455) {
      delta = Math.floor(delta / 35);
      k += 36;
    }
    return Math.floor(k + (36 * delta) / (delta + 38));
  }

  function punycodeEncodeLabel(label) {
    const lower = label.toLowerCase();
    let hasNonASCII = false;
    for (let i = 0; i < lower.length; i++) {
      if (lower.charCodeAt(i) >= 0x80) {
        hasNonASCII = true;
        break;
      }
    }
    if (!hasNonASCII) return lower;
    const cps = Array.from(lower, (ch) => ch.codePointAt(0));
    let out = "";
    for (const cp of cps) {
      if (cp < 0x80) out += String.fromCodePoint(cp);
    }
    const b = out.length;
    if (b > 0) out += "-";
    let n = 128;
    let delta = 0;
    let bias = 72;
    let h = b;
    while (h < cps.length) {
      let m = 0x10ffff + 1;
      for (const cp of cps) {
        if (cp >= n && cp < m) m = cp;
      }
      delta += (m - n) * (h + 1);
      n = m;
      for (const c of cps) {
        if (c < n) {
          delta++;
        } else if (c === n) {
          let q = delta;
          for (let k = 36; ; k += 36) {
            const t = k <= bias ? 1 : (k >= bias + 26 ? 26 : k - bias);
            if (q < t) break;
            const digit = t + ((q - t) % (36 - t));
            out += String.fromCharCode(digit < 26 ? 97 + digit : 22 + digit);
            q = Math.floor((q - t) / (36 - t));
          }
          out += String.fromCharCode(q < 26 ? 97 + q : 22 + q);
          bias = punycodeAdapt(delta, h + 1, h === b);
          delta = 0;
          h++;
        }
      }
      delta++;
      n++;
    }
    return "xn--" + out;
  }

  function punycodeDecodeLabel(label) {
    const lower = label.toLowerCase();
    if (!lower.startsWith("xn--")) return label;
    const input = lower.slice(4);
    const out = [];
    let delim = input.lastIndexOf("-");
    if (delim < 0) delim = 0;
    for (let j = 0; j < delim; j++) {
      out.push(input.charCodeAt(j));
    }
    let n = 128;
    let i = 0;
    let bias = 72;
    for (let idx = delim > 0 ? delim + 1 : 0; idx < input.length; ) {
      const oldi = i;
      let w = 1;
      for (let k = 36; ; k += 36) {
        if (idx >= input.length) return "";
        const cp = input.charCodeAt(idx++);
        const digit = cp - 48 < 10 ? cp - 22 : (cp - 65 < 26 ? cp - 65 : (cp - 97 < 26 ? cp - 97 : 36));
        if (digit >= 36) return "";
        i += digit * w;
        const t = k <= bias ? 1 : (k >= bias + 26 ? 26 : k - bias);
        if (digit < t) break;
        w *= (36 - t);
      }
      const outLen = out.length + 1;
      bias = punycodeAdapt(i - oldi, outLen, oldi === 0);
      n += Math.floor(i / outLen);
      i %= outLen;
      out.splice(i++, 0, n);
    }
    return String.fromCodePoint(...out);
  }

  function domainToASCII(domain) {
    const s = String(domain);
    if (!s) return "";
    try {
      return s
        .replace(/[\u3002\uff0e\uff61]/g, ".")
        .split(".")
        .map(punycodeEncodeLabel)
        .join(".");
    } catch (_) {
      return "";
    }
  }

  function domainToUnicode(domain) {
    const s = String(domain);
    if (!s) return "";
    try {
      return s
        .replace(/[\u3002\uff0e\uff61]/g, ".")
        .split(".")
        .map(punycodeDecodeLabel)
        .join(".");
    } catch (_) {
      return "";
    }
  }

  function encodeURLQuery(rawQuery, isSpecial) {
    if (!rawQuery) return "";
    let out = "";
    const bytes = utf8Encode(rawQuery);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (
        b <= 0x20 ||
        b >= 0x7f ||
        b === 0x22 || // "
        b === 0x23 || // #
        b === 0x3c || // <
        b === 0x3e || // >
        (isSpecial && b === 0x27) // '
      ) {
        out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
      } else {
        out += String.fromCharCode(b);
      }
    }
    return out;
  }

  function trimC0AndSpace(s) {
    let start = 0;
    let end = s.length;
    while (start < end && s.charCodeAt(start) <= 0x20) start++;
    while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
    let out = "";
    for (let i = start; i < end; i++) {
      const c = s.charCodeAt(i);
      if (c !== 9 && c !== 10 && c !== 13) out += s[i];
    }
    return out;
  }

  function hasC0OrDel(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f) return true;
    }
    return false;
  }

  function hasNonASCII(s) {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x7f) return true;
    }
    return false;
  }

  function encodeURLPath(rawPath) {
    if (!rawPath) return "";
    let out = "";
    const bytes = utf8Encode(rawPath);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (
        b <= 0x20 ||
        b >= 0x7f ||
        b === 0x22 || // "
        b === 0x23 || // #
        b === 0x3c || // <
        b === 0x3e || // >
        b === 0x3f || // ?
        b === 0x60 || // `
        b === 0x7b || // {
        b === 0x7d // }
      ) {
        out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
      } else {
        out += String.fromCharCode(b);
      }
    }
    return out;
  }

  function encodeURLFragment(rawFragment) {
    if (!rawFragment) return "";
    let out = "";
    const bytes = utf8Encode(rawFragment);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (
        b <= 0x20 ||
        b >= 0x7f ||
        b === 0x22 || // "
        b === 0x3c || // <
        b === 0x3e || // >
        b === 0x60 // `
      ) {
        out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
      } else {
        out += String.fromCharCode(b);
      }
    }
    return out;
  }

  function encodeURLUserInfo(rawUserInfo) {
    if (!rawUserInfo) return "";
    let out = "";
    const bytes = utf8Encode(rawUserInfo);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (
        b <= 0x20 ||
        b >= 0x7f ||
        b === 0x22 || // "
        b === 0x23 || // #
        b === 0x2f || // /
        b === 0x3a || // :
        b === 0x3b || // ;
        b === 0x3c || // <
        b === 0x3d || // =
        b === 0x3e || // >
        b === 0x3f || // ?
        b === 0x40 || // @
        (b >= 0x5b && b <= 0x5e) || // [ \ ] ^
        b === 0x60 || // `
        (b >= 0x7b && b <= 0x7d) // { | }
      ) {
        out += "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
      } else {
        out += String.fromCharCode(b);
      }
    }
    return out;
  }

  function parseIPv4Number(input) {
    if (input === "") return null;
    let r = 10;
    let s = input;
    if (s.length >= 2 && (s.startsWith("0x") || s.startsWith("0X"))) {
      s = s.slice(2);
      r = 16;
    } else if (s.length >= 2 && s.startsWith("0")) {
      s = s.slice(1);
      r = 8;
    }
    if (s === "") return 0;
    if (r === 10 && !/^[0-9]+$/.test(s)) return null;
    if (r === 16 && !/^[0-9a-fA-F]+$/.test(s)) return null;
    if (r === 8 && !/^[0-7]+$/.test(s)) return null;
    return parseInt(s, r);
  }

  function normalizeSpecialHost(rawHost, origInput) {
    const parts = rawHost.split(".");
    if (parts.length > 1 && parts[parts.length - 1] === "") {
      parts.pop();
    }
    const lastPart = parts[parts.length - 1];
    if (parseIPv4Number(lastPart) !== null || /^[0-9]+$/.test(lastPart) || /^0[xX][0-9a-fA-F]*$/.test(lastPart)) {
      if (parts.length > 4) throw makeInvalidURLError(origInput);
      const nums = [];
      for (let i = 0; i < parts.length; i++) {
        const n = parseIPv4Number(parts[i]);
        if (n === null || !Number.isFinite(n) || n < 0) {
          throw makeInvalidURLError(origInput);
        }
        nums.push(n);
      }
      for (let i = 0; i < nums.length - 1; i++) {
        if (nums[i] > 255) throw makeInvalidURLError(origInput);
      }
      if (nums[nums.length - 1] >= Math.pow(256, 5 - nums.length)) {
        throw makeInvalidURLError(origInput);
      }
      let ipv4 = nums[nums.length - 1];
      for (let i = 0; i < nums.length - 1; i++) {
        ipv4 += nums[i] * Math.pow(256, 3 - i);
      }
      const b0 = Math.floor(ipv4 / 16777216) & 0xff;
      const b1 = Math.floor(ipv4 / 65536) & 0xff;
      const b2 = Math.floor(ipv4 / 256) & 0xff;
      const b3 = ipv4 & 0xff;
      return `${b0}.${b1}.${b2}.${b3}`;
    }
    return rawHost;
  }

  class URL {
    constructor(input, base) {
      let str = trimC0AndSpace(String(input));
      if (hasC0OrDel(str)) {
        throw makeInvalidURLError(input);
      }
      if (base !== undefined) {
        const b = base instanceof URL ? base : new URL(base);
        const bAuth = b.username ? `${b.username}${b.password ? ":" + b.password : ""}@` : "";
        if (str === "") {
          str = `${b.protocol}//${bAuth}${b.host}${b.pathname}${b.search}`;
        } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str)) {
          if (SPECIAL_URL_SCHEMES.has(b.protocol)) {
            str = str.replace(/\\/g, "/");
          }
          if (str.startsWith("//")) {
            str = b.protocol + str;
          } else if (str.startsWith("/")) {
            str = `${b.protocol}//${bAuth}${b.host}${str}`;
          } else if (str.startsWith("?")) {
            str = `${b.protocol}//${bAuth}${b.host}${b.pathname}${str}`;
          } else if (str.startsWith("#")) {
            str = `${b.protocol}//${bAuth}${b.host}${b.pathname}${b.search}${str}`;
          } else {
            let relPath = str;
            let relSuffix = "";
            const qOrH = str.search(/[?#]/);
            if (qOrH >= 0) {
              relPath = str.slice(0, qOrH);
              relSuffix = str.slice(qOrH);
            }
            const baseDir = b.pathname.endsWith("/") ? b.pathname : posixPath.dirname(b.pathname);
            const joined = relPath ? posixPath.join(baseDir, relPath) : b.pathname;
            const trailing = relPath.endsWith("/") || relPath === "." || relPath === ".." || relPath.endsWith("/.") || relPath.endsWith("/..");
            let normJoined = joined.startsWith("/") ? joined : "/" + joined;
            if (trailing && !normJoined.endsWith("/")) normJoined += "/";
            str = `${b.protocol}//${bAuth}${b.host}${normJoined}${relSuffix}`;
          }
        }
      }
      const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(str);
      if (!schemeMatch) throw makeInvalidURLError(input);
      const proto = schemeMatch[1].toLowerCase();
      const isSpecial = SPECIAL_URL_SCHEMES.has(proto);
      let restAfterScheme = schemeMatch[2];
      if (proto === "file:") {
        restAfterScheme = restAfterScheme.replace(/\\/g, "/");
        if (restAfterScheme.startsWith("///")) {
          restAfterScheme = "///" + restAfterScheme.slice(3);
        } else if (/^\/\/[a-zA-Z]:(?=\/|$)/.test(restAfterScheme)) {
          restAfterScheme = "/" + restAfterScheme;
        } else if (restAfterScheme.startsWith("/") && !restAfterScheme.startsWith("//")) {
          restAfterScheme = "//" + restAfterScheme;
        } else if (!restAfterScheme.startsWith("//")) {
          restAfterScheme = "///" + restAfterScheme;
        }
      } else if (isSpecial) {
        restAfterScheme = restAfterScheme.replace(/^[/\\]*/, "//");
      }
      const normalizedStr = proto + restAfterScheme;
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[0-9a-fA-F:.]+\]|[^:/?#\\]*)(?::([^/?#\\]*))?)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(normalizedStr);
      if (!m) throw makeInvalidURLError(input);
      this._protocol = proto;
      this._username = m[2] ? encodeURLUserInfo(m[2]) : "";
      this._password = m[3] ? encodeURLUserInfo(m[3]) : "";
      let rawHost = m[4] || "";
      if (isSpecial && proto !== "file:" && !rawHost) {
        throw makeInvalidURLError(input);
      }
      if (rawHost) {
        if (rawHost.startsWith("[")) {
          if (!/^\[[0-9a-fA-F:]+\]$/.test(rawHost)) throw makeInvalidURLError(input);
        } else {
          if (isSpecial) {
            rawHost = safeDecodeURIComponent(rawHost);
          }
          if (hasNonASCII(rawHost)) {
            rawHost = domainToASCII(rawHost);
          }
          if (hasC0OrDel(rawHost) || /[ #%/:<>?@[\\\]^|]/.test(rawHost) || /%(?![0-9a-fA-F]{2})/.test(rawHost)) {
            throw makeInvalidURLError(input);
          }
          if (isSpecial) {
            rawHost = normalizeSpecialHost(rawHost, input);
          }
        }
      }
      this._hostname = rawHost.toLowerCase();
      if (proto === "file:" && this._hostname === "localhost") {
        this._hostname = "";
      }
      const rawPort = m[5] || "";
      if (rawPort !== "") {
        if (!/^[0-9]+$/.test(rawPort) || Number(rawPort) > 65535) {
          throw makeInvalidURLError(input);
        }
      }
      const canonPort = rawPort !== "" ? String(Number(rawPort)) : "";
      this._port = DEFAULT_SCHEME_PORTS[this._protocol] === canonPort ? "" : canonPort;
      const rawPath = m[6] || (this._hostname || isSpecial ? "/" : "");
      this._pathname = normalizeURLPathname(encodeURLPath(rawPath), isSpecial);
      this._rawSearch = m[7] !== undefined && m[7] !== "" ? "?" + encodeURLQuery(m[7], isSpecial) : "";
      this._searchParams = new URLSearchParams(m[7] || "", this);
      this._hash = m[8] ? "#" + encodeURLFragment(m[8]) : "";
    }
    get protocol() {
      return this._protocol;
    }
    set protocol(v) {
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*)/.exec(String(v).trim());
      if (m) {
        this._protocol = m[1].toLowerCase() + ":";
        if (DEFAULT_SCHEME_PORTS[this._protocol] === this._port) this._port = "";
      }
    }
    get username() {
      return this._username;
    }
    set username(v) {
      if (this._protocol === "file:" || !this._hostname) return;
      this._username = encodeURLUserInfo(String(v));
    }
    get password() {
      return this._password;
    }
    set password(v) {
      if (this._protocol === "file:" || !this._hostname) return;
      this._password = encodeURLUserInfo(String(v));
    }
    get hostname() {
      return this._hostname;
    }
    set hostname(v) {
      let rawHost = String(v).trim();
      if (!rawHost) {
        if (!SPECIAL_URL_SCHEMES.has(this._protocol) || this._protocol === "file:") {
          this._hostname = "";
        }
        return;
      }
      if (rawHost.startsWith("[")) {
        if (/^\[[0-9a-fA-F:]+\]$/.test(rawHost)) {
          this._hostname = rawHost.toLowerCase();
        }
        return;
      }
      const colonIdx = rawHost.indexOf(":");
      if (colonIdx >= 0) rawHost = rawHost.slice(0, colonIdx);
      if (hasNonASCII(rawHost)) {
        rawHost = domainToASCII(safeDecodeURIComponent(rawHost));
      }
      if (!rawHost || hasC0OrDel(rawHost) || /[ #%/:<>?@[\\\]^|]/.test(rawHost) || /%(?![0-9a-fA-F]{2})/.test(rawHost)) {
        return;
      }
      this._hostname = rawHost.toLowerCase();
    }
    get pathname() {
      return this._pathname;
    }
    set pathname(v) {
      const isSpecial = SPECIAL_URL_SCHEMES.has(this._protocol);
      this._pathname = normalizeURLPathname(encodeURLPath(String(v)), isSpecial);
    }
    get hash() {
      return this._hash;
    }
    set hash(v) {
      const s = String(v || "");
      const raw = s.startsWith("#") ? s.slice(1) : s;
      this._hash = raw ? "#" + encodeURLFragment(raw) : "";
    }
    get port() {
      return this._port;
    }
    set port(v) {
      const s = String(v).trim();
      if (s === "") {
        this._port = "";
        return;
      }
      const m = /^([0-9]+)/.exec(s);
      if (!m) return;
      const num = Number(m[1]);
      if (!Number.isInteger(num) || num < 0 || num > 65535) return;
      const canon = String(num);
      this._port = DEFAULT_SCHEME_PORTS[this.protocol] === canon ? "" : canon;
    }
    get host() {
      return this.port ? `${this.hostname}:${this.port}` : this.hostname;
    }
    set host(v) {
      const s = String(v);
      if (s.startsWith("[")) {
        const closeIdx = s.indexOf("]");
        if (closeIdx >= 0) {
          this.hostname = s.slice(0, closeIdx + 1).toLowerCase();
          if (s.charAt(closeIdx + 1) === ":") {
            this.port = s.slice(closeIdx + 2);
          }
          return;
        }
      }
      const idx = s.indexOf(":");
      if (idx >= 0) {
        this.hostname = s.slice(0, idx).toLowerCase();
        this.port = s.slice(idx + 1);
      } else {
        this.hostname = s.toLowerCase();
      }
    }
    get origin() {
      if (this.protocol === "blob:") {
        try {
          return new URL(this.pathname).origin;
        } catch (_) {
          return "null";
        }
      }
      if (!SPECIAL_URL_SCHEMES.has(this.protocol) || this.protocol === "file:") return "null";
      return `${this.protocol}//${this.host}`;
    }
    get search() {
      if (this._rawSearch !== null && this._rawSearch !== undefined) {
        return this._rawSearch;
      }
      const s = this._searchParams.toString();
      return s ? "?" + s : "";
    }
    set search(v) {
      const s = String(v || "");
      const raw = s.startsWith("?") ? s.slice(1) : s;
      this._rawSearch = raw ? "?" + encodeURLQuery(raw, SPECIAL_URL_SCHEMES.has(this.protocol)) : "";
      const nextParams = new URLSearchParams(raw);
      if (this._searchParams) {
        this._searchParams._entries = nextParams._entries;
        this._searchParams._url = this;
      } else {
        this._searchParams = nextParams;
        this._searchParams._url = this;
      }
    }
    get searchParams() {
      return this._searchParams;
    }
    get href() {
      const auth = this.username ? `${this.username}${this.password ? ":" + this.password : ""}@` : "";
      const hasSlashes = this.hostname || this.protocol === "file:" || this.protocol === "http:" || this.protocol === "https:";
      return `${this.protocol}${hasSlashes ? "//" : ""}${auth}${this.host}${this.pathname}${this.search}${this.hash}`;
    }
    set href(v) {
      const parsed = new URL(v);
      this._protocol = parsed._protocol;
      this._username = parsed._username;
      this._password = parsed._password;
      this._hostname = parsed._hostname;
      this._port = parsed._port;
      this._pathname = parsed._pathname;
      this._rawSearch = parsed._rawSearch;
      if (this._searchParams && parsed._searchParams) {
        this._searchParams._entries = parsed._searchParams._entries;
        this._searchParams._url = this;
      } else {
        this._searchParams = parsed._searchParams;
        if (this._searchParams) this._searchParams._url = this;
      }
      this._hash = parsed._hash;
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
    static canParse(input, base) {
      try {
        new URL(input, base);
        return true;
      } catch (_) {
        return false;
      }
    }
    static parse(input, base) {
      try {
        return new URL(input, base);
      } catch (_) {
        return null;
      }
    }
    static createObjectURL(blob) {
      if (!(blob instanceof Blob)) {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"obj\" argument must be an instance of Blob", TypeError);
      }
      const id = hostCall("crypto.randomUUID", "");
      const urlStr = `blob:nodedata:${id}`;
      blobObjectURLMap.set(urlStr, blob);
      return urlStr;
    }
    static revokeObjectURL(urlStr) {
      blobObjectURLMap.delete(String(urlStr));
    }
  }
  const blobObjectURLMap = new Map();

  globalThis.URLSearchParams = URLSearchParams;
  globalThis.URL = URL;

  function fileURLToPath(u) {
    const urlObj = u instanceof URL ? u : new URL(u);
    if (urlObj.protocol !== "file:") {
      const err = new TypeError("The URL must be of scheme file");
      err.code = "ERR_INVALID_URL_SCHEME";
      throw err;
    }
    const rawPathname = urlObj.pathname || "";
    if (processObj.platform === "win32") {
      if (/%2f|%5c/i.test(rawPathname)) {
        const err = new TypeError("File URL path must not include encoded \\ or / characters");
        err.code = "ERR_INVALID_FILE_URL_PATH";
        throw err;
      }
      const p = decodeURIComponent(rawPathname);
      if (urlObj.hostname !== "" && urlObj.hostname !== "localhost") {
        return "\\\\" + domainToUnicode(urlObj.hostname) + p.replace(/\//g, "\\");
      }
      if (!/^\/[a-zA-Z]:(?:\/|$)/.test(p)) {
        const err = new TypeError("File URL path must be absolute");
        err.code = "ERR_INVALID_FILE_URL_PATH";
        throw err;
      }
      return p.slice(1).replace(/\//g, "\\");
    }
    if (urlObj.hostname !== "" && urlObj.hostname !== "localhost") {
      const err = new TypeError(`File URL host must be "localhost" or empty on ${processObj.platform}`);
      err.code = "ERR_INVALID_FILE_URL_HOST";
      throw err;
    }
    if (/%2f/i.test(rawPathname)) {
      const err = new TypeError("File URL path must not include encoded / characters");
      err.code = "ERR_INVALID_FILE_URL_PATH";
      throw err;
    }
    return decodeURIComponent(rawPathname);
  }

  function pathToFileURL(p) {
    const rawP = String(p);
    const hasTrailingSep = rawP.endsWith("/") || (processObj.platform === "win32" && rawP.endsWith("\\"));
    if (processObj.platform === "win32" && (rawP.startsWith("\\\\") || rawP.startsWith("//"))) {
      const norm = rawP.replace(/\\/g, "/").replace(/^\/+/, "");
      const parts = norm.split("/");
      const server = parts[0] || "";
      const rest = parts.slice(1).map((seg) => encodeURIComponent(seg)).join("/");
      return new URL(`file://${server}/${rest}`);
    }
    let resolved = activePath.resolve(rawP).replace(/\\/g, "/");
    if (!resolved.startsWith("/")) resolved = "/" + resolved;
    let encoded = resolved
      .split("/")
      .map((seg, i) => (i === 1 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
      .join("/");
    if (hasTrailingSep && !encoded.endsWith("/")) encoded += "/";
    return new URL("file://" + encoded);
  }

  const querystringMod = {
    parse(str, sep, eq, options) {
      sep = sep || "&";
      eq = eq || "=";
      const maxKeys = options && typeof options.maxKeys === "number" ? options.maxKeys : 1000;
      const decodeFn = options && typeof options.decodeURIComponent === "function" ? options.decodeURIComponent : querystringMod.unescape;
      const out = Object.create(null);
      if (typeof str !== "string" || str.length === 0) return out;
      const parts = str.split(sep);
      const limit = maxKeys > 0 ? Math.min(parts.length, maxKeys) : parts.length;
      for (let i = 0; i < limit; i++) {
        const part = parts[i];
        if (!part) continue;
        const idx = part.indexOf(eq);
        const rawK = idx >= 0 ? part.slice(0, idx) : part;
        const rawV = idx >= 0 ? part.slice(idx + eq.length) : "";
        let k;
        let v;
        try {
          k = decodeFn(rawK.replace(/\+/g, " "));
        } catch (_) {
          k = safeDecodeURIComponent(rawK.replace(/\+/g, " "));
        }
        try {
          v = decodeFn(rawV.replace(/\+/g, " "));
        } catch (_) {
          v = safeDecodeURIComponent(rawV.replace(/\+/g, " "));
        }
        if (k in out) {
          if (Array.isArray(out[k])) out[k].push(v);
          else out[k] = [out[k], v];
        } else {
          out[k] = v;
        }
      }
      return out;
    },
    stringify(obj, sep, eq, options) {
      sep = sep || "&";
      eq = eq || "=";
      const encodeFn = options && typeof options.encodeURIComponent === "function" ? options.encodeURIComponent : querystringMod.escape;
      if (!obj || typeof obj !== "object") return "";
      const stringifyPrimitive = (v) => {
        if (typeof v === "string") return v;
        if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
        if (typeof v === "bigint") return String(v);
        if (typeof v === "boolean") return v ? "true" : "false";
        return "";
      };
      const pairs = [];
      for (const [k, v] of Object.entries(obj)) {
        const ek = encodeFn(stringifyPrimitive(k));
        if (Array.isArray(v)) {
          for (const item of v) pairs.push(`${ek}${eq}${encodeFn(stringifyPrimitive(item))}`);
        } else {
          pairs.push(`${ek}${eq}${encodeFn(stringifyPrimitive(v))}`);
        }
      }
      return pairs.join(sep);
    },
    escape: encodeURIComponent,
    unescape: (s) => safeDecodeURIComponent(String(s)),
    unescapeBuffer: (s, decodeSpaces) => unescapePercentBuffer(s, Boolean(decodeSpaces)),
  };
  querystringMod.decode = querystringMod.parse;
  querystringMod.encode = querystringMod.stringify;
  builtins["querystring"] = querystringMod;

  builtins["url"] = {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse(urlStr, parseQueryString = false, slashesDenoteHost = false) {
      if (typeof urlStr !== "string") {
        const err = new TypeError(`The "url" argument must be of type string. Received ${urlStr === null ? "null" : typeof urlStr}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      try {
        const stripBrackets = (hn) => (hn && hn.startsWith("[") && hn.endsWith("]") ? hn.slice(1, -1) : hn);
        if (slashesDenoteHost && urlStr.startsWith("//") && !urlStr.startsWith("///")) {
          const u = new URL("http:" + urlStr);
          return {
            protocol: null,
            slashes: true,
            auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
            host: u.host || null,
            port: u.port || null,
            hostname: stripBrackets(u.hostname) || null,
            hash: u.hash || null,
            search: u.search || null,
            query: parseQueryString ? querystringMod.parse(u.search.slice(1)) : (u.search ? u.search.slice(1) : null),
            pathname: u.pathname || null,
            path: (u.pathname || "") + u.search,
            href: urlStr,
          };
        }
        const nonSlashScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?!\/)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(urlStr);
        if (nonSlashScheme && !SPECIAL_URL_SCHEMES.has(nonSlashScheme[1].toLowerCase())) {
          const proto = nonSlashScheme[1].toLowerCase();
          const opaque = nonSlashScheme[2] || "";
          const rawQ = nonSlashScheme[3];
          const rawH = nonSlashScheme[4];
          const search = rawQ !== undefined ? "?" + rawQ : null;
          const hash = rawH !== undefined ? "#" + rawH : null;
          if (proto === "mailto:" && opaque.includes("@")) {
            const atIdx = opaque.indexOf("@");
            const auth = opaque.slice(0, atIdx);
            const hostPart = opaque.slice(atIdx + 1);
            return {
              protocol: proto,
              slashes: null,
              auth: auth || null,
              host: hostPart.toLowerCase() || null,
              port: null,
              hostname: stripBrackets(hostPart.toLowerCase()) || null,
              hash,
              search,
              query: parseQueryString ? querystringMod.parse(rawQ || "") : (rawQ !== undefined ? rawQ : null),
              pathname: null,
              path: search,
              href: `${proto}${auth ? auth + "@" : ""}${hostPart.toLowerCase()}${search || ""}${hash || ""}`,
            };
          }
        }
        const u = new URL(urlStr, "http://localhost");
        const isRel = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlStr);
        return {
          protocol: isRel ? null : u.protocol,
          slashes: !isRel,
          auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
          host: isRel ? null : u.host,
          port: isRel ? null : u.port || null,
          hostname: isRel ? null : stripBrackets(u.hostname),
          hash: u.hash || null,
          search: u.search || null,
          query: parseQueryString ? querystringMod.parse(u.search.slice(1)) : u.search.slice(1) || null,
          pathname: u.pathname,
          path: u.pathname + u.search,
          href: isRel ? u.pathname + u.search + u.hash : u.href,
        };
      } catch (_) {
        return { pathname: urlStr, path: urlStr, href: urlStr };
      }
    },
    format(urlObj) {
      if (typeof urlObj === "string") return urlObj;
      if (urlObj instanceof URL) return urlObj.href;
      const proto = urlObj.protocol ? (urlObj.protocol.endsWith(":") ? urlObj.protocol : urlObj.protocol + ":") : "";
      const rawAuth = urlObj.auth || (urlObj.username ? (urlObj.password ? `${urlObj.username}:${urlObj.password}` : urlObj.username) : "");
      const auth = rawAuth ? `${String(rawAuth).replace(/@/g, "%40")}@` : "";
      const host = urlObj.host || (urlObj.hostname ? (urlObj.port ? `${urlObj.hostname}:${urlObj.port}` : urlObj.hostname) : "");
      const pathname = urlObj.pathname || "";
      const search = urlObj.search || (urlObj.query ? "?" + querystringMod.stringify(urlObj.query) : "");
      const hash = urlObj.hash ? (urlObj.hash.startsWith("#") ? urlObj.hash : "#" + urlObj.hash) : "";
      return `${proto}${proto && (host || urlObj.slashes) ? "//" : ""}${auth}${host}${pathname}${search}${hash}`;
    },
    resolve(from, to) {
      if (typeof from !== "string") {
        const err = new TypeError(`The "from" argument must be of type string. Received ${from === null ? "null" : typeof from}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (typeof to !== "string") {
        const err = new TypeError(`The "to" argument must be of type string. Received ${to === null ? "null" : typeof to}`);
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      const resolvedUrl = new URL(to, new URL(from, "http://__resolve_base__.invalid"));
      if (resolvedUrl.protocol === "http:" && resolvedUrl.hostname === "__resolve_base__.invalid") {
        const { pathname, search, hash } = resolvedUrl;
        if (!from.startsWith("/") && !to.startsWith("/") && pathname.startsWith("/")) {
          return pathname.slice(1) + search + hash;
        }
        return pathname + search + hash;
      }
      return resolvedUrl.href;
    },
    domainToASCII,
    domainToUnicode,
    urlToHttpOptions(u) {
      if (!(u instanceof URL)) {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"url\" argument must be an instance of URL", TypeError);
      }
      const options = {
        protocol: u.protocol,
        hostname: u.hostname && u.hostname.startsWith("[") && u.hostname.endsWith("]") ? u.hostname.slice(1, -1) : u.hostname,
        hash: u.hash,
        search: u.search,
        pathname: u.pathname,
        path: `${u.pathname || ""}${u.search || ""}`,
        href: u.href,
      };
      if (u.port !== "") {
        options.port = Number(u.port);
      }
      if (u.username || u.password) {
        options.auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      }
      return options;
    },
  };

  // =========================================================================
  // 10. Stream & StringDecoder
  // =========================================================================

  class Stream extends EventEmitter {
    pipe(dest, options = {}) {
      const onData = (chunk) => {
        if (typeof dest.write === "function") {
          const ret = dest.write(chunk);
          if (ret === false && typeof this.pause === "function") {
            this.pause();
          }
        }
      };
      const onDrain = () => {
        if (typeof this.resume === "function") {
          this.resume();
        }
      };
      if (typeof dest.on === "function") {
        dest.on("drain", onDrain);
      }
      if (!options || options.end !== false) {
        if (this.readableEnded || this._endEmitted) {
          queueMicrotask(() => {
            if (typeof dest.off === "function") dest.off("drain", onDrain);
            if (typeof dest.end === "function") dest.end();
          });
        } else {
          this.once("end", () => {
            if (typeof dest.off === "function") dest.off("drain", onDrain);
            if (typeof dest.end === "function") dest.end();
          });
        }
      }
      this.on("data", onData);
      if (!this._pipes) this._pipes = [];
      this._pipes.push({ dest, onData, onDrain });
      if (typeof dest.emit === "function") dest.emit("pipe", this);
      return dest;
    }
    unpipe(dest) {
      if (!this._pipes) return this;
      this._pipes = this._pipes.filter((p) => {
        if (!dest || p.dest === dest) {
          this.off("data", p.onData);
          if (typeof p.dest.off === "function") p.dest.off("drain", p.onDrain);
          if (typeof p.dest.emit === "function") p.dest.emit("unpipe", this);
          return false;
        }
        return true;
      });
      if (this._pipes.length === 0 && typeof this.pause === "function") {
        this.pause();
      }
      return this;
    }
  }

  class Readable extends Stream {
    constructor(options = {}) {
      super();
      options = options || {};
      this.readable = true;
      this.readableEnded = false;
      this.destroyed = false;
      this._objectMode = Boolean(options.objectMode || options.readableObjectMode);
      this.readableObjectMode = this._objectMode;
      this._buffer = [];
      this._eofPushed = false;
      this._endEmitted = false;
      this._readCalledAtEOF = false;
      this._flowing = false;
      this._pausedExplicitly = false;
      this._draining = false;
      this._encoding = options.encoding || null;
      this._decoder = this._encoding ? new StringDecoder(this._encoding) : null;
      const defaultHWM = this._objectMode ? 16 : 16384;
      const rawHWM = options.readableHighWaterMark !== undefined ? options.readableHighWaterMark : options.highWaterMark;
      this.readableHighWaterMark = rawHWM !== undefined ? Math.max(0, Number(rawHWM)) : defaultHWM;
      if (typeof options.read === "function") this._read = options.read;
      if (typeof options.destroy === "function") this._destroy = options.destroy;
    }
    _read() {}
    _chunkByteLength(item) {
      if (item === null || item === undefined) return 0;
      if (this._objectMode) return 1;
      if (typeof item === "string") return Buffer.byteLength(item, this._encoding || "utf8");
      if (typeof item.byteLength === "number") return item.byteLength;
      if (typeof item.length === "number") return item.length;
      return 1;
    }
    get readableLength() {
      if (this._objectMode) return this._buffer.length;
      let total = 0;
      for (let i = 0; i < this._buffer.length; i++) {
        total += this._chunkByteLength(this._buffer[i]);
      }
      return total;
    }
    get readableFlowing() {
      return this._flowing;
    }
    _isFlowing() {
      return this._flowing || (!this._pausedExplicitly && this.listenerCount("data") > 0);
    }
    setEncoding(enc) {
      this._encoding = enc;
      this._decoder = enc ? new StringDecoder(enc) : null;
      return this;
    }
    _formatChunk(item) {
      if (this._objectMode) return item;
      if (this._decoder && (Buffer.isBuffer(item) || item instanceof Uint8Array)) {
        return this._decoder.write(item);
      }
      if (this._encoding && Buffer.isBuffer(item)) {
        return item.toString(this._encoding);
      }
      return item;
    }
    _flushDecoderEOF() {
      if (!this._objectMode && this._decoder) {
        const rem = this._decoder.end();
        if (rem) return rem;
      }
      return null;
    }
    _scheduleDrain() {
      if (this._draining || this.destroyed) return;
      const hasDataListeners = this._isFlowing();
      const hasReadableListeners = this.listenerCount("readable") > 0;
      const canEmitEnd =
        this._eofPushed &&
        this._buffer.length === 0 &&
        !this._endEmitted &&
        (hasDataListeners || hasReadableListeners || this.listenerCount("end") > 0 || this._readCalledAtEOF);
      if (!hasDataListeners && !hasReadableListeners && !canEmitEnd) return;
      this._draining = true;
      queueMicrotask(() => this._drain());
    }
    _drain() {
      this._draining = false;
      if (this.destroyed) return;
      while (this._isFlowing() && !this.destroyed) {
        if (this._buffer.length === 0 && !this._eofPushed) {
          this._inRead = true;
          try {
            this._read(this.readableHighWaterMark);
          } finally {
            this._inRead = false;
          }
          if (this._buffer.length === 0) break;
        }
        if (this._buffer.length === 0) break;
        while (this._buffer.length > 0 && this._isFlowing() && !this.destroyed) {
          const item = this._buffer.shift();
          if (typeof this._onPull === "function") this._onPull(1);
          const formatted = this._formatChunk(item);
          if (this._objectMode || formatted !== "" || !this._decoder) {
            this.emit("data", formatted);
          }
        }
      }
      if (!this._isFlowing() && this.listenerCount("readable") > 0 && !this.destroyed) {
        if (this._buffer.length === 0 && !this._eofPushed) {
          this._inRead = true;
          try {
            this._read(this.readableHighWaterMark);
          } finally {
            this._inRead = false;
          }
        }
        if (this._buffer.length > 0 || (this._eofPushed && !this._endEmitted && !this._readableEOFEmitted)) {
          if (this._eofPushed && this._buffer.length === 0) {
            this._readableEOFEmitted = true;
          }
          this.emit("readable");
        }
      }
      if (
        this._eofPushed &&
        this._buffer.length === 0 &&
        !this._endEmitted &&
        !this.destroyed &&
        (this._isFlowing() || this.listenerCount("end") > 0 || this._readCalledAtEOF || this._readableEOFEmitted)
      ) {
        const rem = this._flushDecoderEOF();
        if (rem) {
          this.emit("data", rem);
        }
        this._endEmitted = true;
        this.readableEnded = true;
        this.emit("end");
        if (!this._isDuplex || this.writableFinished) {
          if (!this._closeEmitted) {
            this._closeEmitted = true;
            this.emit("close");
          }
        }
      }
    }
    push(chunk, encoding) {
      if (this.destroyed) return false;
      if (chunk === null) {
        this._eofPushed = true;
        this._scheduleDrain();
        return false;
      }
      if (this._eofPushed) {
        return false;
      }
      const item = !this._objectMode && typeof chunk === "string" && !this._encoding ? Buffer.from(chunk, encoding) : chunk;
      if (this._isFlowing() && this._buffer.length === 0 && !this._inRead) {
        const formatted = this._formatChunk(item);
        if (this._objectMode || formatted !== "" || !this._decoder) {
          this.emit("data", formatted);
        }
        if (this._buffer.length === 0 && typeof this._onPull === "function") {
          this._onPull(1);
        }
        return this._isFlowing() && this.readableLength < this.readableHighWaterMark;
      }
      this._buffer.push(item);
      if (!this._pausedExplicitly && this.readableLength < this.readableHighWaterMark && typeof this._onPull === "function") {
        this._onPull(1);
      }
      this._scheduleDrain();
      return this.readableLength < this.readableHighWaterMark;
    }
    read(size) {
      if (size === 0) return null;
      if (!this._eofPushed && this._buffer.length === 0) this._read(this.readableHighWaterMark);
      if (this._buffer.length > 0) {
        let item;
        if (!this._objectMode && size !== undefined && size !== null && Number(size) > 0 && !this._encoding && Buffer.isBuffer(this._buffer[0])) {
          const want = Math.floor(Number(size));
          if (!this._eofPushed && this.readableLength < want) {
            this._read(this.readableHighWaterMark);
            if (!this._eofPushed && this.readableLength < want) {
              return null;
            }
          }
          if (this._buffer[0].length > want) {
            item = this._buffer[0].subarray(0, want);
            this._buffer[0] = this._buffer[0].subarray(want);
          } else if (this._buffer[0].length === want || this._buffer.length === 1) {
            item = this._buffer.shift();
            if (typeof this._onPull === "function") this._onPull(1);
          } else {
            const parts = [];
            let rem = want;
            let pulled = 0;
            while (rem > 0 && this._buffer.length > 0 && Buffer.isBuffer(this._buffer[0])) {
              const head = this._buffer[0];
              if (head.length <= rem) {
                parts.push(this._buffer.shift());
                pulled++;
                rem -= head.length;
              } else {
                parts.push(head.subarray(0, rem));
                this._buffer[0] = head.subarray(rem);
                rem = 0;
              }
            }
            if (pulled > 0 && typeof this._onPull === "function") this._onPull(pulled);
            item = Buffer.concat(parts);
          }
        } else {
          item = this._buffer.shift();
          if (typeof this._onPull === "function") this._onPull(1);
        }
        if (this._eofPushed && this._buffer.length === 0) {
          this._readCalledAtEOF = true;
          this._scheduleDrain();
        }
        return this._formatChunk(item);
      }
      if (this._eofPushed) {
        this._readCalledAtEOF = true;
        const rem = this._flushDecoderEOF();
        if (rem) {
          this._scheduleDrain();
          return rem;
        }
        this._scheduleDrain();
      }
      return null;
    }
    on(ev, fn) {
      super.on(ev, fn);
      if (ev === "data") {
        this._pausedExplicitly = false;
        this._flowing = true;
        this._scheduleDrain();
      } else if (ev === "readable") {
        this._scheduleDrain();
      } else if (ev === "end" && this._eofPushed && this._buffer.length === 0 && !this._endEmitted) {
        this._scheduleDrain();
      }
      return this;
    }
    once(ev, fn) {
      return super.once(ev, fn);
    }
    resume() {
      this._pausedExplicitly = false;
      this._flowing = true;
      this._scheduleDrain();
      return this;
    }
    pause() {
      this._pausedExplicitly = true;
      this._flowing = false;
      return this;
    }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      if (err) this._errored = err;
      const emitEnd = (destroyErr) => {
        const finalErr = destroyErr !== undefined ? destroyErr : err;
        if (finalErr) {
          this._errored = finalErr;
          if (!((finalErr._fromReqAbort || this._erroredConsumed || this._destroyedFromReq) && this.listenerCount("error") === 0)) {
            this.emit("error", finalErr);
          }
        }
        if (!this._closeEmitted) {
          this._closeEmitted = true;
          this.emit("close", Boolean(finalErr));
        }
      };
      if (typeof this._destroy === "function") {
        try {
          let called = false;
          this._destroy(err || null, (cbErr) => {
            if (called) return;
            called = true;
            processObj.nextTick(() => emitEnd(cbErr !== undefined ? cbErr : err));
          });
          return this;
        } catch (syncErr) {
          processObj.nextTick(() => emitEnd(syncErr));
          return this;
        }
      }
      processObj.nextTick(() => emitEnd(err));
      return this;
    }
    static from(iterable, options) {
      if (iterable === null || iterable === undefined || (typeof iterable[Symbol.iterator] !== "function" && typeof iterable[Symbol.asyncIterator] !== "function")) {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"iterable\" argument must be an instance of Iterable or AsyncIterable", TypeError);
      }
      const opts = Object.assign({ objectMode: true }, options);
      let iterator = null;
      let reading = false;
      const r = new Readable(
        Object.assign({}, opts, {
          async read() {
            if (reading || this.destroyed || this._eofPushed) return;
            reading = true;
            try {
              if (!iterator) {
                if (typeof iterable[Symbol.asyncIterator] === "function") {
                  iterator = iterable[Symbol.asyncIterator]();
                } else {
                  iterator = iterable[Symbol.iterator]();
                }
              }
              while (!this.destroyed && !this._eofPushed) {
                const step = await iterator.next();
                if (this.destroyed) break;
                if (step.done) {
                  this.push(null);
                  break;
                }
                const val = await step.value;
                if (this.destroyed) break;
                const more = this.push(val);
                if (!more) break;
              }
            } catch (err) {
              this.destroy(err);
            } finally {
              reading = false;
            }
          },
          destroy(err, cb) {
            const it = iterator;
            iterator = null;
            if (it && typeof it.return === "function") {
              try {
                Promise.resolve(it.return()).then(
                  () => cb(err),
                  (retErr) => cb(err || retErr)
                );
                return;
              } catch (syncErr) {
                cb(err || syncErr);
                return;
              }
            }
            cb(err);
          },
        })
      );
      return r;
    }
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (this._buffer.length === 0 && !this._eofPushed && !this.destroyed) {
            this._read(this.readableHighWaterMark);
          }
          if (this._buffer.length > 0) {
            const out = this._formatChunk(this._buffer.shift());
            if (typeof this._onPull === "function") this._onPull(1);
            if (this._objectMode || out !== "" || !this._decoder) yield out;
            continue;
          }
          if (this._eofPushed || this.readableEnded || this.destroyed) {
            if (this.destroyed && !this.readableEnded && !this._eofPushed && this._errored && !this._erroredConsumed) {
              this._erroredConsumed = true;
              throw this._errored;
            }
            const rem = this._flushDecoderEOF();
            if (rem) yield rem;
            if (!this._endEmitted && !this.destroyed) {
              this._endEmitted = true;
              this.readableEnded = true;
              this.emit("end");
            }
            break;
          }
          await new Promise((resolve, reject) => {
            const onData = (c) => { cleanup(); this._buffer.unshift(c); resolve(); };
            const onEnd = () => { cleanup(); resolve(); };
            const onErr = (e) => { this._erroredConsumed = true; cleanup(); reject(e); };
            const cleanup = () => {
              this.off("data", onData);
              if (this.listenerCount("data") === 0) this._flowing = false;
              this.off("end", onEnd);
              this.off("close", onEnd);
              this.off("error", onErr);
            };
            this.on("data", onData);
            this.once("end", onEnd);
            this.once("close", onEnd);
            this.once("error", onErr);
          });
        }
      } finally {
        if (!this.readableEnded && !this._endEmitted && !this._eofPushed && !this.destroyed) {
          this.destroy();
        }
      }
    }
  }

  class Writable extends Stream {
    constructor(options = {}) {
      super();
      options = options || {};
      this.writable = true;
      this.writableEnded = false;
      this.writableFinished = false;
      this.destroyed = false;
      this._writableObjectMode = Boolean(options.objectMode || options.writableObjectMode);
      this.writableObjectMode = this._writableObjectMode;
      const defaultHWM = this._writableObjectMode ? 16 : 16384;
      const rawHWM = options.writableHighWaterMark !== undefined ? options.writableHighWaterMark : options.highWaterMark;
      this.writableHighWaterMark = rawHWM !== undefined ? Math.max(0, Number(rawHWM)) : defaultHWM;
      this._defaultEncoding = options.defaultEncoding || "utf8";
      this._writeQueue = [];
      this._writing = false;
      this._inFlightBytes = 0;
      this._backpressured = false;
      this._needDrain = false;
      this._finalCalled = false;
      this._endCbs = [];
      if (typeof options.write === "function") this._write = options.write;
      if (typeof options.final === "function") this._final = options.final;
      if (typeof options.destroy === "function") this._destroy = options.destroy;
    }
    get writableLength() {
      let total = this._inFlightBytes || 0;
      if (this._writeQueue) {
        for (let i = 0; i < this._writeQueue.length; i++) {
          total += this._writeQueue[i].len || 0;
        }
      }
      return total;
    }
    _write(chunk, encoding, cb) { cb(); }
    _pumpWrites() {
      if (!this._writeQueue) this._writeQueue = [];
      if (!this._endCbs) this._endCbs = [];
      while (!this._writing && !this.destroyed && this._writeQueue.length > 0) {
        this._writing = true;
        const item = this._writeQueue.shift();
        this._inFlightBytes = item.len || 0;
        let syncFinished = false;
        let inCall = true;
        this._write(item.chunk, item.encoding, (err) => {
          this._writing = false;
          this._inFlightBytes = 0;
          if (err) {
            if (typeof item.cb === "function") {
              processObj.nextTick(() => {
                try { item.cb(err); } catch (_) {}
              });
            }
            if (!this.destroyed) {
              this.destroy(err);
            }
            return;
          }
          if (typeof item.cb === "function") item.cb(null);
          if (inCall) {
            syncFinished = true;
          } else {
            Writable.prototype._pumpWrites.call(this);
          }
        });
        inCall = false;
        if (!syncFinished) return;
      }
      if (!this._writing && !this.destroyed && this._writeQueue.length === 0) {
        if (this._needDrain && !this._backpressured) {
          this._needDrain = false;
          processObj.nextTick(() => {
            if (!this.destroyed && !this.writableEnded) this.emit("drain");
          });
        }
        if (this.writableEnded && !this._finalCalled) {
          this._finalCalled = true;
          const done = (err) => {
            const cbs = this._endCbs ? this._endCbs.splice(0) : [];
            if (err) {
              this.destroy(err);
              for (const fn of cbs) fn(err);
              return;
            }
            this.writableFinished = true;
            this.emit("finish");
            if (!this._isDuplex || this._endEmitted || this.destroyed) {
              if (!this._closeEmitted) {
                this._closeEmitted = true;
                this.emit("close");
              }
            }
            for (const fn of cbs) fn();
          };
          if (typeof this._final === "function") {
            this._final((err) => queueMicrotask(() => processObj.nextTick(() => done(err))));
          } else {
            queueMicrotask(() => processObj.nextTick(() => done()));
          }
        }
      }
    }
    write(chunk, encoding, cb) {
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = "utf8";
      }
      if (this.writableEnded) {
        const err = new Error("write after end");
        err.code = "ERR_STREAM_WRITE_AFTER_END";
        processObj.nextTick(() => {
          this.emit("error", err);
          if (typeof cb === "function") cb(err);
        });
        return false;
      }
      if (this.destroyed) {
        const err = new Error("Cannot call write after a stream was destroyed");
        err.code = "ERR_STREAM_DESTROYED";
        processObj.nextTick(() => {
          this.emit("error", err);
          if (typeof cb === "function") cb(err);
        });
        return false;
      }
      if (!this._writeQueue) this._writeQueue = [];
      const enc = encoding || this._defaultEncoding || "utf8";
      const len = this._writableObjectMode ? 1 : (typeof chunk === "string" ? Buffer.byteLength(chunk, enc) : (chunk && typeof chunk.byteLength === "number" ? chunk.byteLength : 1));
      this._writeQueue.push({ chunk, encoding: enc, cb, len });
      Writable.prototype._pumpWrites.call(this);
      const ret = !this.destroyed && this.writableLength < this.writableHighWaterMark && !this._backpressured;
      if (!ret && !this.destroyed) {
        this._needDrain = true;
      }
      return ret;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = "utf8";
      }
      if (!this._endCbs) this._endCbs = [];
      if (typeof cb === "function") {
        if (this.destroyed) {
          const closeErr = Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
          processObj.nextTick(() => cb(closeErr));
        } else {
          this._endCbs.push(cb);
        }
      }
      if (chunk !== undefined && chunk !== null) {
        this.write(chunk, encoding);
      }
      this.writableEnded = true;
      Writable.prototype._pumpWrites.call(this);
      return this;
    }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      const pendingWrites = this._writeQueue ? this._writeQueue.splice(0) : [];
      const pendingEnds = this._endCbs ? this._endCbs.splice(0) : [];
      const closeErr = err || Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
      processObj.nextTick(() => {
        for (const item of pendingWrites) {
          if (typeof item.cb === "function") {
            try { item.cb(closeErr); } catch (_) {}
          }
        }
        for (const fn of pendingEnds) {
          if (typeof fn === "function") {
            try { fn(closeErr); } catch (_) {}
          }
        }
        if (err) this.emit("error", err);
        if (!this._closeEmitted) {
          this._closeEmitted = true;
          this.emit("close", Boolean(err));
        }
      });
      return this;
    }
  }

  class Duplex extends Readable {
    constructor(options = {}) {
      super(options);
      options = options || {};
      this._isDuplex = true;
      this.writable = true;
      this.writableEnded = false;
      this.writableFinished = false;
      this._writableObjectMode = Boolean(options.objectMode || options.writableObjectMode);
      this.writableObjectMode = this._writableObjectMode;
      const defaultHWM = this._writableObjectMode ? 16 : 16384;
      const rawHWM = options.writableHighWaterMark !== undefined ? options.writableHighWaterMark : options.highWaterMark;
      this.writableHighWaterMark = rawHWM !== undefined ? Math.max(0, Number(rawHWM)) : defaultHWM;
      this._defaultEncoding = options.defaultEncoding || "utf8";
      this._writeQueue = [];
      this._writing = false;
      this._inFlightBytes = 0;
      this._backpressured = false;
      this._needDrain = false;
      this._finalCalled = false;
      this._endCbs = [];
      if (typeof options.write === "function") this._write = options.write;
      if (typeof options.final === "function") this._final = options.final;
    }
    get writableLength() {
      let n = this._inFlightBytes || 0;
      for (let i = 0; i < this._writeQueue.length; i++) {
        n += this._writeQueue[i].len;
      }
      return n;
    }
    _write(chunk, encoding, cb) { cb(); }
    _pumpWrites() {
      return Writable.prototype._pumpWrites.call(this);
    }
    write(chunk, encoding, cb) {
      return Writable.prototype.write.call(this, chunk, encoding, cb);
    }
    end(chunk, encoding, cb) {
      return Writable.prototype.end.call(this, chunk, encoding, cb);
    }
  }

  class Transform extends Duplex {
    constructor(options = {}) {
      super(options);
      if (typeof options.transform === "function") this._transform = options.transform;
      if (typeof options.flush === "function") this._flush = options.flush;
    }
    _transform(chunk, encoding, cb) { cb(null, chunk); }
    _write(chunk, encoding, cb) {
      this._transform(chunk, encoding, (err, data) => {
        if (err) {
          this.destroy(err);
          if (typeof cb === "function") cb(err);
          return;
        }
        if (data !== undefined && data !== null) this.push(data);
        if (typeof cb === "function") cb(null);
      });
    }
    _final(cb) {
      if (typeof this._flush === "function") {
        this._flush((err, data) => {
          if (err) return cb(err);
          if (data !== undefined && data !== null) this.push(data);
          this.push(null);
          cb();
        });
      } else {
        this.push(null);
        cb();
      }
    }
  }

  class PassThrough extends Transform {}

  function pipeline(...args) {
    let cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    let opts = null;
    if (args.length > 1 && args[args.length - 1] && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && typeof args[args.length - 1].pipe !== "function" && typeof args[args.length - 1].write !== "function" && typeof args[args.length - 1][Symbol.iterator] !== "function" && typeof args[args.length - 1][Symbol.asyncIterator] !== "function") {
      opts = args.pop();
    }
    const rawStreams = Array.isArray(args[0]) ? args[0].slice() : args;
    const streams = rawStreams.map((s, idx) => {
      if (idx === 0 && typeof s === "function") {
        s = s();
      }
      if (s && typeof s.pipe !== "function" && typeof s.write !== "function" && (typeof s[Symbol.iterator] === "function" || typeof s[Symbol.asyncIterator] === "function")) {
        return Readable.from(s);
      }
      return s;
    });
    const p = new Promise((resolve, reject) => {
      let settled = false;
      const destroyAll = (err) => {
        for (const s of streams) {
          if (s && !s.destroyed && typeof s.destroy === "function") {
            try { s.destroy(err); } catch (_) {}
          }
        }
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        destroyAll(err);
        reject(err);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (opts && opts.signal) {
        if (opts.signal.aborted) {
          const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: opts.signal.reason });
          return fail(err);
        }
        opts.signal.addEventListener("abort", () => {
          const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: opts.signal.reason });
          fail(err);
        }, { once: true });
      }
      for (let i = 0; i < streams.length; i++) {
        const s = streams[i];
        if (s && typeof s.once === "function") {
          s.once("error", fail);
          if (i < streams.length - 1) {
            s.once("close", () => {
              if (!settled && !s.readableEnded && !s._endEmitted) {
                fail(Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
              }
            });
          }
        }
        if (i < streams.length - 1) {
          s.pipe(streams[i + 1]);
        }
      }
      const last = streams[streams.length - 1];
      if (last && typeof last.once === "function") {
        const isWritable = Boolean(last.writable || typeof last.write === "function");
        const isReadable = Boolean(last.readable || typeof last.read === "function");
        if (isWritable && !last._isDuplex) {
          last.once("finish", done);
        } else if (isReadable && !isWritable) {
          last.once("end", done);
        } else {
          last.once("finish", done);
          last.once("end", done);
        }
        last.once("close", () => {
          if (!settled) {
            const wOk = !isWritable || Boolean(last.writableFinished);
            const rOk = !isReadable || Boolean(last.readableEnded || last._endEmitted);
            if (wOk && rOk) done();
            else fail(Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
          }
        });
      } else {
        done();
      }
    });
    if (cb) {
      p.then(() => cb(null), (err) => cb(err));
    }
    return p;
  }

  function finished(stream, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    const checkReadable = opts.readable !== undefined ? Boolean(opts.readable) : Boolean(stream && (stream.readable || typeof stream.read === "function"));
    const checkWritable = opts.writable !== undefined ? Boolean(opts.writable) : Boolean(stream && (stream.writable || typeof stream.write === "function"));
    const isComplete = () => {
      const rDone = !checkReadable || Boolean(stream.readableEnded || stream._endEmitted);
      const wDone = !checkWritable || Boolean(stream.writableFinished);
      return rDone && wDone;
    };
    const p = new Promise((resolve, reject) => {
      let settled = false;
      let onAbort = null;
      const cleanup = () => {
        if (onAbort && opts.signal && typeof opts.signal.removeEventListener === "function") {
          opts.signal.removeEventListener("abort", onAbort);
        }
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          return fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: opts.signal.reason }));
        }
        onAbort = () => {
          fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: opts.signal.reason }));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (isComplete()) {
        queueMicrotask(done);
        return;
      }
      if (stream.destroyed) {
        queueMicrotask(() => fail(Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" })));
        return;
      }
      const onEnd = () => {
        if (isComplete()) done();
      };
      const onFinish = () => {
        if (isComplete()) done();
      };
      const onClose = () => {
        if (isComplete()) done();
        else fail(Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
      };
      stream.once("end", onEnd);
      stream.once("finish", onFinish);
      stream.once("close", onClose);
      stream.once("error", fail);
    });
    if (cb) p.then(() => cb(null), (err) => cb(err));
    return p;
  }

  class ReadableStream {
    constructor(underlyingSource = {}, strategy = {}) {
      this._chunks = [];
      this._chunkSizes = [];
      this._queueSize = 0;
      this._highWaterMark = strategy && strategy.highWaterMark !== undefined ? Number(strategy.highWaterMark) : 1;
      this._sizeFn = strategy && typeof strategy.size === "function" ? strategy.size : () => 1;
      this._closed = false;
      this._errored = null;
      this._waiters = [];
      this._waitRefed = false;
      this._locked = false;
      this._cancel = underlyingSource.cancel;
      this._onConsume = underlyingSource._onConsume || null;
      this._onWaitStart = underlyingSource._onWaitStart || null;
      this._onWaitEnd = underlyingSource._onWaitEnd || null;
      const notifyWaitEndIfEmpty = () => {
        if (this._waiters.length === 0 && this._waitRefed) {
          this._waitRefed = false;
          if (typeof this._onWaitEnd === "function") {
            try { this._onWaitEnd(); } catch (_) {}
          }
        }
      };
      const controller = {
        enqueue: (chunk) => {
          if (this._closed || this._errored) return;
          if (this._waiters.length > 0) {
            const w = this._waiters.shift();
            notifyWaitEndIfEmpty();
            if (typeof this._onConsume === "function") {
              try { this._onConsume(chunk); } catch (_) {}
            }
            w.resolve({ value: chunk, done: false });
          } else {
            const sz = Math.max(0, Number(this._sizeFn(chunk)) || 0);
            this._chunks.push(chunk);
            this._chunkSizes.push(sz);
            this._queueSize += sz;
          }
        },
        close: () => {
          if (this._closed || this._errored) return;
          this._closed = true;
          while (this._waiters.length > 0) {
            const w = this._waiters.shift();
            w.resolve({ value: undefined, done: true });
          }
          notifyWaitEndIfEmpty();
        },
        error: (e) => {
          if (this._closed || this._errored) return;
          this._errored = e || new Error("Stream error");
          this._chunks.length = 0;
          this._chunkSizes.length = 0;
          this._queueSize = 0;
          while (this._waiters.length > 0) {
            const w = this._waiters.shift();
            w.reject(this._errored);
          }
          notifyWaitEndIfEmpty();
        },
      };
      Object.defineProperty(controller, "desiredSize", {
        get: () => {
          if (this._errored) return null;
          if (this._closed) return 0;
          return this._highWaterMark - this._queueSize;
        },
        enumerable: true,
        configurable: true,
      });
      if (typeof underlyingSource.start === "function") underlyingSource.start(controller);
      this._pull = underlyingSource.pull;
      this._controller = controller;
      this._notifyWaitEndIfEmpty = notifyWaitEndIfEmpty;
    }
    get locked() {
      return Boolean(this._locked);
    }
    _shiftChunk() {
      const val = this._chunks.shift();
      const sz = this._chunkSizes.shift() || 0;
      this._queueSize = Math.max(0, this._queueSize - sz);
      if (typeof this._onConsume === "function") {
        try { this._onConsume(val); } catch (_) {}
      }
      return val;
    }
    async cancel(reason) {
      if (this._locked) {
        throw new TypeError("Cannot cancel a locked ReadableStream");
      }
      this._closed = true;
      this._chunks.length = 0;
      this._chunkSizes.length = 0;
      this._queueSize = 0;
      if (typeof this._cancel === "function") await this._cancel(reason);
      while (this._waiters.length > 0) {
        this._waiters.shift().resolve({ value: undefined, done: true });
      }
      this._notifyWaitEndIfEmpty();
    }
    getReader() {
      if (this._locked) {
        const err = new TypeError("ReadableStream is already locked to a reader");
        err.code = "ERR_INVALID_STATE";
        throw err;
      }
      this._locked = true;
      return {
        read: async () => {
          if (this._chunks.length > 0) return { value: this._shiftChunk(), done: false };
          if (this._errored) throw this._errored;
          if (this._closed) return { value: undefined, done: true };
          if (typeof this._pull === "function") {
            await this._pull(this._controller);
            if (this._chunks.length > 0) return { value: this._shiftChunk(), done: false };
            if (this._errored) throw this._errored;
            if (this._closed) return { value: undefined, done: true };
          }
          return new Promise((resolve, reject) => {
            if (!this._waitRefed) {
              this._waitRefed = true;
              if (typeof this._onWaitStart === "function") {
                try { this._onWaitStart(); } catch (_) {}
              }
            }
            this._waiters.push({ resolve, reject });
          });
        },
        releaseLock: () => {
          this._locked = false;
        },
        cancel: async (reason) => {
          this._closed = true;
          this._chunks.length = 0;
          this._chunkSizes.length = 0;
          this._queueSize = 0;
          if (typeof this._cancel === "function") await this._cancel(reason);
          while (this._waiters.length > 0) {
            this._waiters.shift().resolve({ value: undefined, done: true });
          }
          this._notifyWaitEndIfEmpty();
        },
      };
    }
    values(options = {}) {
      const preventCancel = Boolean(options && options.preventCancel);
      const reader = this.getReader();
      let doneReading = false;
      return {
        async next() {
          const res = await reader.read();
          if (res.done) {
            doneReading = true;
            reader.releaseLock();
          }
          return res;
        },
        async return(value) {
          if (!doneReading) {
            doneReading = true;
            if (!preventCancel) {
              await reader.cancel();
            }
            reader.releaseLock();
          }
          return { value, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
    [Symbol.asyncIterator]() {
      return this.values();
    }
    tee() {
      const reader = this.getReader();
      let ctrl1, ctrl2;
      let pulling = null;
      const pullBoth = () => {
        if (pulling) return pulling;
        pulling = (async () => {
          try {
            const { value, done } = await reader.read();
            if (done) {
              ctrl1.close();
              ctrl2.close();
            } else {
              ctrl1.enqueue(value instanceof Uint8Array ? new Uint8Array(value) : value);
              ctrl2.enqueue(value instanceof Uint8Array ? new Uint8Array(value) : value);
            }
          } catch (err) {
            ctrl1.error(err);
            ctrl2.error(err);
          } finally {
            pulling = null;
          }
        })();
        return pulling;
      };
      const s1 = new ReadableStream({ start(c) { ctrl1 = c; }, pull: pullBoth });
      const s2 = new ReadableStream({ start(c) { ctrl2 = c; }, pull: pullBoth });
      return [s1, s2];
    }
    async pipeTo(dest, options = {}) {
      const reader = this.getReader();
      const writer = dest.getWriter();
      try {
        while (true) {
          if (options && options.signal && options.signal.aborted) {
            throw options.signal.reason || Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
          }
          const { value, done } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        if (!options || !options.preventClose) await writer.close();
      } catch (err) {
        if ((!options || !options.preventAbort) && typeof writer.abort === "function") {
          try { await writer.abort(err); } catch (_) {}
        }
        if (!options || !options.preventCancel) {
          try { await reader.cancel(err); } catch (_) {}
        }
        throw err;
      } finally {
        reader.releaseLock();
        if (typeof writer.releaseLock === "function") writer.releaseLock();
      }
    }
    pipeThrough(transform, options) {
      if (!transform || !transform.writable || !transform.readable) {
        throw new TypeError("Failed to execute 'pipeThrough' on 'ReadableStream': parameter 1 is not a TransformStream.");
      }
      this.pipeTo(transform.writable, options).catch((err) => {
        if (transform.readable && transform.readable._controller) {
          transform.readable._controller.error(err);
        }
      });
      return transform.readable;
    }
    static from(iterable) {
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of iterable) {
              controller.enqueue(chunk);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });
    }
  }

  class WritableStream {
    constructor(underlyingSink = {}) {
      this._sink = underlyingSink || {};
      this._locked = false;
      this._closed = false;
      this._errored = null;
      if (typeof this._sink.start === "function") {
        this._sink.start({
          error: (e) => { this._errored = e || new Error("WritableStream error"); },
        });
      }
    }
    get locked() {
      return Boolean(this._locked);
    }
    async abort(reason) {
      if (this._locked) {
        throw new TypeError("Cannot abort a locked WritableStream");
      }
      this._closed = true;
      if (typeof this._sink.abort === "function") {
        await this._sink.abort(reason);
      }
    }
    async close() {
      if (this._locked) {
        throw new TypeError("Cannot close a locked WritableStream");
      }
      if (this._closed) {
        throw new TypeError("Cannot close an already closed WritableStream");
      }
      this._closed = true;
      if (typeof this._sink.close === "function") {
        await this._sink.close();
      }
    }
    getWriter() {
      if (this._locked) {
        throw new TypeError("WritableStream is already locked");
      }
      this._locked = true;
      const sink = this._sink;
      let released = false;
      const isClosed = () => this._closed;
      const setClosed = (v) => { this._closed = v; };
      const getErrored = () => this._errored;
      const unlock = () => { this._locked = false; };
      return {
        get desiredSize() { return isClosed() ? 0 : 1; },
        get closed() { return Promise.resolve(); },
        get ready() { return Promise.resolve(); },
        async write(chunk) {
          if (released) throw new TypeError("Writer lock has been released");
          const err = getErrored();
          if (err) throw err;
          if (isClosed()) throw new TypeError("WritableStream is closed");
          if (typeof sink.write === "function") await sink.write(chunk);
        },
        async close() {
          if (released) throw new TypeError("Writer lock has been released");
          if (isClosed()) return;
          setClosed(true);
          if (typeof sink.close === "function") await sink.close();
        },
        async abort(reason) {
          if (released) throw new TypeError("Writer lock has been released");
          setClosed(true);
          if (typeof sink.abort === "function") await sink.abort(reason);
        },
        releaseLock() {
          if (!released) {
            released = true;
            unlock();
          }
        },
      };
    }
  }

  class TransformStream {
    constructor(transformer = {}) {
      let readableController;
      this.readable = new ReadableStream({
        start(c) {
          readableController = c;
        },
      });
      const transformController = {
        enqueue(chunk) {
          readableController.enqueue(chunk);
        },
        terminate() {
          readableController.close();
        },
        error(e) {
          readableController.error(e);
        },
      };
      if (typeof transformer.start === "function") {
        transformer.start(transformController);
      }
      this.writable = new WritableStream({
        async write(chunk) {
          try {
            if (typeof transformer.transform === "function") {
              await transformer.transform(chunk, transformController);
            } else {
              transformController.enqueue(chunk);
            }
          } catch (err) {
            readableController.error(err);
            throw err;
          }
        },
        async close() {
          try {
            if (typeof transformer.flush === "function") {
              await transformer.flush(transformController);
            }
            readableController.close();
          } catch (err) {
            readableController.error(err);
            throw err;
          }
        },
        async abort(reason) {
          readableController.error(reason !== undefined ? reason : new Error("TransformStream writable aborted"));
        },
      });
    }
  }

  class ByteLengthQueuingStrategy {
    constructor(init = {}) {
      this.highWaterMark = Number(init.highWaterMark);
    }
    size(chunk) {
      return chunk && typeof chunk.byteLength === "number" ? chunk.byteLength : 0;
    }
  }

  class CountQueuingStrategy {
    constructor(init = {}) {
      this.highWaterMark = Number(init.highWaterMark);
    }
    size() {
      return 1;
    }
  }

  class TextEncoderStream extends TransformStream {
    constructor() {
      const enc = new TextEncoder();
      super({
        transform(chunk, controller) {
          const s = String(chunk);
          if (s.length > 0) controller.enqueue(enc.encode(s));
        },
      });
      this.encoding = "utf-8";
    }
  }

  class TextDecoderStream extends TransformStream {
    constructor(label = "utf-8", options = {}) {
      const dec = new TextDecoder(label, options);
      super({
        transform(chunk, controller) {
          const str = dec.decode(chunk, { stream: true });
          if (str.length > 0) controller.enqueue(str);
        },
        flush(controller) {
          const str = dec.decode();
          if (str.length > 0) controller.enqueue(str);
        },
      });
      this.encoding = dec.encoding;
      this.fatal = dec.fatal;
      this.ignoreBOM = dec.ignoreBOM;
    }
  }

  function resolveWebCompressionMode(format, isCompress) {
    const f = String(format || "").toLowerCase();
    if (f === "gzip") return isCompress ? "gzip" : "gunzip";
    if (f === "deflate") return isCompress ? "deflate" : "inflate";
    if (f === "deflate-raw") return isCompress ? "deflateRaw" : "inflateRaw";
    throw new TypeError(`Unsupported compression format: '${format}'`);
  }

  class CompressionStream extends TransformStream {
    constructor(format) {
      const mode = resolveWebCompressionMode(format, true);
      const chunks = [];
      super({
        transform(chunk) {
          chunks.push(toBytesInput(chunk));
        },
        flush(controller) {
          const input = chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks);
          const raw = hostCall("zlib.transform", mode, input);
          if (raw && raw.byteLength > 0) {
            controller.enqueue(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
          }
        },
      });
    }
  }

  class DecompressionStream extends TransformStream {
    constructor(format) {
      const mode = resolveWebCompressionMode(format, false);
      const chunks = [];
      super({
        transform(chunk) {
          chunks.push(toBytesInput(chunk));
        },
        flush(controller) {
          const input = chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks);
          const raw = hostCall("zlib.transform", mode, input);
          if (raw && raw.byteLength > 0) {
            controller.enqueue(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
          }
        },
      });
    }
  }

  globalThis.ReadableStream = ReadableStream;
  globalThis.WritableStream = WritableStream;
  globalThis.TransformStream = TransformStream;
  globalThis.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = CountQueuingStrategy;
  globalThis.TextEncoderStream = TextEncoderStream;
  globalThis.TextDecoderStream = TextDecoderStream;
  globalThis.CompressionStream = CompressionStream;
  globalThis.DecompressionStream = DecompressionStream;

  class ReadableStreamDefaultReader {
    constructor(stream) {
      return stream.getReader();
    }
  }
  class ReadableStreamBYOBReader {
    constructor(stream) {
      return stream.getReader();
    }
  }
  class ReadableStreamDefaultController {}
  class ReadableByteStreamController {}
  class ReadableStreamBYOBRequest {}
  class WritableStreamDefaultWriter {
    constructor(stream) {
      return stream.getWriter();
    }
  }
  class WritableStreamDefaultController {}
  class TransformStreamDefaultController {}

  const streamPromisesMod = { pipeline, finished };
  const streamWebMod = {
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamDefaultController,
    ReadableByteStreamController,
    ReadableStreamBYOBRequest,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream,
  };
  Object.setPrototypeOf(processObj.stdout, Writable.prototype);
  Object.setPrototypeOf(processObj.stderr, Writable.prototype);
  Object.setPrototypeOf(processObj.stdin, Readable.prototype);

  Readable.toWeb = function toWeb(nodeReadable) {
    if (!nodeReadable || typeof nodeReadable.on !== "function") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"streamReadable\" argument must be an instance of Readable", TypeError);
    }
    return new ReadableStream({
      start(ctrl) {
        nodeReadable.on("data", (chunk) => ctrl.enqueue(chunk));
        nodeReadable.once("end", () => ctrl.close());
        nodeReadable.once("error", (err) => ctrl.error(err));
      },
      cancel() {
        if (typeof nodeReadable.destroy === "function") nodeReadable.destroy();
      },
    });
  };
  Readable.fromWeb = function fromWeb(webReadable, options) {
    if (!webReadable || typeof webReadable.getReader !== "function") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"readableStream\" argument must be an instance of ReadableStream", TypeError);
    }
    return Readable.from(webReadable, options);
  };
  Writable.toWeb = function toWeb(nodeWritable) {
    if (!nodeWritable || typeof nodeWritable.write !== "function") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"streamWritable\" argument must be an instance of Writable", TypeError);
    }
    return new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => {
          nodeWritable.write(chunk, (err) => (err ? reject(err) : resolve()));
        });
      },
      close() {
        return new Promise((resolve) => nodeWritable.end(resolve));
      },
      abort(reason) {
        if (typeof nodeWritable.destroy === "function") nodeWritable.destroy(reason instanceof Error ? reason : new Error(String(reason || "aborted")));
      },
    });
  };
  Writable.fromWeb = function fromWeb(webWritable, options) {
    if (!webWritable || typeof webWritable.getWriter !== "function") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"writableStream\" argument must be an instance of WritableStream", TypeError);
    }
    const writer = webWritable.getWriter();
    return new Writable(Object.assign({}, options, {
      write(chunk, _enc, cb) {
        writer.write(chunk).then(() => cb(null), (err) => cb(err));
      },
      final(cb) {
        writer.close().then(() => cb(null), (err) => cb(err));
      },
      destroy(err, cb) {
        if (err) writer.abort(err).then(() => cb(err), () => cb(err));
        else cb(null);
      },
    }));
  };
  Duplex.toWeb = function toWeb(nodeDuplex) {
    return {
      readable: Readable.toWeb(nodeDuplex),
      writable: Writable.toWeb(nodeDuplex),
    };
  };
  Duplex.fromWeb = function fromWeb(pair, options) {
    const r = Readable.fromWeb(pair.readable, options);
    const w = Writable.fromWeb(pair.writable, options);
    const d = new Duplex(Object.assign({}, options, {
      read() {},
      write(chunk, enc, cb) { w.write(chunk, enc, cb); },
      final(cb) { w.end(cb); },
    }));
    r.on("data", (c) => d.push(c));
    r.once("end", () => d.push(null));
    r.once("error", (e) => d.destroy(e));
    return d;
  };
  function addAbortSignal(signal, stream) {
    if (!signal || typeof signal.aborted !== "boolean") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"signal\" argument must be an instance of AbortSignal", TypeError);
    }
    if (!stream || typeof stream.destroy !== "function") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"stream\" argument must be an instance of Stream", TypeError);
    }
    const onAbort = () => {
      stream.destroy(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR", name: "AbortError", cause: signal.reason }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return stream;
  }

  function duplexPair(options) {
    let d1, d2;
    d1 = new Duplex(Object.assign({}, options, {
      read() {},
      write(chunk, _enc, cb) { d2.push(chunk); cb(); },
      final(cb) { d2.push(null); cb(); },
    }));
    d2 = new Duplex(Object.assign({}, options, {
      read() {},
      write(chunk, _enc, cb) { d1.push(chunk); cb(); },
      final(cb) { d1.push(null); cb(); },
    }));
    return [d1, d2];
  }
  function compose(...streams) {
    if (streams.length === 0) return new PassThrough();
    if (streams.length === 1) return streams[0];
    for (let i = 0; i < streams.length - 1; i++) {
      if (typeof streams[i].pipe === "function") streams[i].pipe(streams[i + 1]);
    }
    const first = streams[0];
    const last = streams[streams.length - 1];
    const combined = new Duplex({
      read() {},
      write(chunk, enc, cb) { first.write(chunk, enc, cb); },
      final(cb) { first.end(cb); },
    });
    last.on("data", (c) => combined.push(c));
    last.once("end", () => combined.push(null));
    last.once("error", (e) => combined.destroy(e));
    return combined;
  }
  const isReadable = (s) => Boolean(s && (s.readable || typeof s._read === "function" || s instanceof ReadableStream));
  const isWritable = (s) => Boolean(s && (s.writable || typeof s._write === "function" || s instanceof WritableStream));
  const isDisturbed = (s) => Boolean(s && (s.readableDidRead || s._flowing || s.readableEnded || s.destroyed || s._locked));
  const isErrored = (s) => Boolean(s && (s.errored || s._errored));

  const streamConsumersMod = {
    async buffer(stream) {
      const b = await consumeStreamLikeToBytes(stream);
      return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    },
    async arrayBuffer(stream) {
      const b = await consumeStreamLikeToBytes(stream);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async blob(stream) {
      const b = await consumeStreamLikeToBytes(stream);
      return new Blob([b]);
    },
    async text(stream) {
      const b = await consumeStreamLikeToBytes(stream);
      return utf8Decode(b);
    },
    async json(stream) {
      const t = await streamConsumersMod.text(stream);
      return JSON.parse(t);
    },
  };

  Stream.Stream = Stream;
  Stream.Readable = Readable;
  Stream.Writable = Writable;
  Stream.Duplex = Duplex;
  Stream.Transform = Transform;
  Stream.PassThrough = PassThrough;
  Stream.pipeline = pipeline;
  Stream.finished = finished;
  Stream.addAbortSignal = addAbortSignal;
  Stream.duplexPair = duplexPair;
  Stream.compose = compose;
  Stream.isReadable = isReadable;
  Stream.isWritable = isWritable;
  Stream.isDisturbed = isDisturbed;
  Stream.isErrored = isErrored;
  Stream.getDefaultHighWaterMark = (objectMode) => (objectMode ? 16 : 16384);
  Stream.setDefaultHighWaterMark = () => {};
  Stream.promises = streamPromisesMod;
  Stream.web = streamWebMod;
  Stream.consumers = streamConsumersMod;

  builtins["stream"] = Stream;
  builtins["stream/promises"] = streamPromisesMod;
  builtins["stream/web"] = streamWebMod;
  builtins["stream/consumers"] = streamConsumersMod;

  // =========================================================================
  // 11. Filesystem (fs & fs/promises)
  // =========================================================================

  const isWinPlatform = processObj.platform === "win32";
  const isDarwinPlatform = processObj.platform === "darwin";
  const fsConstants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: isWinPlatform ? 256 : (isDarwinPlatform ? 512 : 64),
    O_EXCL: isWinPlatform ? 1024 : (isDarwinPlatform ? 2048 : 128),
    O_NOCTTY: isWinPlatform ? 0 : (isDarwinPlatform ? 131072 : 256),
    O_TRUNC: isWinPlatform ? 512 : (isDarwinPlatform ? 1024 : 512),
    O_APPEND: isWinPlatform ? 8 : (isDarwinPlatform ? 8 : 1024),
    O_DIRECTORY: isWinPlatform ? 0 : (isDarwinPlatform ? 1048576 : 65536),
    O_NOATIME: isWinPlatform ? 0 : (isDarwinPlatform ? 0 : 262144),
    O_NOFOLLOW: isWinPlatform ? 0 : (isDarwinPlatform ? 256 : 131072),
    O_SYNC: isWinPlatform ? 0 : (isDarwinPlatform ? 128 : 1052672),
    O_DSYNC: isWinPlatform ? 0 : (isDarwinPlatform ? 4194304 : 4096),
    O_SYMLINK: isDarwinPlatform ? 2097152 : 0,
    O_DIRECT: isWinPlatform || isDarwinPlatform ? 0 : 16384,
    O_NONBLOCK: isWinPlatform ? 0 : (isDarwinPlatform ? 4 : 2048),
    S_IFMT: 61440,
    S_IFREG: 32768,
    S_IFDIR: 16384,
    S_IFCHR: 8192,
    S_IFBLK: 24576,
    S_IFIFO: 4096,
    S_IFLNK: 40960,
    S_IFSOCK: 49152,
    S_IRWXU: 448,
    S_IRUSR: 256,
    S_IWUSR: 128,
    S_IXUSR: 64,
    S_IRWXG: 56,
    S_IRGRP: 32,
    S_IWGRP: 16,
    S_IXGRP: 8,
    S_IRWXO: 7,
    S_IROTH: 4,
    S_IWOTH: 2,
    S_IXOTH: 1,
    UV_FS_SYMLINK_DIR: 1,
    UV_FS_SYMLINK_JUNCTION: 2,
    UV_FS_COPYFILE_EXCL: 1,
    UV_FS_COPYFILE_FICLONE: 2,
    UV_FS_COPYFILE_FICLONE_FORCE: 4,
    UV_DIRENT_UNKNOWN: 0,
    UV_DIRENT_FILE: 1,
    UV_DIRENT_DIR: 2,
    UV_DIRENT_LINK: 3,
    UV_DIRENT_FIFO: 4,
    UV_DIRENT_SOCKET: 5,
    UV_DIRENT_CHAR: 6,
    UV_DIRENT_BLOCK: 7,
  };
  builtins["constants"] = fsConstants;

  class Stats {
    constructor(raw, bigint = false) {
      const dev = raw.dev || 0;
      const ino = raw.ino || 0;
      const mode = raw.mode || 0;
      const nlink = raw.nlink !== undefined ? raw.nlink : 1;
      const uid = raw.uid || 0;
      const gid = raw.gid || 0;
      const rdev = raw.rdev || 0;
      const size = raw.size || 0;
      const blksize = raw.blksize || 4096;
      const blocks = raw.blocks !== undefined ? raw.blocks : Math.ceil(size / 512);
      const atimeMs = raw.atimeMs || 0;
      const mtimeMs = raw.mtimeMs || 0;
      const ctimeMs = raw.ctimeMs || 0;
      const birthtimeMs = raw.birthtimeMs || 0;
      if (bigint) {
        const toBi = (v) => BigInt(Math.trunc(Number(v) || 0));
        this.dev = toBi(dev);
        this.ino = toBi(ino);
        this.mode = toBi(mode);
        this.nlink = toBi(nlink);
        this.uid = toBi(uid);
        this.gid = toBi(gid);
        this.rdev = toBi(rdev);
        this.size = toBi(size);
        this.blksize = toBi(blksize);
        this.blocks = toBi(blocks);
        this.atimeMs = toBi(atimeMs);
        this.mtimeMs = toBi(mtimeMs);
        this.ctimeMs = toBi(ctimeMs);
        this.birthtimeMs = toBi(birthtimeMs);
        this.atimeNs = this.atimeMs * 1000000n;
        this.mtimeNs = this.mtimeMs * 1000000n;
        this.ctimeNs = this.ctimeMs * 1000000n;
        this.birthtimeNs = this.birthtimeMs * 1000000n;
      } else {
        this.dev = dev;
        this.ino = ino;
        this.mode = mode;
        this.nlink = nlink;
        this.uid = uid;
        this.gid = gid;
        this.rdev = rdev;
        this.size = size;
        this.blksize = blksize;
        this.blocks = blocks;
        this.atimeMs = atimeMs;
        this.mtimeMs = mtimeMs;
        this.ctimeMs = ctimeMs;
        this.birthtimeMs = birthtimeMs;
      }
      this.atime = new Date(atimeMs);
      this.mtime = new Date(mtimeMs);
      this.ctime = new Date(ctimeMs);
      this.birthtime = new Date(birthtimeMs);
      this._isFile = Boolean(raw.isFile);
      this._isDirectory = Boolean(raw.isDirectory);
      this._isSymlink = Boolean(raw.isSymlink);
      this._isFIFO = Boolean(raw.isFIFO);
      this._isSocket = Boolean(raw.isSocket);
      this._isCharDevice = Boolean(raw.isCharDevice);
      this._isBlockDev = Boolean(raw.isBlockDev);
    }
    isFile() { return this._isFile; }
    isDirectory() { return this._isDirectory; }
    isSymbolicLink() { return this._isSymlink; }
    isFIFO() { return this._isFIFO; }
    isSocket() { return this._isSocket; }
    isCharacterDevice() { return this._isCharDevice; }
    isBlockDevice() { return this._isBlockDev; }
  }

  class Dirent {
    constructor(raw) {
      this.name = raw.name;
      this.parentPath = raw.parentPath || "";
      this.path = raw.parentPath || "";
      Object.defineProperties(this, {
        _isFile: { value: Boolean(raw.isFile), enumerable: false },
        _isDirectory: { value: Boolean(raw.isDirectory), enumerable: false },
        _isSymlink: { value: Boolean(raw.isSymlink), enumerable: false },
        _isFIFO: { value: Boolean(raw.isFIFO), enumerable: false },
        _isSocket: { value: Boolean(raw.isSocket), enumerable: false },
        _isCharDevice: { value: Boolean(raw.isCharDevice), enumerable: false },
        _isBlockDev: { value: Boolean(raw.isBlockDev), enumerable: false },
      });
    }
    isFile() { return this._isFile; }
    isDirectory() { return this._isDirectory; }
    isSymbolicLink() { return this._isSymlink; }
    isFIFO() { return this._isFIFO; }
    isSocket() { return this._isSocket; }
    isCharacterDevice() { return this._isCharDevice; }
    isBlockDevice() { return this._isBlockDev; }
  }

  function normPathArg(p) {
    if (p instanceof URL) return fileURLToPath(p);
    if (Buffer.isBuffer(p)) return p.toString("utf8");
    return String(p);
  }

  function isBufferEncoding(options) {
    if (!options) return false;
    const raw = typeof options === "string" ? options : typeof options === "object" ? options.encoding : null;
    return typeof raw === "string" && raw.toLowerCase() === "buffer";
  }

  function extractEncoding(options) {
    if (!options) return null;
    const raw = typeof options === "string" ? options : typeof options === "object" ? options.encoding : null;
    if (!raw || String(raw).toLowerCase() === "buffer") return null;
    const norm = normalizeEncoding(raw);
    if (!norm) {
      const err = new TypeError(`The argument 'encoding' is invalid encoding. Received '${raw}'`);
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
    return norm;
  }

  function toBytesInput(data, encoding) {
    if (typeof data === "string") return Buffer.from(data, encoding && encoding !== "buffer" ? encoding : "utf8");
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) {
      return new Uint8Array(data);
    }
    if (data && typeof data === "object" && data._raw instanceof Uint8Array) {
      return data._raw;
    }
    const err = new TypeError(
      `The "data" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer. Received ${data === null ? "null" : typeof data}`
    );
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }

  function readFileSync(path, options) {
    if (path && typeof path === "object" && typeof path.fd === "number") {
      path = path.fd;
    }
    const enc = extractEncoding(options);
    let raw;
    if (path === 0 || path === "/dev/stdin" || path === "/dev/fd/0") {
      const drained = [];
      if (processObj.stdin && Array.isArray(processObj.stdin._bufQueue) && processObj.stdin._bufQueue.length > 0) {
        while (processObj.stdin._bufQueue.length > 0) {
          drained.push(processObj.stdin._bufQueue.shift());
          try { hostCall("process.stdinPull", ""); } catch (_) {}
        }
      }
      if (!processObj.stdin || !processObj.stdin._eof) {
        const rest = hostCall("process.stdinRead", "eof");
        if (rest && rest.byteLength > 0) {
          drained.push(new Buffer(rest.buffer, rest.byteOffset, rest.byteLength));
        }
      }
      const full = drained.length === 0 ? Buffer.alloc(0) : (drained.length === 1 ? drained[0] : Buffer.concat(drained));
      return enc ? full.toString(enc) : full;
    } else if (typeof path === "number") {
      const chunks = [];
      const tmp = Buffer.allocUnsafe(65536);
      while (true) {
        const n = readSync(path, tmp, 0, tmp.length, null);
        if (n <= 0) break;
        chunks.push(Buffer.from(tmp.subarray(0, n)));
      }
      const full = Buffer.concat(chunks);
      return enc ? full.toString(enc) : full;
    } else {
      const flag = options && typeof options === "object" && options.flag !== undefined ? options.flag : null;
      if (flag !== null) {
        raw = hostCall("fs.readFile", JSON.stringify({ path: normPathArg(path), flag }));
      } else {
        raw = hostCall("fs.readFile", normPathArg(path));
      }
    }
    const buf = raw ? new Buffer(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.alloc(0);
    return enc ? buf.toString(enc) : buf;
  }

  function writeFileSync(path, data, options) {
    if (path && typeof path === "object" && typeof path.fd === "number") {
      path = path.fd;
    }
    const enc = extractEncoding(options);
    const bytes = toBytesInput(data, enc);
    if (path === 1 || path === "/dev/stdout" || path === "/dev/fd/1") {
      writeFD(1, bytes);
      return;
    }
    if (path === 2 || path === "/dev/stderr" || path === "/dev/fd/2") {
      writeFD(2, bytes);
      return;
    }
    if (typeof path === "number") {
      writeSync(path, bytes, 0, bytes.byteLength, null);
      return;
    }
    const mode = options && typeof options === "object" && options.mode !== undefined ? options.mode : 0o666;
    const flag = options && typeof options === "object" && options.flag ? options.flag : "w";
    hostCall("fs.writeFile", JSON.stringify({ path: normPathArg(path), mode, flag }), bytes);
  }

  function appendFileSync(path, data, options) {
    if (path && typeof path === "object" && typeof path.fd === "number") {
      path = path.fd;
    }
    const enc = extractEncoding(options);
    const bytes = toBytesInput(data, enc);
    if (path === 1 || path === "/dev/stdout" || path === "/dev/fd/1") {
      writeFD(1, bytes);
      return;
    }
    if (path === 2 || path === "/dev/stderr" || path === "/dev/fd/2") {
      writeFD(2, bytes);
      return;
    }
    if (typeof path === "number") {
      writeSync(path, bytes, 0, bytes.byteLength, null);
      return;
    }
    const mode = options && typeof options === "object" && options.mode !== undefined ? options.mode : 0o666;
    const flag = options && typeof options === "object" && options.flag ? options.flag : "a";
    hostCall("fs.appendFile", JSON.stringify({ path: normPathArg(path), mode, flag }), bytes);
  }

  function existsSync(path) {
    try {
      return hostCall("fs.exists", normPathArg(path)) === "true";
    } catch (_) {
      return false;
    }
  }

  function statSync(path, options = {}) {
    try {
      const raw = JSON.parse(hostCall("fs.stat", normPathArg(path)));
      return new Stats(raw, Boolean(options && options.bigint));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  function lstatSync(path, options = {}) {
    try {
      const raw = JSON.parse(hostCall("fs.lstat", normPathArg(path)));
      return new Stats(raw, Boolean(options && options.bigint));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  function readdirSync(path, options = {}) {
    const enc = extractEncoding(options);
    const withFileTypes = Boolean(options && typeof options === "object" && options.withFileTypes);
    const recursive = Boolean(options && typeof options === "object" && options.recursive);
    const wantBuf = isBufferEncoding(options);
    const callerBase = normPathArg(path);
    const entries = JSON.parse(hostCall("fs.readdir", JSON.stringify({ path: callerBase, recursive }))) || [];
    if (withFileTypes) {
      const isRel = !activePath.isAbsolute(callerBase);
      return entries.map((e) => {
        let d;
        if (isRel) {
          const relDir = e.relPath && e.relPath.includes(activePath.sep) ? activePath.dirname(e.relPath) : "";
          const parentPath = relDir ? activePath.join(callerBase, relDir) : callerBase;
          d = new Dirent(Object.assign({}, e, { parentPath }));
        } else {
          d = new Dirent(e);
        }
        if (wantBuf) {
          d.name = Buffer.from(d.name);
          d.parentPath = Buffer.from(d.parentPath);
          d.path = d.parentPath;
        }
        return d;
      });
    }
    return entries.map((e) => {
      const name = recursive ? e.relPath : e.name;
      if (wantBuf) return Buffer.from(name);
      return enc && enc !== "utf8" ? Buffer.from(name).toString(enc) : name;
    });
  }

  function mkdirSync(path, options) {
    let recursive = false;
    let mode = 0o777;
    if (typeof options === "number") mode = options;
    else if (options && typeof options === "object") {
      recursive = Boolean(options.recursive);
      if (options.mode !== undefined) mode = options.mode;
    }
    const created = hostCall("fs.mkdir", JSON.stringify({ path: normPathArg(path), recursive, mode }));
    return recursive ? (created || undefined) : undefined;
  }

  function rmSync(path, options = {}) {
    const recursive = Boolean(options && options.recursive);
    const force = Boolean(options && options.force);
    hostCall("fs.rm", JSON.stringify({ path: normPathArg(path), recursive, force }));
  }

  function rmdirSync(path, options = {}) {
    const recursive = Boolean(options && options.recursive);
    hostCall("fs.rmdir", JSON.stringify({ path: normPathArg(path), recursive }));
  }

  function unlinkSync(path) {
    hostCall("fs.unlink", normPathArg(path));
  }

  function renameSync(oldPath, newPath) {
    hostCall("fs.rename", JSON.stringify({ oldPath: normPathArg(oldPath), newPath: normPathArg(newPath) }));
  }

  function copyFileSync(src, dest, mode = 0) {
    hostCall("fs.copyFile", JSON.stringify({ src: normPathArg(src), dest: normPathArg(dest), flags: Number(mode) || 0 }));
  }

  function cpSync(src, dest, options = {}) {
    options = options || {};
    const recursive = Boolean(options.recursive);
    const force = options.force !== undefined ? Boolean(options.force) : true;
    const errorOnExist = Boolean(options.errorOnExist);
    const dereference = Boolean(options.dereference);
    if (typeof options.filter === "function") {
      const sPath = normPathArg(src);
      const dPath = normPathArg(dest);
      const activeReal = new Set();
      function copyFiltered(curSrc, curDest) {
        if (!options.filter(curSrc, curDest)) return;
        const lst = lstatSync(curSrc);
        if (lst.isSymbolicLink()) {
          if (!dereference) {
            hostCall("fs.cp", JSON.stringify({ src: curSrc, dest: curDest, recursive: false, force, errorOnExist, dereference: false }));
            return;
          }
          const realCur = realpathSync(curSrc);
          const key = isWin ? realCur.toLowerCase() : realCur;
          if (activeReal.has(key)) {
            const err = new Error(`ELOOP: too many symbolic links encountered, stat '${curSrc}'`);
            err.code = "ELOOP";
            throw err;
          }
          const st = statSync(curSrc);
          if (st.isDirectory()) {
            if (!recursive) {
              const err = new Error(`EISDIR: illegal operation on a directory, cp '${curSrc}'`);
              err.code = "EISDIR";
              throw err;
            }
            activeReal.add(key);
            try {
              mkdirSync(curDest, { recursive: true, mode: st.mode });
              for (const name of readdirSync(curSrc)) {
                copyFiltered(activePath.join(curSrc, name), activePath.join(curDest, name));
              }
            } finally {
              activeReal.delete(key);
            }
            return;
          }
          hostCall("fs.cp", JSON.stringify({ src: curSrc, dest: curDest, recursive: false, force, errorOnExist, dereference: true }));
          return;
        }
        if (lst.isDirectory()) {
          if (!recursive) {
            const err = new Error(`EISDIR: illegal operation on a directory, cp '${curSrc}'`);
            err.code = "EISDIR";
            throw err;
          }
          let key = null;
          try {
            const realCur = realpathSync(curSrc);
            key = isWin ? realCur.toLowerCase() : realCur;
          } catch (_) {}
          if (key !== null) {
            if (activeReal.has(key)) {
              const err = new Error(`ELOOP: too many symbolic links encountered, stat '${curSrc}'`);
              err.code = "ELOOP";
              throw err;
            }
            activeReal.add(key);
          }
          try {
            mkdirSync(curDest, { recursive: true, mode: lst.mode });
            for (const name of readdirSync(curSrc)) {
              copyFiltered(activePath.join(curSrc, name), activePath.join(curDest, name));
            }
          } finally {
            if (key !== null) activeReal.delete(key);
          }
        } else {
          hostCall("fs.cp", JSON.stringify({ src: curSrc, dest: curDest, recursive: false, force, errorOnExist, dereference }));
        }
      }
      copyFiltered(sPath, dPath);
      return;
    }
    hostCall("fs.cp", JSON.stringify({ src: normPathArg(src), dest: normPathArg(dest), recursive, force, errorOnExist, dereference }));
  }

  function realpathSync(path, options) {
    const res = hostCall("fs.realpath", normPathArg(path));
    return isBufferEncoding(options) ? Buffer.from(res) : res;
  }
  realpathSync.native = realpathSync;

  function parseFileMode(mode) {
    if (typeof mode === "string") {
      if (!/^[0-7]+$/.test(mode)) {
        throw makeNodeError("ERR_INVALID_ARG_VALUE", `The argument 'mode' must be a 32-bit unsigned integer or an octal string. Received '${mode}'`, TypeError);
      }
      return parseInt(mode, 8);
    }
    if (typeof mode === "number") {
      if (!Number.isInteger(mode) || mode < 0 || mode > 0xffffffff) {
        throw makeNodeError("ERR_OUT_OF_RANGE", `The value of "mode" is out of range. It must be >= 0 and <= 4294967295. Received ${mode}`, RangeError);
      }
      return mode;
    }
    throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "mode" argument must be of type number or string. Received ${mode === null ? "null" : typeof mode}`, TypeError);
  }

  function chmodSync(path, mode) {
    hostCall("fs.chmod", JSON.stringify({ path: normPathArg(path), mode: parseFileMode(mode) }));
  }

  function fchmodSync(fd, mode) {
    hostCall("fs.fchmod", JSON.stringify({ fd: validateFD(fd), mode: parseFileMode(mode) }));
  }

  function chownSync(path, uid, gid) {
    hostCall("fs.chown", JSON.stringify({ path: normPathArg(path), uid: Number(uid), gid: Number(gid) }));
  }

  function lchownSync(path, uid, gid) {
    hostCall("fs.lchown", JSON.stringify({ path: normPathArg(path), uid: Number(uid), gid: Number(gid) }));
  }

  function validateFD(fd) {
    if (typeof fd !== "number") {
      const err = new TypeError(`The "fd" argument must be of type number. Received ${fd === null ? "null" : typeof fd}`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
      const err = new RangeError(`The value of "fd" is out of range. It must be >= 0 and <= 2147483647. Received ${fd}`);
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    return fd;
  }

  function fchownSync(fd, uid, gid) {
    hostCall("fs.fchown", JSON.stringify({ fd: validateFD(fd), uid: Number(uid), gid: Number(gid) }));
  }

  function toUtimeMs(t, name) {
    if (t instanceof Date) {
      const ms = t.getTime();
      if (Number.isNaN(ms)) {
        throw makeNodeError("ERR_VALUE_OUT_OF_RANGE", `The value of "${name}" is out of range.`, RangeError);
      }
      return ms;
    }
    if (typeof t === "number") {
      if (!Number.isFinite(t)) {
        throw makeNodeError("ERR_VALUE_OUT_OF_RANGE", `The value of "${name}" is out of range. Received ${t}`, RangeError);
      }
      return t * 1000;
    }
    if (typeof t === "string") {
      const trimmed = t.trim();
      if (trimmed.length > 0) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return n * 1000;
      }
      throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type number, Date, or a numeric string. Received "${t}"`, TypeError);
    }
    throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type number, string, or Date. Received ${t === null ? "null" : typeof t}`, TypeError);
  }

  function utimesSync(path, atime, mtime) {
    hostCall("fs.utimes", JSON.stringify({ path: normPathArg(path), atime: toUtimeMs(atime, "atime"), mtime: toUtimeMs(mtime, "mtime") }));
  }

  function futimesSync(fd, atime, mtime) {
    hostCall("fs.futimes", JSON.stringify({ fd: validateFD(fd), atime: toUtimeMs(atime, "atime"), mtime: toUtimeMs(mtime, "mtime") }));
  }

  class Dir {
    constructor(path, entries) {
      this.path = path;
      this._entries = entries || [];
      this._idx = 0;
      this._closed = false;
    }
    readSync() {
      if (this._closed) {
        throw makeNodeError("ERR_DIR_CLOSED", "Directory handle was closed", Error);
      }
      if (this._idx >= this._entries.length) return null;
      return this._entries[this._idx++];
    }
    read(cb) {
      if (typeof cb === "function") {
        queueMicrotask(() => {
          try { cb(null, this.readSync()); } catch (e) { cb(e); }
        });
        return;
      }
      return Promise.resolve().then(() => this.readSync());
    }
    closeSync() {
      if (this._closed) {
        throw makeNodeError("ERR_DIR_CLOSED", "Directory handle was closed", Error);
      }
      this._closed = true;
    }
    close(cb) {
      if (typeof cb === "function") {
        queueMicrotask(() => {
          try { this.closeSync(); cb(null); } catch (e) { cb(e); }
        });
        return;
      }
      return Promise.resolve().then(() => this.closeSync());
    }
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const d = this.readSync();
          if (d === null) break;
          yield d;
        }
      } finally {
        if (!this._closed) {
          try { this.closeSync(); } catch (_) {}
        }
      }
    }
  }

  function opendirSync(path, options) {
    const p = normPathArg(path);
    const entries = readdirSync(p, Object.assign({}, options, { withFileTypes: true }));
    return new Dir(p, entries);
  }

  function accessSync(path, mode = fsConstants.F_OK) {
    hostCall("fs.access", JSON.stringify({ path: normPathArg(path), mode }));
  }

  function mkdtempSync(prefix, options) {
    const res = hostCall("fs.mkdtemp", normPathArg(prefix));
    return isBufferEncoding(options) ? Buffer.from(res) : res;
  }

  function truncateSync(path, len = 0) {
    hostCall("fs.truncate", JSON.stringify({ path: normPathArg(path), len: Number(len) || 0 }));
  }

  function readlinkSync(path, options) {
    const res = hostCall("fs.readlink", normPathArg(path));
    return isBufferEncoding(options) ? Buffer.from(res) : res;
  }

  function symlinkSync(target, path) {
    hostCall("fs.symlink", JSON.stringify({ target: normPathArg(target), path: normPathArg(path) }));
  }

  function linkSync(existingPath, newPath) {
    hostCall("fs.link", JSON.stringify({ existingPath: normPathArg(existingPath), newPath: normPathArg(newPath) }));
  }

  function globSync(pattern, options = {}) {
    const cwd = options && options.cwd ? normPathArg(options.cwd) : "";
    const withFileTypes = Boolean(options && typeof options === "object" && options.withFileTypes);
    const excludeOpt = options && typeof options === "object" ? options.exclude : null;
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    const strExcludes = Array.isArray(excludeOpt) ? excludeOpt.filter((x) => typeof x === "string") : [];
    const seen = new Set();
    for (const pat of patterns) {
      const list = JSON.parse(hostCall("fs.glob", JSON.stringify({ pattern: String(pat), cwd, exclude: strExcludes }))) || [];
      for (const item of list) seen.add(item);
    }
    let items = Array.from(seen);
    if (!withFileTypes) {
      if (typeof excludeOpt === "function") {
        items = items.filter((item) => !excludeOpt(item));
      }
      return items;
    }
    const baseDir = cwd ? activePath.resolve(processObj.cwd(), cwd) : processObj.cwd();
    const callerCwd = options && options.cwd ? normPathArg(options.cwd) : "";
    let dirents = items.map((rel) => {
      const full = activePath.resolve(baseDir, rel);
      const st = lstatSync(full);
      const relParent = activePath.dirname(rel);
      const parentPath = callerCwd
        ? (relParent === "." ? callerCwd : activePath.join(callerCwd, relParent))
        : relParent;
      return new Dirent({
        name: activePath.basename(rel),
        relPath: rel,
        parentPath,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymlink: st.isSymbolicLink(),
      });
    });
    if (typeof excludeOpt === "function") {
      dirents = dirents.filter((d) => !excludeOpt(d));
    }
    return dirents;
  }

  function openSync(path, flags = "r", mode = 0o666) {
    const flagVal = typeof flags === "string" || typeof flags === "number" ? flags : "r";
    return Number(hostCall("fs.open", JSON.stringify({ path: normPathArg(path), flag: flagVal, mode: mode !== undefined ? mode : 0o666 })));
  }

  function readSync(fd, buffer, offset = 0, length = buffer && buffer.byteLength ? buffer.byteLength - offset : 0, position = null) {
    fd = validateFD(fd);
    if (!buffer || (!ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer))) {
      const err = new TypeError("The \"buffer\" argument must be an instance of Buffer, TypedArray, or DataView");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (typeof offset === "object" && offset !== null) {
      const opts = offset;
      offset = opts.offset !== undefined ? opts.offset : 0;
      length = opts.length !== undefined ? opts.length : buffer.byteLength - offset;
      position = opts.position !== undefined ? opts.position : null;
    }
    offset = Number(offset);
    length = Number(length);
    if (!Number.isInteger(offset) || offset < 0 || offset > buffer.byteLength) {
      const err = new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${buffer.byteLength}. Received ${offset}`);
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (!Number.isInteger(length) || length < 0 || offset + length > buffer.byteLength || length > 64 * 1024 * 1024) {
      const err = new RangeError(`The value of "length" is out of range. It must be >= 0 and <= ${Math.min(buffer.byteLength - offset, 64 * 1024 * 1024)}. Received ${length}`);
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (length === 0) return 0;
    if (fd === 0 && processObj.stdin && Array.isArray(processObj.stdin._bufQueue) && processObj.stdin._bufQueue.length > 0) {
      const head = processObj.stdin._bufQueue[0];
      const n = Math.min(length, head.byteLength);
      const slice = head.subarray(0, n);
      if (n < head.byteLength) {
        processObj.stdin._bufQueue[0] = head.subarray(n);
      } else {
        processObj.stdin._bufQueue.shift();
        try { hostCall("process.stdinPull", ""); } catch (_) {}
      }
      const targetView = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
      targetView.set(slice, offset);
      return n;
    }
    const raw = hostCall("fs.read", JSON.stringify({ fd, length, position }));
    if (!raw || raw.byteLength === 0) return 0;
    const targetView = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
    targetView.set(raw, offset);
    return raw.byteLength;
  }

  function readvSync(fd, buffers, position = null) {
    fd = validateFD(fd);
    if (!Array.isArray(buffers)) {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'buffers' argument must be an Array of ArrayBufferView", TypeError);
    }
    let total = 0;
    let pos = position !== undefined && position !== null ? Number(position) : null;
    for (const buf of buffers) {
      const n = readSync(fd, buf, 0, buf.byteLength, pos);
      total += n;
      if (pos !== null) pos += n;
      if (n < buf.byteLength) break;
    }
    return total;
  }

  function writeSync(fd, bufferOrStr, offsetOrPos, lengthOrEnc, position) {
    fd = validateFD(fd);
    if (typeof bufferOrStr === "string") {
      const pos = typeof offsetOrPos === "number" ? offsetOrPos : null;
      const enc = typeof offsetOrPos === "string" ? offsetOrPos : typeof lengthOrEnc === "string" ? lengthOrEnc : "utf8";
      const bytes = Buffer.from(bufferOrStr, enc);
      return Number(hostCall("fs.write", JSON.stringify({ fd, position: pos }), bytes));
    }
    if (!bufferOrStr || (!ArrayBuffer.isView(bufferOrStr) && !(bufferOrStr instanceof ArrayBuffer))) {
      const err = new TypeError("The \"buffer\" argument must be an instance of Buffer, TypedArray, or DataView, or a string");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (typeof offsetOrPos === "object" && offsetOrPos !== null) {
      const opts = offsetOrPos;
      offsetOrPos = opts.offset !== undefined ? opts.offset : 0;
      lengthOrEnc = opts.length !== undefined ? opts.length : bufferOrStr.byteLength - offsetOrPos;
      position = opts.position !== undefined ? opts.position : null;
    }
    const offset = offsetOrPos !== undefined && offsetOrPos !== null ? Number(offsetOrPos) : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > bufferOrStr.byteLength) {
      const err = new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${bufferOrStr.byteLength}. Received ${offsetOrPos}`);
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    const maxLen = bufferOrStr.byteLength - offset;
    const length = lengthOrEnc !== undefined && lengthOrEnc !== null ? Number(lengthOrEnc) : maxLen;
    if (!Number.isInteger(length) || length < 0 || length > maxLen) {
      const err = new RangeError(`The value of "length" is out of range. It must be >= 0 and <= ${maxLen}. Received ${lengthOrEnc}`);
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    const pos = position !== undefined ? position : null;
    const baseBuf = bufferOrStr instanceof ArrayBuffer ? bufferOrStr : bufferOrStr.buffer;
    const baseOff = bufferOrStr instanceof ArrayBuffer ? 0 : (bufferOrStr.byteOffset || 0);
    const slice = new Uint8Array(baseBuf, baseOff + offset, length);
    return Number(hostCall("fs.write", JSON.stringify({ fd, position: pos }), slice));
  }

  function writevSync(fd, buffers, position = null) {
    fd = validateFD(fd);
    if (!Array.isArray(buffers)) {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'buffers' argument must be an Array of ArrayBufferView", TypeError);
    }
    let total = 0;
    let pos = position !== undefined && position !== null ? Number(position) : null;
    for (const buf of buffers) {
      const n = writeSync(fd, buf, 0, buf.byteLength, pos);
      total += n;
      if (pos !== null) pos += n;
    }
    return total;
  }

  function closeSync(fd) {
    hostCall("fs.close", String(validateFD(fd)));
  }

  function fstatSync(fd, options = {}) {
    return new Stats(JSON.parse(hostCall("fs.fstat", String(validateFD(fd)))), Boolean(options && options.bigint));
  }

  function ftruncateSync(fd, len = 0) {
    hostCall("fs.ftruncate", JSON.stringify({ fd: validateFD(fd), len: Number(len) || 0 }));
  }

  function fsyncSync(fd) {
    hostCall("fs.fsync", String(validateFD(fd)));
  }

  function createReadStream(path, options = {}) {
    if (typeof options === "string") options = { encoding: options };
    const enc = extractEncoding(options);
    const hasStart = options && typeof options === "object" && options.start !== undefined;
    const start = hasStart ? Number(options.start) : 0;
    const end = options && typeof options === "object" && options.end !== undefined ? Number(options.end) : Infinity;
    const autoClose = options && typeof options === "object" && options.autoClose !== undefined ? Boolean(options.autoClose) : true;
    const chunkSize = Math.max(1, Math.min(Number(options && options.highWaterMark) || 64 * 1024, 16 * 1024 * 1024));
    const rawFd = options && typeof options === "object" ? options.fd : null;
    let fd = rawFd !== undefined && rawFd !== null ? Number(typeof rawFd === "object" && typeof rawFd.fd === "number" ? rawFd.fd : rawFd) : null;
    let pos = hasStart ? start : null;
    let bytesReadSoFar = start;
    let openErr = null;
    let closed = false;
    let r;
    if (fd === null && path !== null && path !== undefined) {
      try {
        fd = openSync(path, (options && options.flags) || "r", (options && options.mode) || 0o666);
      } catch (err) {
        openErr = err;
      }
    }
    function closeFd(force = false) {
      if (!closed && fd !== null) {
        if (autoClose || force) {
          closed = true;
          const toClose = fd;
          fd = null;
          if (r) r.fd = null;
          try { closeSync(toClose); } catch (_) {}
        }
      }
    }
    function readChunk(stream) {
      if (stream._eof || stream.destroyed || stream._readingChunk) return;
      if (openErr) {
        const err = openErr;
        openErr = null;
        closeFd();
        stream.destroy(err);
        return;
      }
      if (fd === null) return;
      const curPos = pos !== null ? pos : bytesReadSoFar;
      const remaining = Number.isFinite(end) ? end - curPos + 1 : chunkSize;
      if (remaining <= 0) {
        stream._eof = true;
        closeFd();
        stream.push(null);
        return;
      }
      const toRead = Math.min(chunkSize, remaining);
      stream._readingChunk = true;
      hostAsyncCall("fs.read", JSON.stringify({ fd, length: toRead, position: pos })).then(
        (raw) => {
          stream._readingChunk = false;
          if (stream._eof || stream.destroyed) return;
          const n = raw ? raw.byteLength : 0;
          if (n <= 0) {
            stream._eof = true;
            closeFd();
            stream.push(null);
            return;
          }
          if (pos !== null) pos += n;
          bytesReadSoFar += n;
          const buf = new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
          const more = stream.push(buf);
          if (more && !stream._eof && !stream.destroyed) {
            setImmediate(() => readChunk(stream));
          }
        },
        (err) => {
          stream._readingChunk = false;
          closeFd();
          stream.destroy(err);
        }
      );
    }
    r = new Readable({
      encoding: enc,
      highWaterMark: chunkSize,
      read() {
        readChunk(this);
      },
    });
    r.fd = fd;
    r.autoClose = autoClose;
    r.closed = false;
    r.once("close", () => { r.closed = true; });
    const origDestroy = r.destroy.bind(r);
    r.destroy = function (err) {
      closeFd();
      return origDestroy(err);
    };
    r.close = function (cb) {
      if (typeof cb === "function") {
        if (r.closed || r._closeEmitted) processObj.nextTick(cb);
        else r.once("close", cb);
      }
      closeFd(true);
      r.destroy();
    };
    r.path = path !== null && path !== undefined ? normPathArg(path) : undefined;
    processObj.nextTick(() => {
      if (openErr) {
        const err = openErr;
        openErr = null;
        r.destroy(err);
        return;
      }
      if (fd !== null && !r.destroyed) {
        r.emit("open", fd);
        r.emit("ready");
      }
      readChunk(r);
    });
    return r;
  }

  function createWriteStream(path, options = {}) {
    if (typeof options === "string") options = { encoding: options };
    const defaultEnc = extractEncoding(options) || "utf8";
    const flags = (options && options.flags) || "w";
    const mode = (options && options.mode) || 0o666;
    const autoClose = options && options.autoClose !== undefined ? Boolean(options.autoClose) : true;
    const flushOnClose = Boolean(options && options.flush);
    let pos = options && options.start !== undefined ? Number(options.start) : null;
    const rawFd = options && typeof options === "object" ? options.fd : null;
    let fd = rawFd !== undefined && rawFd !== null ? Number(typeof rawFd === "object" && typeof rawFd.fd === "number" ? rawFd.fd : rawFd) : null;
    let openErr = null;
    let closed = false;
    let w;
    if (fd === null && path !== null && path !== undefined) {
      try {
        fd = openSync(path, flags, mode);
      } catch (err) {
        openErr = err;
      }
    }
    function closeFd(force = false) {
      if (!closed && fd !== null) {
        if (flushOnClose) {
          try { fsyncSync(fd); } catch (_) {}
        }
        if (autoClose || force) {
          closed = true;
          const toClose = fd;
          fd = null;
          if (w) w.fd = null;
          try { closeSync(toClose); } catch (_) {}
        }
      }
    }
    function ensureOpen(stream) {
      if (closed || fd !== null || openErr !== null || stream.destroyed) return;
      try {
        fd = openSync(path, flags, mode);
        stream.fd = fd;
        stream.emit("open", fd);
        stream.emit("ready");
      } catch (err) {
        openErr = err;
        stream.destroy(err);
      }
    }
    w = new Writable({
      highWaterMark: options && options.highWaterMark,
      defaultEncoding: defaultEnc,
      write(chunk, encoding, cb) {
        try {
          ensureOpen(this);
          if (openErr) return cb(openErr);
          const enc = typeof chunk === "string" ? (encoding || defaultEnc) : encoding;
          const bytes = toBytesInput(chunk, enc);
          const n = writeSync(fd, bytes, 0, bytes.byteLength, pos);
          if (pos !== null) pos += n;
          this.bytesWritten = (this.bytesWritten || 0) + n;
          cb();
        } catch (err) {
          cb(err);
        }
      },
      final(cb) {
        ensureOpen(this);
        closeFd();
        cb(openErr);
      },
    });
    w.fd = fd;
    w.autoClose = autoClose;
    w.closed = false;
    w.once("close", () => { w.closed = true; });
    const origDestroy = w.destroy.bind(w);
    w.destroy = function (err) {
      closeFd();
      return origDestroy(err);
    };
    w.close = function (cb) {
      if (typeof cb === "function") {
        if (w.closed || w._closeEmitted) processObj.nextTick(cb);
        else w.once("close", cb);
      }
      closeFd(true);
      w.destroy();
    };
    w.bytesWritten = 0;
    w.path = path !== null && path !== undefined ? normPathArg(path) : undefined;
    processObj.nextTick(() => {
      if (openErr) {
        if (!w.destroyed) w.destroy(openErr);
        return;
      }
      if (fd !== null && !w.destroyed) {
        w.emit("open", fd);
        w.emit("ready");
      }
    });
    return w;
  }

  function checkFsSignal(args) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a && typeof a === "object" && "signal" in a && a.signal !== undefined && a.signal !== null) {
        const sig = a.signal;
        if (typeof sig !== "object" || typeof sig.aborted !== "boolean") {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", "The \"options.signal\" property must be an instance of AbortSignal", TypeError);
        }
        if (sig.aborted) {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: sig.reason });
        }
      }
    }
  }

  function extractSignal(options) {
    if (options && typeof options === "object" && "signal" in options && options.signal !== undefined && options.signal !== null) {
      return options.signal;
    }
    return null;
  }

  function wrapAsync(syncFn) {
    return function (...args) {
      try {
        checkFsSignal(args);
      } catch (err) {
        return Promise.reject(err);
      }
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            checkFsSignal(args);
            resolve(syncFn(...args));
          } catch (err) {
            reject(err);
          }
        });
      });
    };
  }

  function wrapCallback(syncFn) {
    return function (...args) {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      setImmediate(() => {
        let res;
        try {
          checkFsSignal(args);
          res = syncFn(...args);
        } catch (err) {
          if (cb) cb(err);
          return;
        }
        if (cb) cb(null, res);
      });
    };
  }

  async function readFileAsync(path, options) {
    checkFsSignal([options]);
    if (path && typeof path === "object" && typeof path.readFile === "function" && typeof path.fd === "number") {
      return path.readFile(options);
    }
    if (path && typeof path === "object" && typeof path.fd === "number") {
      path = path.fd;
    }
    if (path === 0 || path === "/dev/stdin" || path === "/dev/fd/0" || typeof path === "number") {
      return wrapAsync(readFileSync)(path, options);
    }
    const enc = extractEncoding(options);
    const sig = extractSignal(options);
    const flag = options && typeof options === "object" && options.flag !== undefined ? options.flag : null;
    const argStr = flag !== null ? JSON.stringify({ path: normPathArg(path), flag }) : normPathArg(path);
    const raw = await hostAsyncCall("fs.readFile", argStr, undefined, sig);
    const buf = raw ? new Buffer(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.alloc(0);
    return enc ? buf.toString(enc) : buf;
  }

  async function writeFileAsync(path, data, options) {
    checkFsSignal([options]);
    if (path && typeof path === "object" && typeof path.writeFile === "function" && typeof path.fd === "number") {
      return path.writeFile(data, options);
    }
    if (path && typeof path === "object" && typeof path.fd === "number") {
      path = path.fd;
    }
    if (path === 1 || path === "/dev/stdout" || path === "/dev/fd/1" || path === 2 || path === "/dev/stderr" || path === "/dev/fd/2" || typeof path === "number") {
      return wrapAsync(writeFileSync)(path, data, options);
    }
    const enc = extractEncoding(options);
    const bytes = toBytesInput(data, enc);
    const sig = extractSignal(options);
    const mode = options && typeof options === "object" && options.mode !== undefined ? options.mode : 0o666;
    const flag = options && typeof options === "object" && options.flag ? options.flag : "w";
    await hostAsyncCall("fs.writeFile", JSON.stringify({ path: normPathArg(path), mode, flag }), bytes, sig);
  }

  async function appendFileAsync(path, data, options) {
    checkFsSignal([options]);
    if (path && typeof path === "object" && typeof path.appendFile === "function" && typeof path.fd === "number") {
      return path.appendFile(data, options);
    }
    if (path && typeof path === "object" && typeof path.fd === "number") {
      path = path.fd;
    }
    if (path === 1 || path === "/dev/stdout" || path === "/dev/fd/1" || path === 2 || path === "/dev/stderr" || path === "/dev/fd/2" || typeof path === "number") {
      return wrapAsync(appendFileSync)(path, data, options);
    }
    const enc = extractEncoding(options);
    const bytes = toBytesInput(data, enc);
    const sig = extractSignal(options);
    const mode = options && typeof options === "object" && options.mode !== undefined ? options.mode : 0o666;
    const flag = options && typeof options === "object" && options.flag ? options.flag : "a";
    await hostAsyncCall("fs.appendFile", JSON.stringify({ path: normPathArg(path), mode, flag }), bytes, sig);
  }

  class FileHandle extends EventEmitter {
    constructor(fd) {
      super();
      this.fd = fd;
    }
    _ensureOpen(syscall = "read") {
      if (this.fd === null || this.fd === undefined || this.fd < 0) {
        const err = new Error(`EBADF: bad file descriptor, ${syscall}`);
        err.code = "EBADF";
        err.errno = -9;
        err.syscall = syscall;
        throw err;
      }
      return this.fd;
    }
    async read(buffer, offset, length, position) {
      const fd = this._ensureOpen("read");
      if (buffer === undefined || buffer === null) {
        buffer = Buffer.alloc(16384);
        offset = 0;
        length = buffer.byteLength;
        position = null;
      } else if (typeof buffer === "object" && !ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
        const opts = buffer;
        buffer = opts.buffer !== undefined && opts.buffer !== null ? opts.buffer : Buffer.alloc(16384);
        offset = opts.offset !== undefined && opts.offset !== null ? Number(opts.offset) : 0;
        length = opts.length !== undefined && opts.length !== null ? Number(opts.length) : buffer.byteLength - offset;
        position = opts.position !== undefined ? opts.position : null;
      } else {
        if (offset === undefined || offset === null) offset = 0;
        if (length === undefined || length === null) length = buffer.byteLength - offset;
        if (position === undefined) position = null;
      }
      const bytesRead = readSync(fd, buffer, offset, length, position);
      return { bytesRead, buffer };
    }
    async write(buffer, offset, length, position) {
      const fd = this._ensureOpen("write");
      if (typeof buffer === "string") {
        const bytesWritten = writeSync(fd, buffer, offset, length);
        return { bytesWritten, buffer };
      }
      const off = offset !== undefined ? offset : 0;
      const len = length !== undefined ? length : buffer.byteLength - off;
      const pos = position !== undefined ? position : null;
      const bytesWritten = writeSync(fd, buffer, off, len, pos);
      return { bytesWritten, buffer };
    }
    async readFile(options) {
      const fd = this._ensureOpen("read");
      checkFsSignal([options]);
      return readFileSync(fd, options);
    }
    async writeFile(data, options) {
      const fd = this._ensureOpen("write");
      checkFsSignal([options]);
      const bytes = toBytesInput(data, extractEncoding(options));
      writeSync(fd, bytes, 0, bytes.byteLength, null);
    }
    async appendFile(data, options) {
      return this.writeFile(data, options);
    }
    async readv(buffers, position = null) {
      const fd = this._ensureOpen("readv");
      const bytesRead = readvSync(fd, buffers, position);
      return { bytesRead, buffers };
    }
    async writev(buffers, position = null) {
      const fd = this._ensureOpen("writev");
      const bytesWritten = writevSync(fd, buffers, position);
      return { bytesWritten, buffers };
    }
    createReadStream(options) {
      const fd = this._ensureOpen("read");
      const autoClose = options && options.autoClose !== undefined ? Boolean(options.autoClose) : true;
      const rs = createReadStream(null, Object.assign({}, options, { fd, autoClose: false }));
      if (autoClose) {
        rs.once("close", () => {
          this.close().catch(() => {});
        });
      }
      return rs;
    }
    createWriteStream(options) {
      const fd = this._ensureOpen("write");
      const autoClose = options && options.autoClose !== undefined ? Boolean(options.autoClose) : true;
      const ws = createWriteStream(null, Object.assign({}, options, { fd, autoClose: false }));
      if (autoClose) {
        ws.once("close", () => {
          this.close().catch(() => {});
        });
      }
      return ws;
    }
    readLines(options) {
      return builtins["readline"].createInterface({
        input: this.createReadStream(options),
        crlfDelay: Infinity,
      });
    }
    async stat(options) { return fstatSync(this._ensureOpen("fstat"), options); }
    async chmod(mode) { fchmodSync(this._ensureOpen("fchmod"), mode); }
    async chown(uid, gid) { fchownSync(this._ensureOpen("fchown"), uid, gid); }
    async utimes(atime, mtime) { futimesSync(this._ensureOpen("futimes"), atime, mtime); }
    async truncate(len = 0) { ftruncateSync(this._ensureOpen("ftruncate"), len); }
    async sync() { fsyncSync(this._ensureOpen("fsync")); }
    async datasync() { fsyncSync(this._ensureOpen("fdatasync")); }
    async close() {
      if (this.fd !== null && this.fd !== undefined && this.fd >= 0) {
        const fd = this.fd;
        this.fd = -1;
        closeSync(fd);
        this.emit("close");
      }
    }
    async [Symbol.asyncDispose || Symbol.for("nodejs.asyncDispose")]() {
      await this.close();
    }
  }

  const activeFileWatchers = new Map();

  function scanDirWatchSnapshot(dirPath, recursive) {
    const snap = new Map();
    try {
      const entries = readdirSync(dirPath, { recursive: Boolean(recursive) });
      for (const rel of entries) {
        const relStr = String(rel);
        try {
          const st = statSync(activePath.join(dirPath, relStr));
          snap.set(relStr, {
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
            size: st.size,
            isDir: st.isDirectory(),
          });
        } catch (_) {}
      }
    } catch (_) {}
    return snap;
  }

  function watch(filename, options, listener) {
    if (typeof options === "function") {
      listener = options;
      options = {};
    }
    if (typeof options === "string") {
      options = { encoding: options };
    }
    options = options || {};
    if (options.signal) {
      if (typeof options.signal !== "object" || typeof options.signal.aborted !== "boolean") {
        const err = new TypeError("The \"options.signal\" property must be an instance of AbortSignal");
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
    }
    const wantBuf = isBufferEncoding(options);
    const enc = wantBuf ? null : extractEncoding(options);
    const fmtName = (n) => {
      if ( n === null || n === undefined) return n;
      const s = String(n);
      if (wantBuf) return Buffer.from(s);
      if (enc && enc !== "utf8") return Buffer.from(s).toString(enc);
      return s;
    };
    const targetPath = normPathArg(filename);
    const stInit = statSync(targetPath);
    const intervalMs = Math.max(15, Number(options.interval) || 25);
    const watcher = new EventEmitter();
    let lastMtime = stInit.mtimeMs;
    let lastCtime = stInit.ctimeMs;
    let lastSize = stInit.size;
    let lastExists = true;
    let isDir = stInit.isDirectory();
    let dirSnap = isDir ? scanDirWatchSnapshot(targetPath, options.recursive) : null;

    if (typeof listener === "function") {
      watcher.on("change", listener);
    }
    const timer = setInterval(() => {
      try {
        const st = statSync(targetPath);
        if (st.isDirectory()) {
          if (!isDir || !dirSnap) {
            isDir = true;
            dirSnap = scanDirWatchSnapshot(targetPath, options.recursive);
          } else {
            const nextSnap = scanDirWatchSnapshot(targetPath, options.recursive);
            for (const [rel, info] of nextSnap.entries()) {
              const prev = dirSnap.get(rel);
              if (!prev) {
                watcher.emit("change", "rename", fmtName(rel));
                if (!info.isDir) {
                  watcher.emit("change", "change", fmtName(rel));
                }
              } else if (info.mtimeMs !== prev.mtimeMs || info.ctimeMs !== prev.ctimeMs || info.size !== prev.size) {
                watcher.emit("change", "change", fmtName(rel));
              }
            }
            for (const [rel] of dirSnap.entries()) {
              if (!nextSnap.has(rel)) {
                watcher.emit("change", "rename", fmtName(rel));
              }
            }
            dirSnap = nextSnap;
          }
          lastExists = true;
          return;
        }
        if (!lastExists) {
          lastExists = true;
          lastMtime = st.mtimeMs;
          lastCtime = st.ctimeMs;
          lastSize = st.size;
          watcher.emit("change", "rename", fmtName(activePath.basename(targetPath)));
        } else if (st.mtimeMs !== lastMtime || st.ctimeMs !== lastCtime || st.size !== lastSize) {
          lastMtime = st.mtimeMs;
          lastCtime = st.ctimeMs;
          lastSize = st.size;
          watcher.emit("change", "change", fmtName(activePath.basename(targetPath)));
        }
      } catch (_) {
        if (lastExists) {
          lastExists = false;
          lastMtime = null;
          lastCtime = null;
          lastSize = null;
          watcher.emit("change", "rename", fmtName(activePath.basename(targetPath)));
        }
      }
    }, intervalMs);
    if (options.persistent === false) timer.unref();
    let closedWatcher = false;
    watcher.close = function () {
      if (closedWatcher) return;
      closedWatcher = true;
      clearInterval(timer);
      watcher.emit("close");
    };
    watcher.ref = function () { timer.ref(); return watcher; };
    watcher.unref = function () { timer.unref(); return watcher; };
    if (options.signal) {
      if (options.signal.aborted) {
        clearInterval(timer);
        processObj.nextTick(() => watcher.close());
      } else {
        options.signal.addEventListener("abort", () => watcher.close(), { once: true });
      }
    }
    return watcher;
  }

  function watchFile(filename, options, listener) {
    if (typeof options === "function") {
      listener = options;
      options = {};
    }
    if (typeof listener !== "function") {
      throw new TypeError("The \"listener\" argument must be of type function");
    }
    options = options || {};
    const targetPath = normPathArg(filename);
    const intervalMs = Math.max(25, Number(options.interval) || 100);
    const emptyStat = () => new Stats({ size: 0, mode: 0, mtimeMs: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0 });
    let prevStat = emptyStat();
    try {
      prevStat = statSync(targetPath);
    } catch (_) {}
    let entry = activeFileWatchers.get(targetPath);
    if (!entry) {
      const ee = new EventEmitter();
      const timer = setInterval(() => {
        let currStat = emptyStat();
        try {
          currStat = statSync(targetPath);
        } catch (_) {}
        if (currStat.mtimeMs !== prevStat.mtimeMs || currStat.size !== prevStat.size) {
          const old = prevStat;
          prevStat = currStat;
          ee.emit("change", currStat, old);
        }
      }, intervalMs);
      if (options.persistent === false) timer.unref();
      entry = { ee, timer };
      activeFileWatchers.set(targetPath, entry);
    }
    entry.ee.on("change", listener);
    return entry.ee;
  }

  function unwatchFile(filename, listener) {
    const targetPath = normPathArg(filename);
    const entry = activeFileWatchers.get(targetPath);
    if (!entry) return;
    if (typeof listener === "function") {
      entry.ee.removeListener("change", listener);
      if (entry.ee.listenerCount("change") === 0) {
        clearInterval(entry.timer);
        activeFileWatchers.delete(targetPath);
      }
    } else {
      entry.ee.removeAllListeners("change");
      clearInterval(entry.timer);
      activeFileWatchers.delete(targetPath);
    }
  }

  function statfsSync(path, options) {
    statSync(path);
    const bigint = Boolean(options && options.bigint);
    const v = (n) => (bigint ? BigInt(n) : n);
    return {
      type: v(0),
      bsize: v(4096),
      blocks: v(1048576),
      bfree: v(524288),
      bavail: v(524288),
      files: v(1048576),
      ffree: v(524288),
    };
  }

  async function openAsBlob(path, options = {}) {
    const buf = readFileSync(path);
    return new Blob([buf], { type: (options && options.type) ? String(options.type) : "" });
  }

  async function statAsync(path, options = {}) {
    checkFsSignal([options]);
    try {
      const raw = JSON.parse(await hostAsyncCall("fs.stat", normPathArg(path), undefined, extractSignal(options)));
      return new Stats(raw, Boolean(options && options.bigint));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  async function lstatAsync(path, options = {}) {
    checkFsSignal([options]);
    try {
      const raw = JSON.parse(await hostAsyncCall("fs.lstat", normPathArg(path), undefined, extractSignal(options)));
      return new Stats(raw, Boolean(options && options.bigint));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  async function readdirAsync(path, options = {}) {
    checkFsSignal([options]);
    const enc = extractEncoding(options);
    const withFileTypes = Boolean(options && typeof options === "object" && options.withFileTypes);
    const recursive = Boolean(options && typeof options === "object" && options.recursive);
    const wantBuf = isBufferEncoding(options);
    const callerBase = normPathArg(path);
    const rawStr = await hostAsyncCall("fs.readdir", JSON.stringify({ path: callerBase, recursive }), undefined, extractSignal(options));
    const entries = JSON.parse(rawStr) || [];
    if (withFileTypes) {
      const isRel = !activePath.isAbsolute(callerBase);
      return entries.map((e) => {
        let d;
        if (isRel) {
          const relDir = e.relPath && e.relPath.includes(activePath.sep) ? activePath.dirname(e.relPath) : "";
          const parentPath = relDir ? activePath.join(callerBase, relDir) : callerBase;
          d = new Dirent(Object.assign({}, e, { parentPath }));
        } else {
          d = new Dirent(e);
        }
        if (wantBuf) {
          d.name = Buffer.from(d.name);
          d.parentPath = Buffer.from(d.parentPath);
          d.path = d.parentPath;
        }
        return d;
      });
    }
    return entries.map((e) => {
      const name = recursive ? e.relPath : e.name;
      if (wantBuf) return Buffer.from(name);
      return enc && enc !== "utf8" ? Buffer.from(name).toString(enc) : name;
    });
  }

  async function mkdirAsync(path, options) {
    checkFsSignal([options]);
    let recursive = false;
    let mode = 0o777;
    if (typeof options === "number") mode = options;
    else if (options && typeof options === "object") {
      recursive = Boolean(options.recursive);
      if (options.mode !== undefined) mode = options.mode;
    }
    const created = await hostAsyncCall("fs.mkdir", JSON.stringify({ path: normPathArg(path), recursive, mode }), undefined, extractSignal(options));
    return recursive ? (created || undefined) : undefined;
  }

  async function rmAsync(path, options = {}) {
    checkFsSignal([options]);
    const recursive = Boolean(options && options.recursive);
    const force = Boolean(options && options.force);
    await hostAsyncCall("fs.rm", JSON.stringify({ path: normPathArg(path), recursive, force }), undefined, extractSignal(options));
  }

  async function rmdirAsync(path, options = {}) {
    checkFsSignal([options]);
    const recursive = Boolean(options && options.recursive);
    await hostAsyncCall("fs.rmdir", JSON.stringify({ path: normPathArg(path), recursive }), undefined, extractSignal(options));
  }

  async function unlinkAsync(path) {
    await hostAsyncCall("fs.unlink", normPathArg(path));
  }

  async function renameAsync(oldPath, newPath) {
    await hostAsyncCall("fs.rename", JSON.stringify({ oldPath: normPathArg(oldPath), newPath: normPathArg(newPath) }));
  }

  async function copyFileAsync(src, dest, mode = 0) {
    await hostAsyncCall("fs.copyFile", JSON.stringify({ src: normPathArg(src), dest: normPathArg(dest), flags: Number(mode) || 0 }));
  }

  async function cpAsync(src, dest, options = {}) {
    checkFsSignal([options]);
    if (options && typeof options.filter === "function") {
      return wrapAsync(cpSync)(src, dest, options);
    }
    const recursive = Boolean(options && options.recursive);
    const force = options && options.force !== undefined ? Boolean(options.force) : true;
    const errorOnExist = Boolean(options && options.errorOnExist);
    const dereference = Boolean(options && options.dereference);
    await hostAsyncCall("fs.cp", JSON.stringify({ src: normPathArg(src), dest: normPathArg(dest), recursive, force, errorOnExist, dereference }), undefined, extractSignal(options));
  }

  async function realpathAsync(path, options) {
    const res = await hostAsyncCall("fs.realpath", normPathArg(path));
    return isBufferEncoding(options) ? Buffer.from(res) : res;
  }

  async function chmodAsync(path, mode) {
    await hostAsyncCall("fs.chmod", JSON.stringify({ path: normPathArg(path), mode: parseFileMode(mode) }));
  }

  async function chownAsync(path, uid, gid) {
    await hostAsyncCall("fs.chown", JSON.stringify({ path: normPathArg(path), uid: Number(uid), gid: Number(gid) }));
  }

  async function lchownAsync(path, uid, gid) {
    await hostAsyncCall("fs.lchown", JSON.stringify({ path: normPathArg(path), uid: Number(uid), gid: Number(gid) }));
  }

  async function utimesAsync(path, atime, mtime) {
    await hostAsyncCall("fs.utimes", JSON.stringify({ path: normPathArg(path), atime: toUtimeMs(atime, "atime"), mtime: toUtimeMs(mtime, "mtime") }));
  }

  async function accessAsync(path, mode = fsConstants.F_OK) {
    await hostAsyncCall("fs.access", JSON.stringify({ path: normPathArg(path), mode }));
  }

  async function mkdtempAsync(prefix, options) {
    const res = await hostAsyncCall("fs.mkdtemp", normPathArg(prefix));
    return isBufferEncoding(options) ? Buffer.from(res) : res;
  }

  async function truncateAsync(path, len = 0) {
    await hostAsyncCall("fs.truncate", JSON.stringify({ path: normPathArg(path), len: Number(len) || 0 }));
  }

  async function readlinkAsync(path, options) {
    const res = await hostAsyncCall("fs.readlink", normPathArg(path));
    return isBufferEncoding(options) ? Buffer.from(res) : res;
  }

  async function symlinkAsync(target, path) {
    await hostAsyncCall("fs.symlink", JSON.stringify({ target: normPathArg(target), path: normPathArg(path) }));
  }

  async function linkAsync(existingPath, newPath) {
    await hostAsyncCall("fs.link", JSON.stringify({ existingPath: normPathArg(existingPath), newPath: normPathArg(newPath) }));
  }

  const fsPromises = {
    constants: fsConstants,
    readFile: readFileAsync,
    writeFile: writeFileAsync,
    appendFile: appendFileAsync,
    stat: statAsync,
    statfs: wrapAsync(statfsSync),
    lstat: lstatAsync,
    readdir: readdirAsync,
    mkdir: mkdirAsync,
    rm: rmAsync,
    rmdir: rmdirAsync,
    unlink: unlinkAsync,
    rename: renameAsync,
    copyFile: copyFileAsync,
    cp: cpAsync,
    realpath: realpathAsync,
    chmod: chmodAsync,
    lchmod: chmodAsync,
    chown: chownAsync,
    lchown: lchownAsync,
    utimes: utimesAsync,
    lutimes: utimesAsync,
    access: accessAsync,
    mkdtemp: mkdtempAsync,
    truncate: truncateAsync,
    readlink: readlinkAsync,
    symlink: symlinkAsync,
    link: linkAsync,
    opendir: async (path, options) => {
      const p = normPathArg(path);
      const entries = await readdirAsync(p, Object.assign({}, options, { withFileTypes: true }));
      return new Dir(p, entries);
    },
    glob: async function* (pattern, options) {
      checkFsSignal([options]);
      const list = globSync(pattern, options);
      for (const item of list) yield item;
    },
    watch: async function* (filename, options = {}) {
      const queue = [];
      let resolveNext = null;
      let done = false;
      const w = watch(filename, options, (eventType, fname) => {
        const item = { eventType, filename: fname };
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: item, done: false });
        } else {
          queue.push(item);
        }
      });
      w.on("close", () => {
        done = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined, done: true });
        }
      });
      try {
        while (!done) {
          if (queue.length > 0) {
            yield queue.shift();
          } else {
            const next = await new Promise((res) => { resolveNext = res; });
            if (next.done) break;
            yield next.value;
          }
        }
      } finally {
        w.close();
      }
    },
    async open(path, flags = "r", mode = 0o666) {
      return new FileHandle(openSync(path, flags, mode));
    },
  };

  const fsMod = {
    constants: fsConstants,
    F_OK: fsConstants.F_OK,
    R_OK: fsConstants.R_OK,
    W_OK: fsConstants.W_OK,
    X_OK: fsConstants.X_OK,
    Stats,
    Dirent,
    Dir,
    promises: fsPromises,
    readFileSync,
    writeFileSync,
    appendFileSync,
    existsSync,
    statSync,
    statfsSync,
    lstatSync,
    readdirSync,
    opendirSync,
    mkdirSync,
    rmSync,
    rmdirSync,
    unlinkSync,
    renameSync,
    copyFileSync,
    cpSync,
    realpathSync,
    chmodSync,
    lchmodSync: chmodSync,
    fchmodSync,
    chownSync,
    lchownSync,
    fchownSync,
    utimesSync,
    lutimesSync: utimesSync,
    futimesSync,
    accessSync,
    mkdtempSync,
    truncateSync,
    readlinkSync,
    symlinkSync,
    linkSync,
    globSync,
    openSync,
    openAsBlob,
    readSync,
    readvSync,
    writeSync,
    writevSync,
    closeSync,
    fstatSync,
    ftruncateSync,
    fsyncSync,
    fdatasyncSync: fsyncSync,
    createReadStream,
    createWriteStream,
    ReadStream: createReadStream,
    WriteStream: createWriteStream,
    readFile(path, options, cb) {
      if (typeof options === "function") { cb = options; options = undefined; }
      readFileAsync(path, options).then((res) => { if (cb) cb(null, res); }, (err) => { if (cb) cb(err); });
    },
    writeFile(path, data, options, cb) {
      if (typeof options === "function") { cb = options; options = undefined; }
      writeFileAsync(path, data, options).then(() => { if (cb) cb(null); }, (err) => { if (cb) cb(err); });
    },
    appendFile(path, data, options, cb) {
      if (typeof options === "function") { cb = options; options = undefined; }
      appendFileAsync(path, data, options).then(() => { if (cb) cb(null); }, (err) => { if (cb) cb(err); });
    },
    exists(path, cb) {
      setImmediate(() => { if (typeof cb === "function") cb(existsSync(path)); });
    },
    stat: wrapCallback(statSync),
    statfs: wrapCallback(statfsSync),
    lstat: wrapCallback(lstatSync),
    readdir: wrapCallback(readdirSync),
    opendir: wrapCallback(opendirSync),
    mkdir: wrapCallback(mkdirSync),
    rm: wrapCallback(rmSync),
    rmdir: wrapCallback(rmdirSync),
    unlink: wrapCallback(unlinkSync),
    rename: wrapCallback(renameSync),
    copyFile: wrapCallback(copyFileSync),
    cp: wrapCallback(cpSync),
    realpath: Object.assign(wrapCallback(realpathSync), { native: wrapCallback(realpathSync) }),
    chmod: wrapCallback(chmodSync),
    lchmod: wrapCallback(chmodSync),
    fchmod: wrapCallback(fchmodSync),
    chown: wrapCallback(chownSync),
    lchown: wrapCallback(lchownSync),
    fchown: wrapCallback(fchownSync),
    utimes: wrapCallback(utimesSync),
    lutimes: wrapCallback(utimesSync),
    futimes: wrapCallback(futimesSync),
    access: wrapCallback(accessSync),
    mkdtemp: wrapCallback(mkdtempSync),
    truncate: wrapCallback(truncateSync),
    readlink: wrapCallback(readlinkSync),
    symlink: wrapCallback(symlinkSync),
    link: wrapCallback(linkSync),
    glob: wrapCallback(globSync),
    open: wrapCallback(openSync),
    read(fd, buffer, offset, length, position, cb) {
      if (typeof buffer === "function") {
        cb = buffer;
        buffer = Buffer.alloc(16384);
        offset = 0;
        length = buffer.byteLength;
        position = null;
      } else if (typeof offset === "function") {
        cb = offset;
        if (buffer && typeof buffer === "object" && !ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
          const opts = buffer;
          buffer = opts.buffer || Buffer.alloc(16384);
          offset = opts.offset !== undefined ? opts.offset : 0;
          length = opts.length !== undefined ? opts.length : buffer.byteLength - offset;
          position = opts.position !== undefined ? opts.position : null;
        } else {
          offset = 0;
          length = buffer.byteLength;
          position = null;
        }
      } else if (typeof length === "function") {
        cb = length;
        if (offset && typeof offset === "object") {
          const opts = offset;
          offset = opts.offset !== undefined ? opts.offset : 0;
          length = opts.length !== undefined ? opts.length : buffer.byteLength - offset;
          position = opts.position !== undefined ? opts.position : null;
        } else {
          length = buffer.byteLength - (Number(offset) || 0);
          position = null;
        }
      } else if (typeof position === "function") {
        cb = position;
        position = null;
      }
      queueMicrotask(() => {
        let n;
        try {
          n = readSync(fd, buffer, offset, length, position);
        } catch (err) {
          if (cb) cb(err);
          return;
        }
        if (cb) cb(null, n, buffer);
      });
    },
    write(fd, buffer, offset, length, position, cb) {
      if (typeof buffer === "string") {
        let pos = null;
        let enc = "utf8";
        if (typeof offset === "function") {
          cb = offset;
        } else if (typeof length === "function") {
          cb = length;
          if (typeof offset === "number") pos = offset;
          else if (typeof offset === "string") enc = offset;
        } else if (typeof position === "function") {
          cb = position;
          if (typeof offset === "number") pos = offset;
          if (typeof length === "string") enc = length;
        }
        queueMicrotask(() => {
          let n;
          try {
            n = writeSync(fd, buffer, pos, enc);
          } catch (err) {
            if (cb) cb(err);
            return;
          }
          if (cb) cb(null, n, buffer);
        });
        return;
      }
      if (typeof offset === "function") {
        cb = offset;
        offset = 0;
        length = buffer.byteLength;
        position = null;
      } else if (typeof length === "function") {
        cb = length;
        length = buffer.byteLength - (offset || 0);
        position = null;
      } else if (typeof position === "function") {
        cb = position;
        position = null;
      }
      queueMicrotask(() => {
        let n;
        try {
          n = writeSync(fd, buffer, offset, length, position);
        } catch (err) {
          if (cb) cb(err);
          return;
        }
        if (cb) cb(null, n, buffer);
      });
    },
    close: wrapCallback(closeSync),
    readv(fd, buffers, position, cb) {
      if (typeof position === "function") {
        cb = position;
        position = null;
      }
      queueMicrotask(() => {
        let n;
        try {
          n = readvSync(fd, buffers, position);
        } catch (err) {
          if (cb) cb(err);
          return;
        }
        if (cb) cb(null, n, buffers);
      });
    },
    writev(fd, buffers, position, cb) {
      if (typeof position === "function") {
        cb = position;
        position = null;
      }
      queueMicrotask(() => {
        let n;
        try {
          n = writevSync(fd, buffers, position);
        } catch (err) {
          if (cb) cb(err);
          return;
        }
        if (cb) cb(null, n, buffers);
      });
    },
    fstat: wrapCallback(fstatSync),
    ftruncate: wrapCallback(ftruncateSync),
    fsync: wrapCallback(fsyncSync),
    fdatasync: wrapCallback(fsyncSync),
    watch,
    watchFile,
    unwatchFile,
  };

  builtins["fs"] = fsMod;
  builtins["fs/promises"] = fsPromises;

  // =========================================================================
  // 12. OS
  // =========================================================================

  const isWin = processObj.platform === "win32";
  const initialOSMetrics = init.osMetrics || {};
  function fetchLiveOSMetrics() {
    try {
      return JSON.parse(hostCall("os.info", ""));
    } catch (_) {
      return initialOSMetrics;
    }
  }
  const osMod = {
    EOL: isWin ? "\r\n" : "\n",
    devNull: isWin ? "\\\\.\\nul" : "/dev/null",
    arch: () => processObj.arch,
    platform: () => processObj.platform,
    type: () => (isWin ? "Windows_NT" : processObj.platform === "darwin" ? "Darwin" : "Linux"),
    release: () => initialOSMetrics.release || (isWin ? "10.0.22631" : processObj.platform === "darwin" ? "23.5.0" : "6.6.0"),
    version: () => initialOSMetrics.version || (isWin ? "Windows 11 Pro" : processObj.platform === "darwin" ? "Darwin Kernel Version 23.5.0" : "#1 SMP PREEMPT_DYNAMIC"),
    machine: () => processObj.arch,
    homedir: () => init.homedir || processObj.env.HOME || processObj.env.USERPROFILE || "/",
    tmpdir: () => init.tmpdir || processObj.env.TMPDIR || processObj.env.TEMP || "/tmp",
    hostname: () => init.hostname || "localhost",
    endianness: () => "LE",
    availableParallelism: () => init.cpus || 1,
    cpus() {
      const m = fetchLiveOSMetrics();
      const count = init.cpus || 1;
      const model = m.cpuModel || initialOSMetrics.cpuModel || "CPU";
      const speed = m.cpuSpeed || initialOSMetrics.cpuSpeed || 2400;
      const baseTimes = m.cpuTimes || initialOSMetrics.cpuTimes || { user: 1000, nice: 0, sys: 500, idle: 10000, irq: 0 };
      const list = [];
      for (let i = 0; i < count; i++) {
        list.push({
          model,
          speed,
          times: {
            user: Math.max(1, Math.floor((baseTimes.user || 1000) / count)),
            nice: Math.floor((baseTimes.nice || 0) / count),
            sys: Math.max(1, Math.floor((baseTimes.sys || 500) / count)),
            idle: Math.max(1, Math.floor((baseTimes.idle || 10000) / count)),
            irq: Math.floor((baseTimes.irq || 0) / count),
          },
        });
      }
      return list;
    },
    totalmem: () => {
      const m = fetchLiveOSMetrics();
      return m.totalmem || m.totalMem || initialOSMetrics.totalmem || initialOSMetrics.totalMem || 8 * 1024 * 1024 * 1024;
    },
    freemem: () => {
      const m = fetchLiveOSMetrics();
      return m.freemem || m.freeMem || initialOSMetrics.freemem || initialOSMetrics.freeMem || 4 * 1024 * 1024 * 1024;
    },
    uptime: () => {
      const m = fetchLiveOSMetrics();
      return m.uptime !== undefined ? m.uptime : Math.floor(perfObj.now() / 1000);
    },
    loadavg: () => {
      if (isWin) return [0, 0, 0];
      const m = fetchLiveOSMetrics();
      const la = m.loadavg || m.loadAvg;
      return Array.isArray(la) && la.length === 3 ? la : [0, 0, 0];
    },
    userInfo: () => JSON.parse(hostCall("os.userInfo", "")),
    networkInterfaces: () => JSON.parse(hostCall("os.networkInterfaces", "")),
    getPriority: () => 0,
    setPriority: () => {},
    constants: {
      UV_UDP_REUSEADDR: 4,
      dlopen: {
        RTLD_LAZY: 1,
        RTLD_NOW: 2,
        RTLD_GLOBAL: 256,
        RTLD_LOCAL: 0,
      },
      signals: Object.assign(
        {
          SIGHUP: 1,
          SIGINT: 2,
          SIGQUIT: 3,
          SIGILL: 4,
          SIGTRAP: 5,
          SIGABRT: isWin ? 22 : 6,
          SIGIOT: isWin ? 22 : 6,
          SIGBUS: 7,
          SIGFPE: 8,
          SIGKILL: 9,
          SIGUSR1: 10,
          SIGSEGV: 11,
          SIGUSR2: 12,
          SIGPIPE: 13,
          SIGALRM: 14,
          SIGTERM: 15,
          SIGCHLD: 17,
          SIGCONT: 18,
          SIGSTOP: 19,
          SIGTSTP: 20,
          SIGTTIN: 21,
          SIGTTOU: 22,
          SIGURG: 23,
          SIGXCPU: 24,
          SIGXFSZ: 25,
          SIGVTALRM: 26,
          SIGPROF: 27,
          SIGWINCH: 28,
          SIGIO: 29,
          SIGINFO: 29,
          SIGSYS: 31,
        },
        isWin ? { SIGBREAK: 21 } : {}
      ),
      errno: {
        E2BIG: 7,
        EACCES: 13,
        EADDRINUSE: isWin ? 100 : 98,
        EADDRNOTAVAIL: 99,
        EAFNOSUPPORT: 97,
        EAGAIN: 11,
        EALREADY: 114,
        EBADF: 9,
        EBADMSG: 74,
        EBUSY: 16,
        ECANCELED: 125,
        ECHILD: 10,
        ECONNABORTED: 103,
        ECONNREFUSED: isWin ? 107 : 111,
        ECONNRESET: 104,
        EDEADLK: 35,
        EDESTADDRREQ: 89,
        EDOM: 33,
        EDQUOT: 122,
        EEXIST: 17,
        EFAULT: 14,
        EFBIG: 27,
        EHOSTUNREACH: 113,
        EIDRM: 43,
        EILSEQ: 84,
        EINPROGRESS: 115,
        EINTR: 4,
        EINVAL: 22,
        EIO: 5,
        EISCONN: 106,
        EISDIR: 21,
        ELOOP: 40,
        EMFILE: 24,
        EMLINK: 31,
        EMSGSIZE: 90,
        EMULTIHOP: 72,
        ENAMETOOLONG: 36,
        ENETDOWN: 100,
        ENETRESET: 102,
        ENETUNREACH: 101,
        ENFILE: 23,
        ENOBUFS: 105,
        ENODATA: 61,
        ENODEV: 19,
        ENOENT: 2,
        ENOEXEC: 8,
        ENOLCK: 37,
        ENOLINK: 67,
        ENOMEM: 12,
        ENOMSG: 42,
        ENOPROTOOPT: 92,
        ENOSPC: 28,
        ENOSR: 63,
        ENOSTR: 60,
        ENOSYS: 38,
        ENOTCONN: 107,
        ENOTDIR: 20,
        ENOTEMPTY: 39,
        ENOTSOCK: 88,
        ENOTSUP: 95,
        ENOTTY: 25,
        ENXIO: 6,
        EOPNOTSUPP: 95,
        EOVERFLOW: 75,
        EPERM: 1,
        EPIPE: 32,
        EPROTO: 71,
        EPROTONOSUPPORT: 93,
        EPROTOTYPE: 91,
        ERANGE: 34,
        EROFS: 30,
        ESPIPE: 29,
        ESRCH: 3,
        ESTALE: 116,
        ETIME: 62,
        ETIMEDOUT: 110,
        ETXTBSY: 26,
        EWOULDBLOCK: 11,
        EXDEV: 18,
      },
      priority: {
        PRIORITY_LOW: 19,
        PRIORITY_BELOW_NORMAL: 10,
        PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7,
        PRIORITY_HIGH: -14,
        PRIORITY_HIGHEST: -20,
      },
    },
  };
  builtins["os"] = osMod;

  // =========================================================================
  // 13. Child Process & Agent Shell Helper ($)
  // =========================================================================

  function normalizeEnvOption(envOpt) {
    if (envOpt === undefined || envOpt === null) return undefined;
    const out = Object.create(null);
    for (const [k, v] of Object.entries(envOpt)) {
      if (v !== undefined) out[String(k)] = String(v);
    }
    return out;
  }

  function normalizeStdioOption(stdio) {
    if (typeof stdio === "string") return [stdio, stdio, stdio];
    if (Array.isArray(stdio)) {
      return [
        stdio[0] === null || stdio[0] === undefined ? "pipe" : String(stdio[0]),
        stdio[1] === null || stdio[1] === undefined ? "pipe" : String(stdio[1]),
        stdio[2] === null || stdio[2] === undefined ? "pipe" : String(stdio[2]),
      ];
    }
    return undefined;
  }

  function validateKillSignal(sig, propName = "options.killSignal") {
    if (sig === undefined) return "SIGTERM";
    if (typeof sig === "number") {
      if (sig === 0) return 0;
      const sigMap = osMod.constants.signals;
      for (const [k, v] of Object.entries(sigMap)) {
        if (v === sig) return k;
      }
      throw makeNodeError("ERR_UNKNOWN_SIGNAL", `Unknown signal: ${sig}`, TypeError);
    }
    if (typeof sig === "string") {
      if (Object.prototype.hasOwnProperty.call(osMod.constants.signals, sig)) return sig;
      throw makeNodeError("ERR_UNKNOWN_SIGNAL", `Unknown signal: ${sig}`, TypeError);
    }
    throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "${propName}" property must be one of type string or number. Received ${sig === null ? "null" : typeof sig}`, TypeError);
  }

  function spawnSync(command, args, options) {
    if (args && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = [];
    }
    args = Array.isArray(args) ? args.map(String) : [];
    options = options || {};
    const killSignal = validateKillSignal(options.killSignal);
    const input = options.input !== undefined ? toBytesInput(options.input, options.encoding) : undefined;
    const maxBuffer = options.maxBuffer !== undefined ? Number(options.maxBuffer) : 10 * 1024 * 1024;
    const stdio = normalizeStdioOption(options.stdio);
    const req = {
      command: String(command),
      args,
      cwd: options.cwd ? normPathArg(options.cwd) : "",
      env: normalizeEnvOption(options.env),
      shell: options.shell || false,
      timeoutMs: options.timeout ? Number(options.timeout) : 0,
      maxBuffer: Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 0,
      stdio,
      killSignal,
    };
    const res = hostCall("cp.spawnSync", JSON.stringify(req), input);
    const meta = JSON.parse(res.json);
    const bin = res.bin || new Uint8Array(0);
    const stdoutBytes = bin.subarray(0, meta.stdoutLen || 0);
    const stderrBytes = bin.subarray(meta.stdoutLen || 0);
    const stdoutBuf = new Buffer(stdoutBytes.buffer, stdoutBytes.byteOffset, stdoutBytes.byteLength);
    const stderrBuf = new Buffer(stderrBytes.buffer, stderrBytes.byteOffset, stderrBytes.byteLength);
    const enc = options.encoding && options.encoding !== "buffer" ? options.encoding : null;
    const stdout = meta.stdoutNull ? null : (enc ? stdoutBuf.toString(enc) : stdoutBuf);
    const stderr = meta.stderrNull ? null : (enc ? stderrBuf.toString(enc) : stderrBuf);
    let error;
    if (meta.error) {
      error = new Error(meta.error);
      if (meta.errorCode) error.code = meta.errorCode;
      else if (meta.error === "ETIMEDOUT") error.code = "ETIMEDOUT";
      else if (String(meta.error).startsWith("ENOBUFS")) error.code = "ENOBUFS";
      if (meta.syscall) error.syscall = meta.syscall;
      if (meta.path) error.path = meta.path;
    }
    return {
      pid: meta.pid || 0,
      output: [null, stdout, stderr],
      stdout,
      stderr,
      status: meta.status !== undefined ? meta.status : null,
      signal: meta.signal || null,
      error,
    };
  }

  function execSync(command, options = {}) {
    if (typeof options === "string") options = { encoding: options };
    options = options || {};
    const enc = options.encoding || "buffer";
    const shellOpt = options.shell !== undefined ? options.shell : true;
    const res = spawnSync(command, [], Object.assign({}, options, { encoding: enc, shell: shellOpt }));
    if (res.error) {
      res.error.stdout = res.stdout;
      res.error.stderr = res.stderr;
      res.error.status = res.status;
      res.error.signal = res.signal;
      res.error.output = res.output;
      res.error.pid = res.pid;
      throw res.error;
    }
    if (res.status !== 0) {
      const stderrText = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : String(res.stderr || "");
      const err = new Error(`Command failed: ${command}${stderrText ? "\n" + stderrText : ""}`);
      err.status = res.status;
      err.signal = res.signal;
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      err.output = res.output;
      throw err;
    }
    return res.stdout;
  }

  function execFileSync(file, args, options) {
    if (args && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = [];
    } else if (typeof args === "string") {
      options = { encoding: args };
      args = [];
    }
    if (typeof options === "string") options = { encoding: options };
    options = options || {};
    const enc = options.encoding || "buffer";
    const res = spawnSync(file, args || [], Object.assign({}, options, { encoding: enc }));
    if (res.error) {
      res.error.stdout = res.stdout;
      res.error.stderr = res.stderr;
      res.error.status = res.status;
      res.error.signal = res.signal;
      res.error.output = res.output;
      res.error.pid = res.pid;
      throw res.error;
    }
    if (res.status !== 0) {
      const stderrText = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : String(res.stderr || "");
      const err = new Error(`Command failed: ${file}${stderrText ? "\n" + stderrText : ""}`);
      err.status = res.status;
      err.signal = res.signal;
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      err.output = res.output;
      throw err;
    }
    return res.stdout;
  }

  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this.pid = undefined;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this._id = 0;
      this._refed = true;
      this._closed = false;
      this._killSignal = "SIGTERM";
      this.stdout = new Readable();
      this.stdout._onPull = (n) => {
        if (this._id) {
          try {
            hostCall("cp.pullOutput", JSON.stringify({ id: this._id, out: "stdout", n: n || 1 }));
          } catch (_) {}
        }
      };
      this.stdout._read = () => this.stdout._onPull(4);
      this.stderr = new Readable();
      this.stderr._onPull = (n) => {
        if (this._id) {
          try {
            hostCall("cp.pullOutput", JSON.stringify({ id: this._id, out: "stderr", n: n || 1 }));
          } catch (_) {}
        }
      };
      this.stderr._read = () => this.stderr._onPull(4);
      this.stdin = new Writable({
        write: (chunk, encoding, cb) => {
          try {
            if (this._id) {
              const bytes = toBytesInput(chunk, encoding);
              const sliceMax = 1024 * 1024;
              for (let off = 0; off < bytes.byteLength; off += sliceMax) {
                const part = bytes.subarray(off, Math.min(off + sliceMax, bytes.byteLength));
                const ok = hostCall("cp.writeStdin", String(this._id), part);
                if (ok === "false" && this.stdin) {
                  this.stdin._backpressured = true;
                }
              }
            }
            cb();
          } catch (err) {
            cb(err);
          }
        },
        final: (cb) => {
          if (this._id) {
            hostCall("cp.closeStdin", String(this._id));
          }
          cb();
        },
      });
    }
    kill(signal) {
      if (signal === undefined) signal = this._killSignal || "SIGTERM";
      const isZero = signal === 0 || signal === "0";
      const resolvedSig = isZero ? 0 : validateKillSignal(signal, "signal");
      if (!this._id) return false;
      const ok = hostCall("cp.killChild", JSON.stringify({ id: this._id, signal: resolvedSig })) === "true";
      if (!isZero && ok) {
        this.killed = true;
        this.signalCode = typeof resolvedSig === "string" ? resolvedSig : "SIGTERM";
      }
      return ok;
    }
    ref() {
      if (!this._refed && !this._closed && this.exitCode === null && this.signalCode === null && this._id > 0 && activeChildren.has(this._id)) {
        this._refed = true;
        incRef();
        if (this._id) {
          try { hostCall("cp.setRef", JSON.stringify({ id: this._id, ref: true })); } catch (_) {}
        }
      }
      return this;
    }
    unref() {
      if (this._refed) {
        this._refed = false;
        decRef();
        if (this._id) {
          try { hostCall("cp.setRef", JSON.stringify({ id: this._id, ref: false })); } catch (_) {}
        }
      }
      return this;
    }
  }

  function spawn(command, args, options) {
    if (args && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = [];
    }
    args = Array.isArray(args) ? args.map(String) : [];
    options = options || {};
    const killSignal = validateKillSignal(options.killSignal);
    const cp = new ChildProcess();
    cp._killSignal = killSignal;
    const stdio = normalizeStdioOption(options.stdio);
    if (stdio) {
      if (stdio[0] === "ignore" || stdio[0] === "inherit") cp.stdin = null;
      if (stdio[1] === "ignore" || stdio[1] === "inherit") cp.stdout = null;
      if (stdio[2] === "ignore" || stdio[2] === "inherit") cp.stderr = null;
    }
    const endChildStreams = () => {
      if (cp.stdout) cp.stdout.push(null);
      if (cp.stderr) cp.stderr.push(null);
      if (cp.stdin && !cp.stdin.destroyed) cp.stdin.destroy();
    };
    if (options.signal && options.signal.aborted) {
      cp._closed = true;
      cp._refed = false;
      const abortErr = options.signal.reason || Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR", name: "AbortError" });
      processObj.nextTick(() => {
        endChildStreams();
        cp.emit("error", abortErr);
        cp.emit("close", null, cp._killSignal);
      });
      return cp;
    }
    const id = nextAsyncId++;
    cp._id = id;
    incRef();
    activeChildren.set(id, cp);

    if (options.signal && typeof options.signal.addEventListener === "function") {
      const onAbort = () => {
        const abortErr = options.signal.reason || Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR", name: "AbortError" });
        cp.kill(cp._killSignal);
        cp.emit("error", abortErr);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      cp.once("close", () => {
        if (typeof options.signal.removeEventListener === "function") {
          options.signal.removeEventListener("abort", onAbort);
        }
      });
    }

    const hasInput = options.input !== undefined;
    const input = hasInput ? toBytesInput(options.input, options.encoding) : undefined;
    const maxBuffer = options.maxBuffer !== undefined ? Number(options.maxBuffer) : 0;
    const req = {
      id,
      command: String(command),
      args,
      cwd: options.cwd ? normPathArg(options.cwd) : "",
      env: normalizeEnvOption(options.env),
      shell: options.shell || false,
      detached: Boolean(options.detached),
      timeoutMs: options.timeout ? Number(options.timeout) : 0,
      maxBuffer: Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 0,
      stdio,
      hasInput,
      killSignal,
    };

    try {
      const meta = JSON.parse(hostCall("cp.spawnAsync", JSON.stringify(req), input));
      if (meta.error) {
        activeChildren.delete(id);
        cp._closed = true;
        cp.unref();
        const err = new Error(meta.error);
        if (meta.errorCode) err.code = meta.errorCode;
        if (meta.syscall) err.syscall = meta.syscall;
        if (meta.path) err.path = meta.path;
        const closeCode = err.code === "ENOENT" ? (isWin ? -4058 : -2) : -1;
        processObj.nextTick(() => {
          endChildStreams();
          cp.emit("error", err);
          cp.emit("close", closeCode, null);
        });
      } else {
        cp.pid = meta.pid;
        processObj.nextTick(() => cp.emit("spawn"));
      }
    } catch (err) {
      activeChildren.delete(id);
      cp._closed = true;
      cp.unref();
      const closeCode = err && err.code === "ENOENT" ? (isWin ? -4058 : -2) : -1;
      processObj.nextTick(() => {
        endChildStreams();
        cp.emit("error", err);
        cp.emit("close", closeCode, null);
      });
    }
    return cp;
  }

  function exec(command, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = options || {};
    const enc = options.encoding !== undefined ? options.encoding : "utf8";
    const maxBuffer = options.maxBuffer !== undefined ? Number(options.maxBuffer) : 10 * 1024 * 1024;
    const stdinOpt = Array.isArray(options.stdio) ? options.stdio[0] : (options.stdio || "pipe");
    const shellOpt = options.shell !== undefined ? options.shell : true;
    const cp = spawn(command, [], Object.assign({}, options, { shell: shellOpt, stdio: [stdinOpt, "pipe", "pipe"] }));
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let maxBufExceeded = null;
    let cbDone = false;
    const fireCb = (err, out, errOut) => {
      if (cbDone || typeof callback !== "function") return;
      cbDone = true;
      callback(err, out, errOut);
    };
    if (cp.stdout) {
      cp.stdout.on("data", (c) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        stdoutLen += b.length;
        if (stdoutLen > maxBuffer) {
          if (!maxBufExceeded) {
            maxBufExceeded = Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
            cp.kill();
          }
          return;
        }
        stdoutChunks.push(b);
      });
    }
    if (cp.stderr) {
      cp.stderr.on("data", (c) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        stderrLen += b.length;
        if (stderrLen > maxBuffer) {
          if (!maxBufExceeded) {
            maxBufExceeded = Object.assign(new RangeError("stderr maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
            cp.kill();
          }
          return;
        }
        stderrChunks.push(b);
      });
    }
    cp.on("close", (code, signal) => {
      if (cbDone || typeof callback !== "function") return;
      const outBuf = Buffer.concat(stdoutChunks);
      const errBuf = Buffer.concat(stderrChunks);
      let stdout, stderr;
      try {
        stdout = enc && enc !== "buffer" ? outBuf.toString(enc) : outBuf;
        stderr = enc && enc !== "buffer" ? errBuf.toString(enc) : errBuf;
      } catch (encErr) {
        fireCb(encErr, "", "");
        return;
      }
      if (maxBufExceeded) {
        maxBufExceeded.stdout = stdout;
        maxBufExceeded.stderr = stderr;
        fireCb(maxBufExceeded, stdout, stderr);
      } else if (code !== 0) {
        const err = new Error(`Command failed: ${command}\n${errBuf.toString("utf8")}`);
        err.code = code;
        err.signal = signal;
        err.killed = Boolean(cp.killed || signal);
        err.stdout = stdout;
        err.stderr = stderr;
        fireCb(err, stdout, stderr);
      } else {
        fireCb(null, stdout, stderr);
      }
    });
    cp.on("error", (err) => {
      fireCb(err, "", "");
    });
    return cp;
  }
  exec[kCustomPromisifySymbol] = function (command, options) {
    return new Promise((resolve, reject) => {
      exec(command, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      });
    });
  };

  function execFile(file, args, options, callback) {
    if (typeof args === "function") {
      callback = args;
      args = [];
      options = {};
    } else if (typeof options === "function") {
      callback = options;
      if (args && !Array.isArray(args)) {
        options = args;
        args = [];
      } else {
        options = {};
      }
    } else if (args && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = [];
    }
    options = options || {};
    const enc = options.encoding !== undefined ? options.encoding : "utf8";
    const maxBuffer = options.maxBuffer !== undefined ? Number(options.maxBuffer) : 10 * 1024 * 1024;
    const stdinOpt = Array.isArray(options.stdio) ? options.stdio[0] : (options.stdio || "pipe");
    const cp = spawn(file, args || [], Object.assign({}, options, { stdio: [stdinOpt, "pipe", "pipe"] }));
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let maxBufExceeded = null;
    let cbDone = false;
    const fireCb = (err, out, errOut) => {
      if (cbDone || typeof callback !== "function") return;
      cbDone = true;
      callback(err, out, errOut);
    };
    if (cp.stdout) {
      cp.stdout.on("data", (c) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        stdoutLen += b.length;
        if (stdoutLen > maxBuffer) {
          if (!maxBufExceeded) {
            maxBufExceeded = Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
            cp.kill();
          }
          return;
        }
        stdoutChunks.push(b);
      });
    }
    if (cp.stderr) {
      cp.stderr.on("data", (c) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        stderrLen += b.length;
        if (stderrLen > maxBuffer) {
          if (!maxBufExceeded) {
            maxBufExceeded = Object.assign(new RangeError("stderr maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
            cp.kill();
          }
          return;
        }
        stderrChunks.push(b);
      });
    }
    cp.on("close", (code, signal) => {
      if (cbDone || typeof callback !== "function") return;
      const outBuf = Buffer.concat(stdoutChunks);
      const errBuf = Buffer.concat(stderrChunks);
      let stdout, stderr;
      try {
        stdout = enc && enc !== "buffer" ? outBuf.toString(enc) : outBuf;
        stderr = enc && enc !== "buffer" ? errBuf.toString(enc) : errBuf;
      } catch (encErr) {
        fireCb(encErr, "", "");
        return;
      }
      if (maxBufExceeded) {
        maxBufExceeded.stdout = stdout;
        maxBufExceeded.stderr = stderr;
        fireCb(maxBufExceeded, stdout, stderr);
      } else if (code !== 0) {
        const err = new Error(`Command failed: ${file}\n${errBuf.toString("utf8")}`);
        err.code = code;
        err.signal = signal;
        err.killed = Boolean(cp.killed || signal);
        err.stdout = stdout;
        err.stderr = stderr;
        fireCb(err, stdout, stderr);
      } else {
        fireCb(null, stdout, stderr);
      }
    });
    cp.on("error", (err) => {
      fireCb(err, "", "");
    });
    return cp;
  }
  execFile[kCustomPromisifySymbol] = function (file, args, options) {
    return new Promise((resolve, reject) => {
      execFile(file, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      });
    });
  };

  const activeForks = new Map();

  function fork(modulePath, args = [], options = {}) {
    if (!Array.isArray(args) && typeof args === "object" && args !== null) {
      options = args;
      args = [];
    }
    options = options || {};
    const ipcId = nextAsyncId++;
    const ctlPort = Number(hostCall("worker.listen", String(ipcId)));
    const childEnv = Object.assign({}, options.env || processObj.env, {
      __INDIRECT_FORK_IPC: "1",
      __INDIRECT_WT_CTL_PORT: String(ctlPort),
    });
    const spawnOpts = Object.assign({}, options, { env: childEnv });
    if (options.silent) {
      spawnOpts.stdio = ["pipe", "pipe", "pipe"];
    } else if (!options.stdio) {
      spawnOpts.stdio = ["inherit", "inherit", "inherit"];
    }
    const modStr = modulePath instanceof URL ? fileURLToPath(modulePath) : String(modulePath);
    const cp = spawn(processObj.execPath, ["--js", modStr, ...(Array.isArray(args) ? args.map(String) : [])], spawnOpts);
    cp._ipcId = ipcId;
    cp.connected = true;
    activeForks.set(ipcId, cp);
    cp.send = function (message, sendHandle, opts, callback) {
      if (typeof sendHandle === "function") {
        callback = sendHandle;
      } else if (typeof opts === "function") {
        callback = opts;
      }
      if (!cp.connected) {
        const err = makeNodeError("ERR_IPC_CHANNEL_CLOSED", "Channel closed", Error);
        if (typeof callback === "function") {
          queueMicrotask(() => callback(err));
          return false;
        }
        throw err;
      }
      try {
        hostCall("worker.send", String(ipcId), v8Serialize(message));
        if (typeof callback === "function") queueMicrotask(() => callback(null));
        return true;
      } catch (err) {
        if (typeof callback === "function") {
          queueMicrotask(() => callback(err));
          return false;
        }
        throw err;
      }
    };
    cp.disconnect = function () {
      if (!cp.connected) return;
      cp.connected = false;
      activeForks.delete(ipcId);
      try { hostCall("worker.close", String(ipcId)); } catch (_) {}
      queueMicrotask(() => cp.emit("disconnect"));
    };
    const cleanupFork = () => {
      const wasConnected = cp.connected;
      cp.connected = false;
      try { hostCall("worker.close", JSON.stringify({ id: ipcId, wait: true })); } catch (_) {}
      setImmediate(() => {
        activeForks.delete(ipcId);
        if (wasConnected) cp.emit("disconnect");
      });
    };
    cp.on("exit", cleanupFork);
    cp.on("error", cleanupFork);
    return cp;
  }

  builtins["child_process"] = {
    ChildProcess,
    spawn,
    spawnSync,
    exec,
    execSync,
    execFile,
    execFileSync,
    fork,
  };

  // Agent Shell Helper ($) — Bun.$ / zx hybrid
  const kShellRaw = Symbol("indirect.shell.raw");
  function shellQuote(val) {
    if (val === null || val === undefined) return "''";
    if (typeof val === "object" && val[kShellRaw] === true && typeof val.value === "string") return val.value;
    if (Array.isArray(val)) return val.map(shellQuote).join(" ");
    if (val instanceof Buffer || val instanceof Uint8Array) {
      return shellQuote(Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString("utf8"));
    }
    const s = String(val);
    if (s.length === 0) return "''";
    if (/^[a-zA-Z0-9_./:@+=,-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  function shellInterpolate(val) {
    if (val === null || val === undefined) return "''";
    if (typeof val === "object" && val[kShellRaw] === true && typeof val.value === "string") return val.value;
    if (Array.isArray(val)) return val.map(shellInterpolate).join(" ");
    if (val instanceof Buffer || val instanceof Uint8Array) {
      return shellQuote(Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString("utf8"));
    }
    if (typeof val === "object" && (val.constructor === Object || val.constructor === undefined)) {
      throw new TypeError("Cannot interpolate plain Object into shell command ($)");
    }
    return shellQuote(val);
  }

  class ShellError extends Error {
    constructor(command, stdoutBuf, stderrBuf, exitCode) {
      const stderrStr = stderrBuf.toString("utf8").trim();
      super(`Failed with exit code ${exitCode}: ${command}${stderrStr ? "\n" + stderrStr : ""}`);
      this.name = "ShellError";
      this.command = command;
      this.stdout = stdoutBuf;
      this.stderr = stderrBuf;
      this.exitCode = exitCode;
    }
    text(encoding = "utf8") { return this.stdout.toString(encoding); }
    json() { return JSON.parse(this.stdout.toString("utf8")); }
    lines() { return this.stdout.toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/); }
    bytes() { return new Uint8Array(this.stdout.buffer, this.stdout.byteOffset, this.stdout.byteLength); }
  }

  class ShellOutput {
    constructor(stdoutBuf, stderrBuf, exitCode) {
      this.stdout = stdoutBuf;
      this.stderr = stderrBuf;
      this.exitCode = exitCode;
    }
    text(encoding = "utf8") { return this.stdout.toString(encoding); }
    json() { return JSON.parse(this.stdout.toString("utf8")); }
    lines() {
      const s = this.stdout.toString("utf8").replace(/\r?\n$/, "");
      return s.length === 0 ? [] : s.split(/\r?\n/);
    }
    bytes() { return new Uint8Array(this.stdout.buffer, this.stdout.byteOffset, this.stdout.byteLength); }
    arrayBuffer() { return this.stdout.buffer.slice(this.stdout.byteOffset, this.stdout.byteOffset + this.stdout.byteLength); }
    blob() { return new Blob([this.stdout]); }
    toString() { return this.stdout.toString("utf8"); }
  }

  class ShellPromise {
    constructor(cmdStr, defaults = {}) {
      this._cmd = cmdStr;
      this._cwd = defaults.cwd || "";
      this._env = defaults.env ? Object.assign({}, defaults.env) : null;
      this._stdin = defaults.stdin !== undefined ? defaults.stdin : undefined;
      this._throws = defaults.throws !== undefined ? defaults.throws : true;
      this._quiet = defaults.quiet !== undefined ? Boolean(defaults.quiet) : false;
      this._timeout = defaults.timeout || 0;
      this._result = null;
      this._error = null;
      this._executed = false;
    }
    cwd(dir) { this._cwd = dir === undefined || dir === null || dir === "" ? "" : normPathArg(dir); return this; }
    env(e) { this._env = e ? Object.assign({}, e) : null; return this; }
    stdin(input) { this._stdin = input; return this; }
    nothrow() { this._throws = false; return this; }
    throws(enable = true) { this._throws = Boolean(enable); return this; }
    quiet(enable = true) { this._quiet = Boolean(enable); return this; }
    timeout(ms) { this._timeout = Number(ms) || 0; return this; }

    _execSync() {
      const sigExitCode = (sig) => {
        const map = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGILL: 132, SIGTRAP: 133, SIGABRT: 134, SIGBUS: 135, SIGFPE: 136, SIGKILL: 137, SIGUSR1: 138, SIGSEGV: 139, SIGUSR2: 140, SIGPIPE: 141, SIGALRM: 142, SIGTERM: 143 };
        return map[String(sig).toUpperCase()] || 143;
      };
      if (this._executed) {
        if (this._error) throw this._error;
        return this._result;
      }
      this._executed = true;
      if (this._cp && this._cp._id) {
        this._syncCompleted = true;
        const res = hostCall("cp.waitChild", String(this._cp._id));
        const waited = JSON.parse(typeof res === "string" ? res : res.json);
        const bin = (res && res.bin) || new Uint8Array(0);
        const outBytes = bin.subarray(0, waited.stdoutLen || 0);
        const errBytes = bin.subarray(waited.stdoutLen || 0);
        const outBuf = new Buffer(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength);
        const errBuf = new Buffer(errBytes.buffer, errBytes.byteOffset, errBytes.byteLength);
        if (!this._quiet) {
          if (outBuf.length > 0) processObj.stdout.write(outBuf);
          if (errBuf.length > 0) processObj.stderr.write(errBuf);
        }
        const code = waited.status !== null && waited.status !== undefined ? waited.status : (waited.signal ? sigExitCode(waited.signal) : 1);
        this._result = new ShellOutput(outBuf, errBuf, code);
        if (code !== 0 && this._throws) {
          this._error = new ShellError(this._cmd, outBuf, errBuf, code);
          if (this._asyncReject) {
            const rej = this._asyncReject;
            this._asyncResolve = null;
            this._asyncReject = null;
            rej(this._error);
          }
          throw this._error;
        }
        if (this._asyncResolve) {
          const resFn = this._asyncResolve;
          this._asyncResolve = null;
          this._asyncReject = null;
          resFn(this._result);
        }
        return this._result;
      }
      const mergedEnv = this._env ? Object.assign({}, processObj.env, this._env) : undefined;
      const res = spawnSync(this._cmd, [], {
        cwd: this._cwd || undefined,
        env: mergedEnv,
        input: this._stdin,
        shell: "$",
        timeout: this._timeout,
      });
      const outBuf = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout || "");
      const errBuf = Buffer.isBuffer(res.stderr) ? res.stderr : Buffer.from(res.stderr || "");
      if (!this._quiet) {
        if (outBuf.length > 0) processObj.stdout.write(outBuf);
        if (errBuf.length > 0) processObj.stderr.write(errBuf);
      }
      const code = res.status !== null && res.status !== undefined ? res.status : (res.signal ? sigExitCode(res.signal) : 1);
      this._result = new ShellOutput(outBuf, errBuf, code);
      if (code !== 0 && this._throws) {
        this._error = new ShellError(this._cmd, outBuf, errBuf, code);
        if (res.error && res.error.code) this._error.code = res.error.code;
        throw this._error;
      }
      return this._result;
    }

    _execAsync() {
      if (this._asyncPromise) return this._asyncPromise;
      if (this._executed) {
        if (this._error) return Promise.reject(this._error);
        return Promise.resolve(this._result);
      }
      const mergedEnv = this._env ? Object.assign({}, processObj.env, this._env) : undefined;
      this._asyncPromise = new Promise((resolve, reject) => {
        this._asyncResolve = resolve;
        this._asyncReject = reject;
        const cp = spawn(this._cmd, [], {
          cwd: this._cwd || undefined,
          env: mergedEnv,
          input: this._stdin,
          shell: "$",
          timeout: this._timeout,
          stdio: [this._stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        });
        this._cp = cp;
        const outChunks = [];
        const errChunks = [];
        if (cp.stdout) {
          cp.stdout.on("data", (c) => {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            outChunks.push(b);
            if (!this._quiet && !this._syncCompleted && b.length > 0) processObj.stdout.write(b);
          });
        }
        if (cp.stderr) {
          cp.stderr.on("data", (c) => {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            errChunks.push(b);
            if (!this._quiet && !this._syncCompleted && b.length > 0) processObj.stderr.write(b);
          });
        }
        if (this._stdin !== undefined && cp.stdin) {
          cp.stdin.end();
        }
        cp.on("error", (err) => {
          this._executed = true;
          if (err && typeof err === "object" && err.exitCode === undefined) err.exitCode = 1;
          this._error = err;
          reject(err);
        });
        cp.on("close", (code, sig) => {
          if (this._syncCompleted) {
            if (this._error) reject(this._error);
            else resolve(this._result);
            return;
          }
          this._executed = true;
          const outBuf = Buffer.concat(outChunks);
          const errBuf = Buffer.concat(errChunks);
          const sigMap = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGILL: 132, SIGTRAP: 133, SIGABRT: 134, SIGBUS: 135, SIGFPE: 136, SIGKILL: 137, SIGUSR1: 138, SIGSEGV: 139, SIGUSR2: 140, SIGPIPE: 141, SIGALRM: 142, SIGTERM: 143 };
          const exitCode = code !== null && code !== undefined ? code : (sig ? (sigMap[String(sig).toUpperCase()] || 143) : 1);
          this._result = new ShellOutput(outBuf, errBuf, exitCode);
          if (exitCode !== 0 && this._throws) {
            this._error = new ShellError(this._cmd, outBuf, errBuf, exitCode);
            reject(this._error);
          } else {
            resolve(this._result);
          }
        });
      });
      return this._asyncPromise;
    }

    sync() {
      return this._execSync();
    }

    get stdout() { return this._execSync().stdout; }
    get stderr() { return this._execSync().stderr; }
    get exitCode() { return this._execSync().exitCode; }

    then(onFulfilled, onRejected) {
      return this._execAsync().then(onFulfilled, onRejected);
    }
    catch(onRejected) {
      return this.then(undefined, onRejected);
    }
    finally(onFinally) {
      return this.then(
        (v) => Promise.resolve(onFinally()).then(() => v),
        (e) => Promise.resolve(onFinally()).then(() => { throw e; })
      );
    }

    text(encoding = "utf8") {
      this._quiet = true;
      return this.then((r) => r.text(encoding));
    }
    json() {
      this._quiet = true;
      return this.then((r) => r.json());
    }
    lines() {
      this._quiet = true;
      const p = this.then((r) => r.lines());
      p[Symbol.asyncIterator] = async function* () {
        const arr = await p;
        for (const line of arr) {
          yield line;
        }
      };
      return p;
    }
    bytes() {
      this._quiet = true;
      return this.then((r) => r.bytes());
    }
    arrayBuffer() {
      this._quiet = true;
      return this.then((r) => r.arrayBuffer());
    }
    blob() {
      this._quiet = true;
      return this.then((r) => r.blob());
    }
  }

  function createDollar(defaults = {}) {
    function dollar(strings, ...values) {
      let cmd = "";
      if (Array.isArray(strings) && Array.isArray(strings.raw)) {
        for (let i = 0; i < strings.length; i++) {
          cmd += strings[i];
          if (i < values.length) cmd += shellInterpolate(values[i]);
        }
      } else {
        cmd = String(strings);
      }
      return new ShellPromise(cmd, defaults);
    }
    dollar.sync = function (strings, ...values) {
      return dollar(strings, ...values).sync();
    };
    dollar.raw = (v) => ({ [kShellRaw]: true, value: String(v ?? "") });
    dollar.quote = shellQuote;
    dollar.escape = shellQuote;
    dollar.cwd = (dir) => createDollar(Object.assign({}, defaults, { cwd: dir === undefined || dir === null || dir === "" ? "" : normPathArg(dir) }));
    dollar.env = (env) => createDollar(Object.assign({}, defaults, { env }));
    dollar.nothrow = () => createDollar(Object.assign({}, defaults, { throws: false }));
    dollar.throws = (enable = true) => createDollar(Object.assign({}, defaults, { throws: Boolean(enable) }));
    dollar.quiet = (enable = true) => createDollar(Object.assign({}, defaults, { quiet: Boolean(enable) }));
    dollar.ShellError = ShellError;
    dollar.ShellOutput = ShellOutput;
    dollar.ShellPromise = ShellPromise;
    return dollar;
  }

  const dollarGlobal = createDollar();
  globalThis.$ = dollarGlobal;
  builtins["sh"] = {
    $: dollarGlobal,
    ShellError,
    ShellOutput,
    ShellPromise,
    quote: shellQuote,
    raw: dollarGlobal.raw,
  };

  // =========================================================================
  // 14. Crypto & Zlib
  // =========================================================================

  function encodeDigestOutput(bytes, encoding) {
    const buf = new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return encoding && encoding !== "buffer" ? buf.toString(encoding) : buf;
  }

  function cloneBytesInput(data, encoding) {
    const b = toBytesInput(data, encoding);
    return Uint8Array.prototype.slice.call(b);
  }

  class Hash {
    constructor(algorithm, options) {
      this._alg = String(algorithm);
      this._outputLength = options && typeof options.outputLength === "number" ? options.outputLength : undefined;
      this._chunks = [];
      this._finalized = false;
    }
    update(data, inputEncoding) {
      if (this._finalized) {
        throw makeNodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called", Error);
      }
      this._chunks.push(cloneBytesInput(data, inputEncoding));
      return this;
    }
    digest(encoding) {
      if (this._finalized) {
        throw makeNodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called", Error);
      }
      this._finalized = true;
      const combined = Buffer.concat(this._chunks);
      const arg = this._outputLength !== undefined
        ? JSON.stringify({ alg: this._alg, outputLength: this._outputLength })
        : this._alg;
      const res = hostCall("crypto.hash", arg, combined);
      return encodeDigestOutput(res, encoding);
    }
    copy(options) {
      if (this._finalized) {
        throw makeNodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called", Error);
      }
      const outLen = options && typeof options.outputLength === "number" ? options.outputLength : this._outputLength;
      const h = new Hash(this._alg, outLen !== undefined ? { outputLength: outLen } : undefined);
      h._chunks = this._chunks.slice();
      return h;
    }
  }

  class Hmac {
    constructor(algorithm, key) {
      this._alg = String(algorithm);
      this._key = cloneBytesInput(key);
      this._chunks = [];
      this._finalized = false;
    }
    update(data, inputEncoding) {
      if (this._finalized) {
        throw makeNodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called", Error);
      }
      this._chunks.push(cloneBytesInput(data, inputEncoding));
      return this;
    }
    digest(encoding) {
      if (this._finalized) {
        return encodeDigestOutput(Buffer.alloc(0), encoding);
      }
      this._finalized = true;
      const data = Buffer.concat(this._chunks);
      const payload = Buffer.concat([this._key, data]);
      const res = hostCall("crypto.hmac", JSON.stringify({ alg: this._alg, keyLen: this._key.byteLength }), payload);
      return encodeDigestOutput(res, encoding);
    }
  }

  const VALID_GCM_TAG_LENGTHS = [4, 8, 12, 13, 14, 15, 16];
  const CIPHER_KEY_LENS = {
    "aes-128-cbc": 16,
    "aes-128-ctr": 16,
    "aes-128-gcm": 16,
    "aes-192-cbc": 24,
    "aes-192-ctr": 24,
    "aes-192-gcm": 24,
    "aes-256-cbc": 32,
    "aes-256-ctr": 32,
    "aes-256-gcm": 32,
    "chacha20-poly1305": 32,
  };

  function validateCipherParams(alg, key, iv) {
    const expectedKeyLen = CIPHER_KEY_LENS[alg];
    if (!expectedKeyLen) {
      const err = new TypeError(`Unknown cipher: ${alg}`);
      err.code = "ERR_CRYPTO_UNKNOWN_CIPHER";
      throw err;
    }
    if (key.byteLength !== expectedKeyLen) {
      const err = new RangeError("Invalid key length");
      err.code = "ERR_CRYPTO_INVALID_KEYLEN";
      throw err;
    }
    if (alg === "chacha20-poly1305") {
      if (iv.byteLength !== 12) {
        const err = new RangeError("Invalid initialization vector");
        err.code = "ERR_CRYPTO_INVALID_IV";
        throw err;
      }
    } else if (alg.endsWith("-gcm")) {
      if (iv.byteLength === 0) {
        const err = new RangeError("Invalid initialization vector");
        err.code = "ERR_CRYPTO_INVALID_IV";
        throw err;
      }
    } else if (iv.byteLength !== 16) {
      const err = new RangeError("Invalid initialization vector");
      err.code = "ERR_CRYPTO_INVALID_IV";
      throw err;
    }
  }

  function validateCryptoInt(val, name, min = 0, max = 0x7fffffff) {
    if (typeof val !== "number") {
      const err = new TypeError(`The "${name}" argument must be of type number. Received ${typeof val}`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (!Number.isInteger(val) || val < min || val > max) {
      const err = new RangeError(`The value of "${name}" is out of range. It must be >= ${min} && <= ${max}. Received ${val}`);
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
  }

  function advanceCounterBlock(iv, blocks) {
    let carry = blocks >>> 0;
    for (let i = 15; i >= 0 && carry > 0; i--) {
      const sum = iv[i] + (carry & 0xff);
      iv[i] = sum & 0xff;
      carry = (carry >>> 8) + (sum >>> 8);
    }
  }

  class Cipheriv {
    constructor(algorithm, key, iv, options) {
      this._alg = String(algorithm).toLowerCase();
      this._key = toBytesInput(key);
      this._iv = iv !== null && iv !== undefined ? toBytesInput(iv) : new Uint8Array(0);
      validateCipherParams(this._alg, this._key, this._iv);
      this._aad = new Uint8Array(0);
      this._chunks = [];
      this._emittedBytes = 0;
      this._tag = null;
      this._tagLen = options && options.authTagLength !== undefined ? Number(options.authTagLength) : 16;
      if (this._alg.endsWith("-gcm") && !VALID_GCM_TAG_LENGTHS.includes(this._tagLen)) {
        const err = new TypeError(`Invalid authentication tag length: ${this._tagLen}`);
        err.code = "ERR_CRYPTO_INVALID_AUTH_TAG";
        throw err;
      }
      this._autoPadding = true;
      this._partialBlock = new Uint8Array(0);
      this._cbcIv = Uint8Array.from(this._iv);
      this._ctrIv = new Uint8Array(16);
      if (this._alg.endsWith("-ctr")) {
        this._ctrIv.set(this._iv.subarray(0, 16), 0);
      } else if (this._alg.endsWith("-gcm") && this._iv.byteLength === 12) {
        this._ctrIv.set(this._iv, 0);
        this._ctrIv[15] = 2;
      }
    }
    setAutoPadding(autoPadding = true) {
      this._autoPadding = Boolean(autoPadding);
      return this;
    }
    setAAD(buffer, _options) {
      const b = cloneBytesInput(buffer);
      this._aad = this._aad.byteLength > 0 ? Buffer.concat([this._aad, b]) : b;
      return this;
    }
    update(data, inputEncoding, outputEncoding) {
      const chunk = cloneBytesInput(data, inputEncoding);
      if (chunk.byteLength === 0) {
        return outputEncoding ? "" : Buffer.alloc(0);
      }
      if (this._alg.endsWith("-gcm") && this._iv.byteLength !== 12) {
        this._chunks.push(chunk);
        return outputEncoding ? "" : Buffer.alloc(0);
      }
      if (this._alg.endsWith("-gcm") || this._alg.endsWith("-ctr")) {
        if (this._alg.endsWith("-gcm")) {
          this._chunks.push(chunk);
        }
        const prevRem = this._partialBlock.byteLength;
        const work = prevRem > 0 ? Buffer.concat([this._partialBlock, chunk]) : chunk;
        const ctrAlg = this._alg.endsWith("-gcm") ? this._alg.replace("-gcm", "-ctr") : this._alg;
        const payload = Buffer.concat([this._key, this._ctrIv, work]);
        const res = hostCall(
          "crypto.cipher",
          JSON.stringify({
            alg: ctrAlg,
            decrypt: false,
            keyLen: this._key.byteLength,
            ivLen: 16,
            aadLen: 0,
            tagLen: 0,
            autoPad: false,
          }),
          payload
        );
        const fullBlocks = Math.floor(work.byteLength / 16);
        if (fullBlocks > 0) {
          advanceCounterBlock(this._ctrIv, fullBlocks);
        }
        this._partialBlock = Uint8Array.from(work.subarray(fullBlocks * 16));
        const delta = res.subarray(prevRem);
        this._emittedBytes += delta.byteLength;
        return encodeDigestOutput(delta, outputEncoding);
      }
      if (this._alg.endsWith("-cbc")) {
        const work = this._partialBlock.byteLength > 0 ? Buffer.concat([this._partialBlock, chunk]) : chunk;
        const fullBlocksLen = Math.floor(work.byteLength / 16) * 16;
        if (fullBlocksLen === 0) {
          this._partialBlock = Uint8Array.from(work);
          return outputEncoding ? "" : Buffer.alloc(0);
        }
        const blockPrefix = work.subarray(0, fullBlocksLen);
        const payload = Buffer.concat([this._key, this._cbcIv, blockPrefix]);
        const res = hostCall(
          "crypto.cipher",
          JSON.stringify({
            alg: this._alg,
            decrypt: false,
            keyLen: this._key.byteLength,
            ivLen: 16,
            aadLen: 0,
            tagLen: 0,
            autoPad: false,
          }),
          payload
        );
        this._cbcIv = Uint8Array.from(res.subarray(fullBlocksLen - 16, fullBlocksLen));
        this._partialBlock = Uint8Array.from(work.subarray(fullBlocksLen));
        this._emittedBytes += fullBlocksLen;
        return encodeDigestOutput(res, outputEncoding);
      }
      this._chunks.push(chunk);
      return outputEncoding ? "" : Buffer.alloc(0);
    }
    final(outputEncoding) {
      if (this._alg.endsWith("-ctr")) {
        this._partialBlock = new Uint8Array(0);
        return encodeDigestOutput(Buffer.alloc(0), outputEncoding);
      }
      if (this._alg.endsWith("-cbc")) {
        if (!this._autoPadding && this._partialBlock.byteLength === 0) {
          return encodeDigestOutput(Buffer.alloc(0), outputEncoding);
        }
        const payload = Buffer.concat([this._key, this._cbcIv, this._partialBlock]);
        const res = hostCall(
          "crypto.cipher",
          JSON.stringify({
            alg: this._alg,
            decrypt: false,
            keyLen: this._key.byteLength,
            ivLen: 16,
            aadLen: 0,
            tagLen: 0,
            autoPad: this._autoPadding,
          }),
          payload
        );
        this._partialBlock = new Uint8Array(0);
        this._emittedBytes += res.byteLength;
        return encodeDigestOutput(res, outputEncoding);
      }
      const data = Buffer.concat(this._chunks);
      const payload = Buffer.concat([this._key, this._iv, this._aad, data]);
      const res = hostCall(
        "crypto.cipher",
        JSON.stringify({
          alg: this._alg,
          decrypt: false,
          keyLen: this._key.byteLength,
          ivLen: this._iv.byteLength,
          aadLen: this._aad.byteLength,
          tagLen: 0,
          authTagLen: this._tagLen,
          autoPad: this._autoPadding,
        }),
        payload
      );
      if (this._alg.endsWith("-gcm") || this._alg === "chacha20-poly1305") {
        const rawTagLen = this._alg === "chacha20-poly1305" ? 16 : this._tagLen;
        const tagStart = res.byteLength - rawTagLen;
        this._tag = new Buffer(res.buffer, res.byteOffset + tagStart, Math.min(this._tagLen, rawTagLen));
        const body = res.subarray(this._emittedBytes, tagStart);
        this._emittedBytes = tagStart;
        return encodeDigestOutput(body, outputEncoding);
      }
      const rem = res.subarray(this._emittedBytes);
      this._emittedBytes = res.byteLength;
      return encodeDigestOutput(rem, outputEncoding);
    }
    getAuthTag() {
      if (!this._tag) throw new Error("getAuthTag called before final()");
      return this._tag;
    }
  }

  class Decipheriv {
    constructor(algorithm, key, iv, options) {
      this._alg = String(algorithm).toLowerCase();
      this._key = toBytesInput(key);
      this._iv = iv !== null && iv !== undefined ? toBytesInput(iv) : new Uint8Array(0);
      validateCipherParams(this._alg, this._key, this._iv);
      this._aad = new Uint8Array(0);
      this._tag = new Uint8Array(0);
      this._tagLen = options && options.authTagLength !== undefined ? Number(options.authTagLength) : 0;
      if (this._alg.endsWith("-gcm") && this._tagLen && !VALID_GCM_TAG_LENGTHS.includes(this._tagLen)) {
        const err = new TypeError(`Invalid authentication tag length: ${this._tagLen}`);
        err.code = "ERR_CRYPTO_INVALID_AUTH_TAG";
        throw err;
      }
      this._chunks = [];
      this._emittedBytes = 0;
      this._autoPadding = true;
      this._partialBlock = new Uint8Array(0);
      this._cbcIv = Uint8Array.from(this._iv);
      this._ctrIv = new Uint8Array(16);
      if (this._alg.endsWith("-ctr")) {
        this._ctrIv.set(this._iv.subarray(0, 16), 0);
      } else if (this._alg.endsWith("-gcm") && this._iv.byteLength === 12) {
        this._ctrIv.set(this._iv, 0);
        this._ctrIv[15] = 2;
      }
    }
    setAutoPadding(autoPadding = true) {
      this._autoPadding = Boolean(autoPadding);
      return this;
    }
    setAAD(buffer) {
      const b = cloneBytesInput(buffer);
      this._aad = this._aad.byteLength > 0 ? Buffer.concat([this._aad, b]) : b;
      return this;
    }
    setAuthTag(buffer) {
      const b = cloneBytesInput(buffer);
      if (this._alg === "chacha20-poly1305") {
        if (b.byteLength !== 16) {
          const err = new TypeError(`Invalid authentication tag length: ${b.byteLength}`);
          err.code = "ERR_CRYPTO_INVALID_AUTH_TAG";
          throw err;
        }
      } else if (this._alg.endsWith("-gcm")) {
        if (!VALID_GCM_TAG_LENGTHS.includes(b.byteLength) || (this._tagLen && b.byteLength !== this._tagLen)) {
          const err = new TypeError(`Invalid authentication tag length: ${b.byteLength}`);
          err.code = "ERR_CRYPTO_INVALID_AUTH_TAG";
          throw err;
        }
      }
      this._tag = b;
      return this;
    }
    update(data, inputEncoding, outputEncoding) {
      const chunk = cloneBytesInput(data, inputEncoding);
      if (chunk.byteLength === 0) {
        return outputEncoding ? "" : Buffer.alloc(0);
      }
      if (this._alg.endsWith("-ctr") || (this._alg.endsWith("-gcm") && this._iv.byteLength === 12)) {
        if (this._alg.endsWith("-gcm")) {
          this._chunks.push(chunk);
        }
        const prevRem = this._partialBlock.byteLength;
        const work = prevRem > 0 ? Buffer.concat([this._partialBlock, chunk]) : chunk;
        const ctrAlg = this._alg.endsWith("-gcm") ? this._alg.replace("-gcm", "-ctr") : this._alg;
        const payload = Buffer.concat([this._key, this._ctrIv, work]);
        const res = hostCall(
          "crypto.cipher",
          JSON.stringify({
            alg: ctrAlg,
            decrypt: true,
            keyLen: this._key.byteLength,
            ivLen: 16,
            aadLen: 0,
            tagLen: 0,
            autoPad: false,
          }),
          payload
        );
        const fullBlocks = Math.floor(work.byteLength / 16);
        if (fullBlocks > 0) {
          advanceCounterBlock(this._ctrIv, fullBlocks);
        }
        this._partialBlock = Uint8Array.from(work.subarray(fullBlocks * 16));
        const delta = res.subarray(prevRem);
        this._emittedBytes += delta.byteLength;
        return encodeDigestOutput(delta, outputEncoding);
      }
      if (this._alg.endsWith("-cbc")) {
        const work = this._partialBlock.byteLength > 0 ? Buffer.concat([this._partialBlock, chunk]) : chunk;
        const emitLen = this._autoPadding
          ? Math.max(0, Math.floor((work.byteLength - 1) / 16) * 16)
          : Math.floor(work.byteLength / 16) * 16;
        if (emitLen === 0) {
          this._partialBlock = Uint8Array.from(work);
          return outputEncoding ? "" : Buffer.alloc(0);
        }
        const blockPrefix = work.subarray(0, emitLen);
        const nextIv = Uint8Array.from(blockPrefix.subarray(emitLen - 16, emitLen));
        const payload = Buffer.concat([this._key, this._cbcIv, blockPrefix]);
        const res = hostCall(
          "crypto.cipher",
          JSON.stringify({
            alg: this._alg,
            decrypt: true,
            keyLen: this._key.byteLength,
            ivLen: 16,
            aadLen: 0,
            tagLen: 0,
            autoPad: false,
          }),
          payload
        );
        this._cbcIv = nextIv;
        this._partialBlock = Uint8Array.from(work.subarray(emitLen));
        this._emittedBytes += emitLen;
        return encodeDigestOutput(res, outputEncoding);
      }
      this._chunks.push(chunk);
      return outputEncoding ? "" : Buffer.alloc(0);
    }
    final(outputEncoding) {
      if (this._alg.endsWith("-ctr")) {
        this._partialBlock = new Uint8Array(0);
        return encodeDigestOutput(Buffer.alloc(0), outputEncoding);
      }
      if (this._alg.endsWith("-cbc")) {
        if (!this._autoPadding && this._partialBlock.byteLength === 0) {
          return encodeDigestOutput(Buffer.alloc(0), outputEncoding);
        }
        const payload = Buffer.concat([this._key, this._cbcIv, this._partialBlock]);
        const res = hostCall(
          "crypto.cipher",
          JSON.stringify({
            alg: this._alg,
            decrypt: true,
            keyLen: this._key.byteLength,
            ivLen: 16,
            aadLen: 0,
            tagLen: 0,
            autoPad: this._autoPadding,
          }),
          payload
        );
        this._partialBlock = new Uint8Array(0);
        this._emittedBytes += res.byteLength;
        return encodeDigestOutput(res, outputEncoding);
      }
      const data = Buffer.concat(this._chunks);
      const payload = Buffer.concat([this._key, this._iv, this._aad, this._tag, data]);
      const res = hostCall(
        "crypto.cipher",
        JSON.stringify({
          alg: this._alg,
          decrypt: true,
          keyLen: this._key.byteLength,
          ivLen: this._iv.byteLength,
          aadLen: this._aad.byteLength,
          tagLen: this._tag.byteLength,
          authTagLen: this._tagLen || this._tag.byteLength,
          autoPad: this._autoPadding,
        }),
        payload
      );
      const rem = res.subarray(this._emittedBytes);
      this._emittedBytes = res.byteLength;
      return encodeDigestOutput(rem, outputEncoding);
    }
  }

  function randomBytes(size, cb) {
    const n = Number(size);
    if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) {
      throw new RangeError("The value of 'size' is out of range");
    }
    const raw = hostCall("crypto.randomBytes", String(n));
    const buf = new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
    if (typeof cb === "function") {
      queueMicrotask(() => cb(null, buf));
      return;
    }
    return buf;
  }

  function randomFillSync(buffer, offset = 0, size) {
    if (!ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
      throw new TypeError("The 'buffer' argument must be an instance of ArrayBuffer or ArrayBufferView");
    }
    const byteLen = buffer.byteLength;
    const off = Number(offset) || 0;
    const sz = size === undefined ? byteLen - off : Number(size);
    if (off < 0 || sz < 0 || off + sz > byteLen) {
      throw new RangeError("offset or size is out of bounds");
    }
    const rnd = hostCall("crypto.randomBytes", String(sz));
    const view = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, off, sz)
      : new Uint8Array(buffer.buffer, buffer.byteOffset + off, sz);
    view.set(rnd);
    return buffer;
  }

  function randomFill(buffer, offset, size, cb) {
    if (typeof offset === "function") {
      cb = offset;
      offset = 0;
      size = buffer.byteLength;
    } else if (typeof size === "function") {
      cb = size;
      size = buffer.byteLength - Number(offset || 0);
    }
    if (typeof cb !== "function") {
      throw new TypeError("The 'callback' argument must be of type function");
    }
    queueMicrotask(() => {
      try {
        cb(null, randomFillSync(buffer, offset, size));
      } catch (e) {
        cb(e);
      }
    });
  }

  function randomInt(min, max, cb) {
    if (typeof max === "function" || max === undefined) {
      cb = max;
      max = min;
      min = 0;
    }
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new TypeError("min and max must be safe integers");
    }
    const range = max - min;
    if (range <= 0 || range > 281474976710655) {
      throw new RangeError("max - min must be in (0, 2^48 - 1]");
    }
    // Unbiased rejection sampling over 48-bit integers
    const maxUnbiased = 281474976710656 - (281474976710656 % range);
    let rnd48;
    do {
      const raw = hostCall("crypto.randomBytes", "6");
      rnd48 =
        raw[0] * 1099511627776 +
        raw[1] * 4294967296 +
        raw[2] * 16777216 +
        raw[3] * 65536 +
        raw[4] * 256 +
        raw[5];
    } while (rnd48 >= maxUnbiased);
    const val = min + (rnd48 % range);
    if (typeof cb === "function") {
      queueMicrotask(() => cb(null, val));
      return;
    }
    return val;
  }

  function randomUUID() {
    return hostCall("crypto.randomUUID", "");
  }

  function getRandomValues(typedArray) {
    if (
      !ArrayBuffer.isView(typedArray) ||
      typedArray instanceof DataView ||
      typedArray instanceof Float32Array ||
      typedArray instanceof Float64Array ||
      (typeof Float16Array !== "undefined" && typedArray instanceof Float16Array)
    ) {
      const err = new TypeError("The provided value is not of an integer TypedArray type");
      err.name = "TypeMismatchError";
      throw err;
    }
    if (typedArray.byteLength > 65536) {
      const err = new Error("The ArrayBufferView's byte length exceeds the number of bytes of entropy available via this API (65536)");
      err.name = "QuotaExceededError";
      err.code = 22;
      throw err;
    }
    const rnd = hostCall("crypto.randomBytes", String(typedArray.byteLength));
    new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(rnd);
    return typedArray;
  }

  function pbkdf2Sync(password, salt, iterations, keylen, digest = "sha1") {
    const p = toBytesInput(password);
    const s = toBytesInput(salt);
    validateCryptoInt(iterations, "iterations", 1);
    validateCryptoInt(keylen, "keylen", 0);
    const payload = Buffer.concat([p, s]);
    const raw = hostCall(
      "crypto.pbkdf2",
      JSON.stringify({ digest: String(digest || "sha1"), passLen: p.byteLength, iterations: Number(iterations), keyLen: Number(keylen) }),
      payload
    );
    return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if (typeof digest === "function") {
      callback = digest;
      digest = "sha1";
    }
    if (typeof callback !== "function") {
      throw new TypeError("The 'callback' argument must be of type function");
    }
    const p = toBytesInput(password);
    const s = toBytesInput(salt);
    validateCryptoInt(iterations, "iterations", 1);
    validateCryptoInt(keylen, "keylen", 0);
    queueMicrotask(() => {
      try {
        callback(null, pbkdf2Sync(p, s, iterations, keylen, digest));
      } catch (err) {
        callback(err);
      }
    });
  }

  function hkdfSync(digest, ikm, salt, info, keylen) {
    const bIkm = toBytesInput(ikm);
    const bSalt = salt === undefined || salt === null || salt === "" ? new Uint8Array(0) : toBytesInput(salt);
    const bInfo = info === undefined || info === null || info === "" ? new Uint8Array(0) : toBytesInput(info);
    validateCryptoInt(keylen, "keylen", 0);
    const payload = Buffer.concat([bIkm, bSalt, bInfo]);
    const raw = hostCall(
      "crypto.hkdf",
      JSON.stringify({ digest: String(digest), ikmLen: bIkm.byteLength, saltLen: bSalt.byteLength, keyLen: Number(keylen) }),
      payload
    );
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  }

  function hkdf(digest, ikm, salt, info, keylen, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("The 'callback' argument must be of type function");
    }
    validateCryptoInt(keylen, "keylen", 0);
    queueMicrotask(() => {
      try {
        callback(null, hkdfSync(digest, ikm, salt, info, keylen));
      } catch (err) {
        callback(err);
      }
    });
  }

  function scryptSync(password, salt, keylen, options = {}) {
    const p = toBytesInput(password);
    const s = toBytesInput(salt);
    validateCryptoInt(keylen, "keylen", 0);
    const opts = options || {};
    const N = opts.N !== undefined ? opts.N : opts.cost !== undefined ? opts.cost : 16384;
    const r = opts.r !== undefined ? opts.r : opts.blockSize !== undefined ? opts.blockSize : 8;
    const parallel = opts.p !== undefined ? opts.p : opts.parallelization !== undefined ? opts.parallelization : 1;
    const maxmem = opts.maxmem !== undefined ? opts.maxmem : 32 * 1024 * 1024;
    validateCryptoInt(N, "N", 2);
    validateCryptoInt(r, "r", 1);
    validateCryptoInt(parallel, "p", 1);
    const payload = Buffer.concat([p, s]);
    const raw = hostCall(
      "crypto.scrypt",
      JSON.stringify({
        passLen: p.byteLength,
        keyLen: Number(keylen),
        N: Number(N),
        r: Number(r),
        p: Number(parallel),
        maxmem: Number(maxmem),
      }),
      payload
    );
    return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  function scrypt(password, salt, keylen, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (typeof callback !== "function") {
      throw new TypeError("The 'callback' argument must be of type function");
    }
    queueMicrotask(() => {
      try {
        callback(null, scryptSync(password, salt, keylen, options));
      } catch (err) {
        callback(err);
      }
    });
  }

  function toTimingSafeBytes(v, name) {
    if (v instanceof Uint8Array) return v;
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer)) {
      return new Uint8Array(v);
    }
    throw makeNodeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ${v === null ? "null" : typeof v}`,
      TypeError
    );
  }

  function timingSafeEqual(a, b) {
    const ua = toTimingSafeBytes(a, "buf1");
    const ub = toTimingSafeBytes(b, "buf2");
    if (ua.byteLength !== ub.byteLength) {
      throw makeNodeError("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length", RangeError);
    }
    let diff = 0;
    for (let i = 0; i < ua.byteLength; i++) diff |= ua[i] ^ ub[i];
    return diff === 0;
  }

  class CryptoKey {
    constructor(type, extractable, algorithm, usages, rawBytes, meta = null) {
      this.type = type;
      this.extractable = Boolean(extractable);
      this.algorithm = algorithm;
      this.usages = Array.from(usages || []);
      this._raw = rawBytes;
      this._meta = meta;
    }
  }

  function makeDOMError(name, message) {
    const err = new Error(`${name}: ${message}`);
    err.name = name;
    return err;
  }

  function normalizeSubtleHashName(h) {
    const name = (typeof h === "string" ? h : h && h.name ? h.name : "SHA-256").toUpperCase();
    return name.replace("-", "").toLowerCase();
  }

  function normalizeSubtleHashStandard(h) {
    const raw = (typeof h === "string" ? h : h && h.name ? h.name : "SHA-256").toUpperCase().replace("-", "");
    switch (raw) {
      case "SHA1": return "SHA-1";
      case "SHA256": return "SHA-256";
      case "SHA384": return "SHA-384";
      case "SHA512": return "SHA-512";
      default: throw makeDOMError("NotSupportedError", `Unsupported digest algorithm: ${h}`);
    }
  }

  function toArrayBufferSlice(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  function isAsymmetricAlg(name) {
    return (
      name === "ECDSA" ||
      name === "ECDH" ||
      name === "ED25519" ||
      name === "NODE-ED25519" ||
      name === "X25519" ||
      name === "RSASSA-PKCS1-V1_5" ||
      name === "RSA-PSS" ||
      name === "RSA-OAEP"
    );
  }

  function canonicalAlgName(name) {
    const upper = String(name || "").toUpperCase();
    switch (upper) {
      case "HMAC": return "HMAC";
      case "AES-GCM": return "AES-GCM";
      case "AES-CBC": return "AES-CBC";
      case "AES-CTR": return "AES-CTR";
      case "PBKDF2": return "PBKDF2";
      case "HKDF": return "HKDF";
      case "ECDSA": return "ECDSA";
      case "ECDH": return "ECDH";
      case "ED25519":
      case "NODE-ED25519": return "Ed25519";
      case "X25519": return "X25519";
      case "RSASSA-PKCS1-V1_5": return "RSASSA-PKCS1-v1_5";
      case "RSA-PSS": return "RSA-PSS";
      case "RSA-OAEP": return "RSA-OAEP";
      default:
        throw makeDOMError("NotSupportedError", `Unrecognized algorithm name: ${name}`);
    }
  }

  const subtleCrypto = {
    async digest(algorithm, data) {
      const algName = typeof algorithm === "string" ? algorithm : algorithm && algorithm.name;
      normalizeSubtleHashStandard(algName);
      const bytes = toBytesInput(data);
      const raw = hostCall("crypto.hash", algName, bytes);
      return toArrayBufferSlice(raw);
    },
    async importKey(format, keyData, algorithm, extractable, keyUsages) {
      const algInput = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algInput.name);
      const upper = canonName.toUpperCase();
      const fmt = String(format || "").toLowerCase();

      if (isAsymmetricAlg(upper)) {
        const namedCurve = algInput.namedCurve ? String(algInput.namedCurve).toUpperCase() : "";
        const hashStd = algInput.hash ? normalizeSubtleHashStandard(algInput.hash) : undefined;
        let payload = new Uint8Array(0);
        let jwkObj = undefined;
        if (fmt === "jwk") {
          if (!keyData || typeof keyData !== "object") throw makeDOMError("DataError", "Invalid JWK object");
          jwkObj = keyData;
        } else {
          payload = toBytesInput(keyData);
        }
        const meta = JSON.parse(
          hostCall(
            "crypto.webcrypto",
            JSON.stringify({
              op: "importKey",
              alg: canonName,
              namedCurve,
              hash: hashStd || "",
              format: fmt,
              jwk: jwkObj,
            }),
            payload
          )
        );
        const keyAlg = { name: canonName };
        if (namedCurve || (meta.jwkPub && meta.jwkPub.crv && upper.startsWith("EC"))) {
          keyAlg.namedCurve = namedCurve || meta.jwkPub.crv;
        }
        if (hashStd) keyAlg.hash = { name: hashStd };
        if (meta.modulusLength) keyAlg.modulusLength = meta.modulusLength;
        const keyType = meta.type === "private" ? "private" : "public";
        const rawBytes = keyType === "private"
          ? new Uint8Array(Buffer.from(meta.pkcs8, "base64"))
          : new Uint8Array(Buffer.from(meta.spki, "base64"));
        return new CryptoKey(keyType, extractable, keyAlg, keyUsages, rawBytes, meta);
      }

      if (fmt === "jwk") {
        if (!keyData || typeof keyData !== "object" || typeof keyData.k !== "string") {
          throw makeDOMError("DataError", "Invalid symmetric JWK");
        }
        const raw = new Uint8Array(Buffer.from(keyData.k, "base64url"));
        const keyAlg = { name: canonName };
        if (upper === "HMAC") {
          keyAlg.hash = { name: normalizeSubtleHashStandard(algInput.hash || "SHA-256") };
          keyAlg.length = raw.byteLength * 8;
        } else if (upper.startsWith("AES-")) {
          keyAlg.length = raw.byteLength * 8;
        }
        return new CryptoKey("secret", extractable, keyAlg, keyUsages, raw);
      }

      if (fmt !== "raw") throw makeDOMError("NotSupportedError", `Unsupported key format: ${format}`);
      const raw = new Uint8Array(toBytesInput(keyData));
      const keyAlg = { name: canonName };
      if (upper === "HMAC") {
        keyAlg.hash = { name: normalizeSubtleHashStandard(algInput.hash || "SHA-256") };
        keyAlg.length = raw.byteLength * 8;
      } else if (upper.startsWith("AES-")) {
        const bits = raw.byteLength * 8;
        if (bits !== 128 && bits !== 192 && bits !== 256) {
          throw makeDOMError("DataError", `Invalid AES key length: ${bits} bits`);
        }
        keyAlg.length = bits;
      }
      return new CryptoKey("secret", extractable, keyAlg, keyUsages, raw);
    },
    async exportKey(format, key) {
      if (!key || !(key instanceof CryptoKey)) throw new TypeError("Invalid CryptoKey");
      if (!key.extractable) throw makeDOMError("InvalidAccessError", "Key is not extractable");
      const fmt = String(format || "").toLowerCase();
      if (key._meta) {
        if (fmt === "pkcs8") {
          if (key.type !== "private" || !key._meta.pkcs8) throw makeDOMError("InvalidAccessError", "Cannot export public key as pkcs8");
          const b = Buffer.from(key._meta.pkcs8, "base64");
          return toArrayBufferSlice(b);
        }
        if (fmt === "spki") {
          if (key.type !== "public" || !key._meta.spki) throw makeDOMError("InvalidAccessError", "Cannot export private key as spki");
          const b = Buffer.from(key._meta.spki, "base64");
          return toArrayBufferSlice(b);
        }
        if (fmt === "raw") {
          if (key.type !== "public" || !key._meta.rawPub) throw makeDOMError("NotSupportedError", "Raw export not supported for this key");
          const b = Buffer.from(key._meta.rawPub, "base64");
          return toArrayBufferSlice(b);
        }
        if (fmt === "jwk") {
          const jwk = key.type === "private" ? key._meta.jwkPriv : key._meta.jwkPub;
          return Object.assign({}, jwk, { ext: Boolean(key.extractable), key_ops: Array.from(key.usages) });
        }
        throw makeDOMError("NotSupportedError", `Unsupported key format: ${format}`);
      }
      if (fmt === "jwk") {
        return {
          kty: "oct",
          k: Buffer.from(key._raw).toString("base64url"),
          ext: Boolean(key.extractable),
          key_ops: Array.from(key.usages),
        };
      }
      if (fmt !== "raw") throw makeDOMError("NotSupportedError", `Unsupported key format: ${format}`);
      return toArrayBufferSlice(key._raw);
    },
    async generateKey(algorithm, extractable, keyUsages) {
      const algInput = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algInput.name);
      const upper = canonName.toUpperCase();

      if (isAsymmetricAlg(upper)) {
        const namedCurve = algInput.namedCurve ? String(algInput.namedCurve).toUpperCase() : "P-256";
        const hashStd = algInput.hash ? normalizeSubtleHashStandard(algInput.hash) : "SHA-256";
        const modulusLength = algInput.modulusLength ? Number(algInput.modulusLength) : 2048;
        const meta = JSON.parse(
          hostCall(
            "crypto.webcrypto",
            JSON.stringify({
              op: "generateKey",
              alg: canonName,
              namedCurve,
              hash: hashStd,
              modulusLength,
            })
          )
        );
        const keyAlg = { name: canonName };
        if (upper.startsWith("EC")) keyAlg.namedCurve = namedCurve;
        if (upper.startsWith("RSA")) {
          keyAlg.modulusLength = meta.modulusLength || modulusLength;
          keyAlg.publicExponent = new Uint8Array([1, 0, 1]);
          keyAlg.hash = { name: hashStd };
        }
        const usages = Array.from(keyUsages || []);
        const pubUsages = usages.filter((u) => u === "verify" || u === "encrypt" || u === "wrapKey");
        const privUsages = usages.filter((u) => u === "sign" || u === "decrypt" || u === "unwrapKey" || u === "deriveKey" || u === "deriveBits");
        const pubRaw = new Uint8Array(Buffer.from(meta.spki, "base64"));
        const privRaw = new Uint8Array(Buffer.from(meta.pkcs8, "base64"));
        return {
          publicKey: new CryptoKey("public", true, keyAlg, pubUsages, pubRaw, meta),
          privateKey: new CryptoKey("private", extractable, keyAlg, privUsages, privRaw, meta),
        };
      }

      if (upper === "PBKDF2" || upper === "HKDF") {
        throw makeDOMError("NotSupportedError", `Cannot generateKey for ${canonName}`);
      }

      let byteLen = 32;
      if (algInput.length !== undefined) {
        const bits = Number(algInput.length);
        if (upper.startsWith("AES-") && bits !== 128 && bits !== 192 && bits !== 256) {
          throw makeDOMError("OperationError", `Invalid AES key length: ${bits}`);
        }
        if (!Number.isFinite(bits) || bits <= 0) {
          throw makeDOMError("OperationError", `Invalid key length: ${algInput.length}`);
        }
        byteLen = Math.ceil(bits / 8);
      } else if (upper === "HMAC") {
        const h = normalizeSubtleHashName(algInput.hash || "SHA-256");
        byteLen = h === "sha512" || h === "sha384" ? 64 : 32;
      }
      const raw = new Uint8Array(randomBytes(byteLen));
      const keyAlg = { name: canonName, length: byteLen * 8 };
      if (upper === "HMAC") {
        keyAlg.hash = { name: normalizeSubtleHashStandard(algInput.hash || "SHA-256") };
      }
      return new CryptoKey("secret", extractable, keyAlg, keyUsages, raw);
    },
    async sign(algorithm, key, data) {
      const algObj = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algObj.name || (key && key.algorithm && key.algorithm.name));
      const upper = canonName.toUpperCase();
      const bytes = toBytesInput(data);

      if (upper === "HMAC") {
        const hashAlg = normalizeSubtleHashName((key && key.algorithm && key.algorithm.hash) || algObj.hash || "SHA-256");
        const mac = new Hmac(hashAlg, key._raw).update(bytes).digest();
        return toArrayBufferSlice(mac);
      }

      if (upper === "ECDSA" || upper === "ED25519" || upper === "RSASSA-PKCS1-V1_5" || upper === "RSA-PSS") {
        if (!key || key.type !== "private") throw makeDOMError("InvalidAccessError", "Signing requires a private CryptoKey");
        const hashStd = upper === "ED25519"
          ? ""
          : normalizeSubtleHashStandard(algObj.hash || (key.algorithm && key.algorithm.hash) || "SHA-256");
        const payload = Buffer.concat([key._raw, bytes]);
        const sig = hostCall(
          "crypto.webcrypto",
          JSON.stringify({
            op: "sign",
            alg: canonName,
            hash: hashStd,
            keyLen: key._raw.byteLength,
            saltLength: algObj.saltLength ? Number(algObj.saltLength) : 0,
          }),
          payload
        );
        return toArrayBufferSlice(sig);
      }

      throw makeDOMError("NotSupportedError", `Unsupported sign algorithm: ${canonName}`);
    },
    async verify(algorithm, key, signature, data) {
      const algObj = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algObj.name || (key && key.algorithm && key.algorithm.name));
      const upper = canonName.toUpperCase();
      const sigBytes = toBytesInput(signature);
      const dataBytes = toBytesInput(data);

      if (upper === "HMAC") {
        const actual = new Uint8Array(await this.sign(algorithm, key, dataBytes));
        if (actual.byteLength !== sigBytes.byteLength) return false;
        return timingSafeEqual(actual, sigBytes);
      }

      if (upper === "ECDSA" || upper === "ED25519" || upper === "RSASSA-PKCS1-V1_5" || upper === "RSA-PSS") {
        const spki = key && key._meta && key._meta.spki
          ? new Uint8Array(Buffer.from(key._meta.spki, "base64"))
          : (key ? key._raw : new Uint8Array(0));
        const hashStd = upper === "ED25519"
          ? ""
          : normalizeSubtleHashStandard(algObj.hash || (key && key.algorithm && key.algorithm.hash) || "SHA-256");
        const payload = Buffer.concat([spki, sigBytes, dataBytes]);
        const ok = hostCall(
          "crypto.webcrypto",
          JSON.stringify({
            op: "verify",
            alg: canonName,
            hash: hashStd,
            keyLen: spki.byteLength,
            sigLen: sigBytes.byteLength,
            saltLength: algObj.saltLength ? Number(algObj.saltLength) : 0,
          }),
          payload
        );
        return ok === "true";
      }

      throw makeDOMError("NotSupportedError", `Unsupported verify algorithm: ${canonName}`);
    },
    async encrypt(algorithm, key, data) {
      const algObj = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algObj.name || (key && key.algorithm && key.algorithm.name));
      const upper = canonName.toUpperCase();

      if (upper === "RSA-OAEP") {
        const spki = key && key._meta && key._meta.spki
          ? new Uint8Array(Buffer.from(key._meta.spki, "base64"))
          : key._raw;
        const label = algObj.label ? toBytesInput(algObj.label) : new Uint8Array(0);
        const bytes = toBytesInput(data);
        const hashStd = normalizeSubtleHashStandard((key && key.algorithm && key.algorithm.hash) || algObj.hash || "SHA-256");
        const payload = Buffer.concat([spki, label, bytes]);
        const ct = hostCall(
          "crypto.webcrypto",
          JSON.stringify({
            op: "encrypt",
            alg: canonName,
            hash: hashStd,
            keyLen: spki.byteLength,
            labelLen: label.byteLength,
          }),
          payload
        );
        return toArrayBufferSlice(ct);
      }

      const bits = key._raw.byteLength * 8;
      const iv = toBytesInput(algObj.iv || algObj.counter);
      if (upper === "AES-GCM") {
        const tagLenBytes = algObj.tagLength ? Math.ceil(Number(algObj.tagLength) / 8) : 16;
        const c = new Cipheriv(`aes-${bits}-gcm`, key._raw, iv, { authTagLength: tagLenBytes });
        if (algObj.additionalData) c.setAAD(algObj.additionalData);
        const body = Buffer.concat([c.update(data), c.final()]);
        const out = Buffer.concat([body, c.getAuthTag()]);
        return toArrayBufferSlice(out);
      }
      if (upper === "AES-CBC") {
        const c = new Cipheriv(`aes-${bits}-cbc`, key._raw, iv);
        const out = Buffer.concat([c.update(data), c.final()]);
        return toArrayBufferSlice(out);
      }
      if (upper === "AES-CTR") {
        const c = new Cipheriv(`aes-${bits}-ctr`, key._raw, iv);
        const out = Buffer.concat([c.update(data), c.final()]);
        return toArrayBufferSlice(out);
      }
      throw makeDOMError("NotSupportedError", `Unsupported encrypt algorithm: ${canonName}`);
    },
    async decrypt(algorithm, key, data) {
      const algObj = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algObj.name || (key && key.algorithm && key.algorithm.name));
      const upper = canonName.toUpperCase();
      const bytes = toBytesInput(data);

      if (upper === "RSA-OAEP") {
        if (!key || key.type !== "private") throw makeDOMError("InvalidAccessError", "RSA-OAEP decryption requires a private key");
        const label = algObj.label ? toBytesInput(algObj.label) : new Uint8Array(0);
        const hashStd = normalizeSubtleHashStandard((key.algorithm && key.algorithm.hash) || algObj.hash || "SHA-256");
        const payload = Buffer.concat([key._raw, label, bytes]);
        const pt = hostCall(
          "crypto.webcrypto",
          JSON.stringify({
            op: "decrypt",
            alg: canonName,
            hash: hashStd,
            keyLen: key._raw.byteLength,
            labelLen: label.byteLength,
          }),
          payload
        );
        return toArrayBufferSlice(pt);
      }

      const bits = key._raw.byteLength * 8;
      const iv = toBytesInput(algObj.iv || algObj.counter);
      if (upper === "AES-GCM") {
        const tagLenBytes = algObj.tagLength ? Math.ceil(Number(algObj.tagLength) / 8) : 16;
        if (bytes.byteLength < tagLenBytes) throw makeDOMError("OperationError", "ciphertext too short");
        const ct = bytes.subarray(0, bytes.byteLength - tagLenBytes);
        const tag = bytes.subarray(bytes.byteLength - tagLenBytes);
        const d = new Decipheriv(`aes-${bits}-gcm`, key._raw, iv, { authTagLength: tagLenBytes });
        if (algObj.additionalData) d.setAAD(algObj.additionalData);
        d.setAuthTag(tag);
        const out = Buffer.concat([d.update(ct), d.final()]);
        return toArrayBufferSlice(out);
      }
      if (upper === "AES-CBC") {
        const d = new Decipheriv(`aes-${bits}-cbc`, key._raw, iv);
        const out = Buffer.concat([d.update(bytes), d.final()]);
        return toArrayBufferSlice(out);
      }
      if (upper === "AES-CTR") {
        const d = new Decipheriv(`aes-${bits}-ctr`, key._raw, iv);
        const out = Buffer.concat([d.update(bytes), d.final()]);
        return toArrayBufferSlice(out);
      }
      throw makeDOMError("NotSupportedError", `Unsupported decrypt algorithm: ${canonName}`);
    },
    async deriveBits(algorithm, baseKey, length) {
      const algObj = typeof algorithm === "string" ? { name: algorithm } : Object.assign({}, algorithm);
      const canonName = canonicalAlgName(algObj.name || (baseKey && baseKey.algorithm && baseKey.algorithm.name));
      const upper = canonName.toUpperCase();
      const byteLen = Math.ceil(Number(length) / 8);
      if (!Number.isFinite(byteLen) || byteLen < 0) {
        throw makeDOMError("OperationError", "Invalid deriveBits length");
      }
      const hashAlg = normalizeSubtleHashName(algObj.hash || "SHA-256");
      if (upper === "PBKDF2") {
        const salt = toBytesInput(algObj.salt || new Uint8Array(0));
        const iterations = Number(algObj.iterations || 1);
        const dk = pbkdf2Sync(baseKey._raw, salt, iterations, byteLen, hashAlg);
        return toArrayBufferSlice(dk);
      }
      if (upper === "HKDF") {
        const salt = toBytesInput(algObj.salt || new Uint8Array(0));
        const info = toBytesInput(algObj.info || new Uint8Array(0));
        return hkdfSync(hashAlg, baseKey._raw, salt, info, byteLen);
      }
      if (upper === "ECDH" || upper === "X25519") {
        const pubKey = algObj.public;
        if (!pubKey || !pubKey._meta || !pubKey._meta.spki) {
          throw makeDOMError("InvalidAccessError", "deriveBits requires a valid public CryptoKey");
        }
        const privBytes = baseKey && baseKey._meta && baseKey._meta.pkcs8
          ? new Uint8Array(Buffer.from(baseKey._meta.pkcs8, "base64"))
          : baseKey._raw;
        const pubBytes = new Uint8Array(Buffer.from(pubKey._meta.spki, "base64"));
        const payload = Buffer.concat([privBytes, pubBytes]);
        const shared = hostCall(
          "crypto.webcrypto",
          JSON.stringify({
            op: "deriveBits",
            alg: canonName,
            keyLen: privBytes.byteLength,
            length: Number(length) || 0,
          }),
          payload
        );
        if (length === null || length === undefined) {
          return toArrayBufferSlice(shared);
        }
        const bitLen = Number(length);
        if (!Number.isFinite(bitLen) || bitLen < 0 || bitLen > shared.byteLength * 8) {
          throw makeDOMError("OperationError", "The length provided for deriveBits is invalid");
        }
        if (bitLen === 0) return new ArrayBuffer(0);
        const byteLen = Math.ceil(bitLen / 8);
        const out = new Uint8Array(shared.subarray(0, byteLen));
        const remBits = bitLen % 8;
        if (remBits !== 0) {
          out[byteLen - 1] &= (0xff << (8 - remBits)) & 0xff;
        }
        return toArrayBufferSlice(out);
      }
      throw makeDOMError("NotSupportedError", `Unsupported deriveBits algorithm: ${canonName}`);
    },
    async deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages) {
      const dAlg = typeof derivedKeyType === "string" ? { name: derivedKeyType } : Object.assign({}, derivedKeyType);
      const canonDerived = canonicalAlgName(dAlg.name);
      let bitLen = Number(dAlg.length || 256);
      if (canonDerived === "HMAC" && !dAlg.length) {
        const h = normalizeSubtleHashName(dAlg.hash || "SHA-256");
        bitLen = h === "sha512" || h === "sha384" ? 512 : 256;
      }
      const bits = await this.deriveBits(algorithm, baseKey, bitLen);
      return this.importKey("raw", bits, dAlg, extractable, keyUsages);
    },
  };

  const webcryptoObj = {
    getRandomValues,
    randomUUID,
    subtle: subtleCrypto,
    CryptoKey,
  };
  globalThis.crypto = webcryptoObj;
  globalThis.CryptoKey = CryptoKey;

  function derWrapPEM(derB64, label) {
    const lines = derB64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
  }

  class KeyObject {
    constructor(type, meta, rawSecret) {
      this.type = type;
      this._meta = meta || null;
      this._raw = rawSecret || null;
    }
    get asymmetricKeyType() {
      if (this.type === "secret" || !this._meta) return undefined;
      return this._meta.keyType || this._meta.asymmetricKeyType;
    }
    get asymmetricKeyDetails() {
      if (this.type === "secret" || !this._meta) return undefined;
      const d = {};
      if (this._meta.modulusLength) {
        d.modulusLength = this._meta.modulusLength;
        d.publicExponent = 65537n;
      }
      if (this._meta.namedCurve) {
        const crvMap = { "P-256": "prime256v1", "P-384": "secp384r1", "P-521": "secp521r1" };
        d.namedCurve = crvMap[this._meta.namedCurve] || this._meta.namedCurve;
      }
      return d;
    }
    get symmetricKeySize() {
      if (this.type !== "secret" || !this._raw) return undefined;
      return this._raw.byteLength;
    }
    export(options = {}) {
      if (this.type === "secret") {
        if (options && options.format === "jwk") {
          return { kty: "oct", k: Buffer.from(this._raw).toString("base64url") };
        }
        return Buffer.from(this._raw);
      }
      const fmt = (options && options.format) ? String(options.format).toLowerCase() : "pem";
      const typ = (options && options.type) ? String(options.type).toLowerCase() : (this.type === "private" ? "pkcs8" : "spki");
      if (fmt === "jwk") {
        return Object.assign({}, this.type === "private" ? this._meta.jwkPriv : this._meta.jwkPub);
      }
      let b64;
      let pemLabel;
      if (this.type === "private") {
        if (typ === "pkcs1") {
          b64 = this._meta.pkcs1Priv || this._meta.pkcs8;
          pemLabel = this._meta.pkcs1Priv ? "RSA PRIVATE KEY" : "PRIVATE KEY";
        } else if (typ === "sec1") {
          const sec1Data = this._meta.sec1Priv || this._meta.sec1;
          b64 = sec1Data || this._meta.pkcs8;
          pemLabel = sec1Data ? "EC PRIVATE KEY" : "PRIVATE KEY";
        } else {
          b64 = this._meta.pkcs8;
          pemLabel = "PRIVATE KEY";
        }
      } else {
        if (typ === "pkcs1") {
          b64 = this._meta.pkcs1Pub || this._meta.spki;
          pemLabel = this._meta.pkcs1Pub ? "RSA PUBLIC KEY" : "PUBLIC KEY";
        } else {
          b64 = this._meta.spki;
          pemLabel = "PUBLIC KEY";
        }
      }
      if (fmt === "der") {
        return Buffer.from(b64, "base64");
      }
      return derWrapPEM(b64, pemLabel);
    }
    equals(other) {
      if (!(other instanceof KeyObject) || this.type !== other.type) return false;
      if (this.type === "secret") {
        if (this._raw.byteLength !== other._raw.byteLength) return false;
        return timingSafeEqual(this._raw, other._raw);
      }
      const a = this.type === "private" ? this._meta.pkcs8 : this._meta.spki;
      const b = other.type === "private" ? other._meta.pkcs8 : other._meta.spki;
      return a === b;
    }
    static from(cryptoKey) {
      if (!cryptoKey || !(cryptoKey instanceof CryptoKey)) {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'key' argument must be a CryptoKey", TypeError);
      }
      if (cryptoKey.type === "secret") {
        return new KeyObject("secret", null, cryptoKey._raw);
      }
      return new KeyObject(cryptoKey.type, cryptoKey._meta, null);
    }
  }

  function createSecretKey(key, encoding) {
    const raw = typeof key === "string" ? Buffer.from(key, encoding || "utf8") : toBytesInput(key);
    return new KeyObject("secret", null, Uint8Array.from(raw));
  }

  function parseAsymmetricKeyObject(input, wantPrivate) {
    if (input instanceof KeyObject) {
      if (wantPrivate && input.type !== "private") {
        throw makeNodeError("ERR_INVALID_ARG_VALUE", "Key must be a private key", TypeError);
      }
      if (!wantPrivate && input.type === "private") {
        return new KeyObject("public", Object.assign({}, input._meta, { type: "public" }), null);
      }
      return input;
    }
    if (input instanceof CryptoKey) {
      return parseAsymmetricKeyObject(KeyObject.from(input), wantPrivate);
    }
    let keyVal = input;
    let format = "";
    let type = "";
    if (input && typeof input === "object" && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
      if (input.key !== undefined) {
        keyVal = input.key;
        format = input.format ? String(input.format).toLowerCase() : "";
        type = input.type ? String(input.type).toLowerCase() : "";
        if (keyVal instanceof KeyObject || keyVal instanceof CryptoKey) {
          return parseAsymmetricKeyObject(keyVal, wantPrivate);
        }
      } else if (input.kty) {
        format = "jwk";
      }
    }
    if (format === "jwk") {
      const kty = String(keyVal.kty || "").toUpperCase();
      let alg = "RSASSA-PKCS1-v1_5";
      if (kty === "EC") alg = "ECDSA";
      else if (kty === "OKP") alg = String(keyVal.crv || "").toUpperCase() === "X25519" ? "X25519" : "Ed25519";
      const meta = JSON.parse(
        hostCall(
          "crypto.webcrypto",
          JSON.stringify({ op: "importKey", alg, namedCurve: keyVal.crv || "", format: "jwk", jwk: keyVal }),
          new Uint8Array(0)
        )
      );
      return new KeyObject(wantPrivate ? "private" : "public", meta, null);
    }
    const bytes = toBytesInput(keyVal);
    const meta = JSON.parse(
      hostCall(
        "crypto.webcrypto",
        JSON.stringify({ op: "parseKey", format: type || format }),
        bytes
      )
    );
    if (wantPrivate && meta.type !== "private") {
      throw makeNodeError("ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", "Invalid key object type, expected private", TypeError);
    }
    return new KeyObject(wantPrivate ? "private" : "public", meta, null);
  }

  function createPublicKey(key) {
    return parseAsymmetricKeyObject(key, false);
  }

  function createPrivateKey(key) {
    return parseAsymmetricKeyObject(key, true);
  }

  function generateKeyPairSync(type, options = {}) {
    const t = String(type || "").toLowerCase();
    let alg;
    let namedCurve = "P-256";
    const modulusLength = options && options.modulusLength ? Number(options.modulusLength) : 2048;
    if (t === "rsa" || t === "rsa-pss") {
      alg = t === "rsa-pss" ? "RSA-PSS" : "RSASSA-PKCS1-v1_5";
    } else if (t === "ec") {
      alg = "ECDSA";
      const crv = String((options && options.namedCurve) || "P-256").toLowerCase();
      if (crv === "prime256v1" || crv === "secp256r1" || crv === "p-256") namedCurve = "P-256";
      else if (crv === "secp384r1" || crv === "p-384") namedCurve = "P-384";
      else if (crv === "secp521r1" || crv === "p-521") namedCurve = "P-521";
      else namedCurve = String(options.namedCurve).toUpperCase();
    } else if (t === "ed25519") {
      alg = "Ed25519";
    } else if (t === "x25519") {
      alg = "X25519";
    } else {
      throw makeNodeError("ERR_INVALID_ARG_VALUE", `The argument 'type' must be a supported key type. Received '${type}'`, TypeError);
    }
    const meta = JSON.parse(
      hostCall(
        "crypto.webcrypto",
        JSON.stringify({ op: "generateKey", alg, namedCurve, hash: "SHA-256", modulusLength })
      )
    );
    if (t === "rsa-pss") {
      meta.keyType = "rsa-pss";
    }
    const pubObj = new KeyObject("public", Object.assign({}, meta, { type: "public" }), null);
    const privObj = new KeyObject("private", Object.assign({}, meta, { type: "private" }), null);
    const publicKey = options && options.publicKeyEncoding ? pubObj.export(options.publicKeyEncoding) : pubObj;
    const privateKey = options && options.privateKeyEncoding ? privObj.export(options.privateKeyEncoding) : privObj;
    return { publicKey, privateKey };
  }

  function generateKeyPair(type, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    queueMicrotask(() => {
      try {
        const res = generateKeyPairSync(type, options);
        cb(null, res.publicKey, res.privateKey);
      } catch (err) {
        cb(err);
      }
    });
  }

  function generateKeySync(type, options = {}) {
    const t = String(type || "").toLowerCase();
    if (t !== "hmac" && t !== "aes") {
      throw makeNodeError("ERR_INVALID_ARG_VALUE", `Unsupported key type: ${type}`, TypeError);
    }
    const bitLen = Number(options && options.length);
    if (!Number.isInteger(bitLen) || bitLen <= 0 || (t === "aes" && bitLen !== 128 && bitLen !== 192 && bitLen !== 256)) {
      throw makeNodeError("ERR_INVALID_ARG_VALUE", `Invalid key length: ${bitLen}`, RangeError);
    }
    return createSecretKey(randomBytes(Math.ceil(bitLen / 8)));
  }

  function generateKey(type, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    queueMicrotask(() => {
      try {
        cb(null, generateKeySync(type, options));
      } catch (err) {
        cb(err);
      }
    });
  }

  function normalizeNodeSignHash(algorithm) {
    if (!algorithm) return "";
    const s = String(algorithm).toLowerCase().replace(/^rsa-/, "").replace(/^ecdsa-with-/, "");
    if (s === "sha512-224" || s === "sha-512/224" || s === "sha512/224") return "SHA-512/224";
    if (s === "sha512-256" || s === "sha-512/256" || s === "sha512/256") return "SHA-512/256";
    if (s === "sha3-224") return "SHA3-224";
    if (s === "sha3-256") return "SHA3-256";
    if (s === "sha3-384") return "SHA3-384";
    if (s === "sha3-512") return "SHA3-512";
    if (s === "sha224" || s === "sha-224") return "SHA-224";
    if (s === "md5") return "MD5";
    if (s === "ripemd160" || s === "rmd160") return "RIPEMD160";
    if (s === "blake2s256") return "BLAKE2s256";
    if (s === "blake2b512") return "BLAKE2b512";
    if (s.includes("512")) return "SHA-512";
    if (s.includes("384")) return "SHA-384";
    if (s.includes("256")) return "SHA-256";
    if (s.includes("1")) return "SHA-1";
    return s.toUpperCase();
  }

  function signOneShot(algorithm, data, key, cb) {
    if (typeof cb === "function") {
      queueMicrotask(() => {
        try { cb(null, signOneShot(algorithm, data, key)); } catch (e) { cb(e); }
      });
      return;
    }
    let keyOpts = {};
    if (key && typeof key === "object" && !(key instanceof KeyObject) && !(key instanceof CryptoKey) && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer) && key.key !== undefined) {
      keyOpts = key;
    }
    const privObj = createPrivateKey(key);
    const meta = privObj._meta;
    const kType = privObj.asymmetricKeyType;
    const bytes = toBytesInput(data);
    const hashStd = kType === "ed25519" ? "" : normalizeNodeSignHash(algorithm || "sha256");
    let alg = "RSASSA-PKCS1-v1_5";
    if (kType === "ed25519") alg = "Ed25519";
    else if (kType === "ec") alg = "ECDSA";
    else if (keyOpts.padding === 6 /* RSA_PKCS1_PSS_PADDING */ || kType === "rsa-pss") alg = "RSA-PSS";
    const dsaEnc = keyOpts.dsaEncoding === "ieee-p1363" ? "ieee-p1363" : "der";
    const privRaw = new Uint8Array(Buffer.from(meta.pkcs8, "base64"));
    const payload = Buffer.concat([privRaw, bytes]);
    const sig = hostCall(
      "crypto.webcrypto",
      JSON.stringify({
        op: "sign",
        alg,
        hash: hashStd,
        keyLen: privRaw.byteLength,
        saltLength: keyOpts.saltLength !== undefined ? Number(keyOpts.saltLength) : -2,
        format: dsaEnc,
      }),
      payload
    );
    return new Buffer(sig.buffer, sig.byteOffset, sig.byteLength);
  }

  function verifyOneShot(algorithm, data, key, signature, cb) {
    if (typeof cb === "function") {
      queueMicrotask(() => {
        try { cb(null, verifyOneShot(algorithm, data, key, signature)); } catch (e) { cb(e); }
      });
      return;
    }
    let keyOpts = {};
    if (key && typeof key === "object" && !(key instanceof KeyObject) && !(key instanceof CryptoKey) && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer) && key.key !== undefined) {
      keyOpts = key;
    }
    const pubObj = createPublicKey(key);
    const meta = pubObj._meta;
    const kType = pubObj.asymmetricKeyType;
    const dataBytes = toBytesInput(data);
    const sigBytes = toBytesInput(signature);
    const hashStd = kType === "ed25519" ? "" : normalizeNodeSignHash(algorithm || "sha256");
    let alg = "RSASSA-PKCS1-v1_5";
    if (kType === "ed25519") alg = "Ed25519";
    else if (kType === "ec") alg = "ECDSA";
    else if (keyOpts.padding === 6 /* RSA_PKCS1_PSS_PADDING */ || kType === "rsa-pss") alg = "RSA-PSS";
    const dsaEnc = keyOpts.dsaEncoding === "ieee-p1363" ? "ieee-p1363" : "der";
    const spki = new Uint8Array(Buffer.from(meta.spki, "base64"));
    const payload = Buffer.concat([spki, sigBytes, dataBytes]);
    const ok = hostCall(
      "crypto.webcrypto",
      JSON.stringify({
        op: "verify",
        alg,
        hash: hashStd,
        keyLen: spki.byteLength,
        sigLen: sigBytes.byteLength,
        saltLength: keyOpts.saltLength !== undefined ? Number(keyOpts.saltLength) : -2,
        format: dsaEnc,
      }),
      payload
    );
    return ok === "true";
  }

  class SignStream extends Writable {
    constructor(algorithm) {
      super();
      this._alg = algorithm;
      this._chunks = [];
    }
    _write(chunk, enc, cb) {
      this.update(chunk, enc);
      cb();
    }
    update(data, inputEncoding) {
      this._chunks.push(cloneBytesInput(data, inputEncoding));
      return this;
    }
    sign(privateKey, outputEncoding) {
      const sig = signOneShot(this._alg, Buffer.concat(this._chunks), privateKey);
      return encodeDigestOutput(sig, outputEncoding);
    }
  }

  class VerifyStream extends Writable {
    constructor(algorithm) {
      super();
      this._alg = algorithm;
      this._chunks = [];
    }
    _write(chunk, enc, cb) {
      this.update(chunk, enc);
      cb();
    }
    update(data, inputEncoding) {
      this._chunks.push(cloneBytesInput(data, inputEncoding));
      return this;
    }
    verify(object, signature, signatureEncoding) {
      const sigBytes = typeof signature === "string" ? Buffer.from(signature, signatureEncoding || "utf8") : toBytesInput(signature);
      return verifyOneShot(this._alg, Buffer.concat(this._chunks), object, sigBytes);
    }
  }

  function diffieHellman(options) {
    if (!options || typeof options !== "object") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'options' argument must be an object", TypeError);
    }
    const priv = createPrivateKey(options.privateKey);
    const pub = createPublicKey(options.publicKey);
    const alg = priv.asymmetricKeyType === "x25519" ? "X25519" : "ECDH";
    const privBytes = new Uint8Array(Buffer.from(priv._meta.pkcs8, "base64"));
    const pubBytes = new Uint8Array(Buffer.from(pub._meta.spki, "base64"));
    const shared = hostCall(
      "crypto.webcrypto",
      JSON.stringify({ op: "deriveBits", alg, keyLen: privBytes.byteLength, length: 0 }),
      Buffer.concat([privBytes, pubBytes])
    );
    return new Buffer(shared.buffer, shared.byteOffset, shared.byteLength);
  }

  class ECDH {
    constructor(curveName) {
      const c = String(curveName || "").toLowerCase();
      if (c === "prime256v1" || c === "secp256r1" || c === "p-256") this._crv = "P-256";
      else if (c === "secp384r1" || c === "p-384") this._crv = "P-384";
      else if (c === "secp521r1" || c === "p-521") this._crv = "P-521";
      else throw makeNodeError("ERR_CRYPTO_INVALID_CURVE", `Invalid EC curve name: ${curveName}`, TypeError);
      this._priv = null;
      this._pub = null;
    }
    generateKeys(encoding, _format) {
      const res = JSON.parse(
        hostCall("crypto.webcrypto", JSON.stringify({ op: "ecdhRaw", namedCurve: this._crv, format: "generate" }))
      );
      this._priv = Buffer.from(res.priv, "base64");
      this._pub = Buffer.from(res.pub, "base64");
      return this.getPublicKey(encoding);
    }
    computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
      const otherBytes = typeof otherPublicKey === "string"
        ? Buffer.from(otherPublicKey, inputEncoding || "utf8")
        : toBytesInput(otherPublicKey);
      const payload = Buffer.concat([this._priv, otherBytes]);
      const raw = hostCall(
        "crypto.webcrypto",
        JSON.stringify({ op: "ecdhRaw", namedCurve: this._crv, format: "compute", keyLen: this._priv.byteLength }),
        payload
      );
      return encodeDigestOutput(raw, outputEncoding);
    }
    getPublicKey(encoding) {
      return encodeDigestOutput(this._pub || Buffer.alloc(0), encoding);
    }
    getPrivateKey(encoding) {
      return encodeDigestOutput(this._priv || Buffer.alloc(0), encoding);
    }
    setPrivateKey(privateKey, encoding) {
      this._priv = typeof privateKey === "string" ? Buffer.from(privateKey, encoding || "utf8") : Buffer.from(toBytesInput(privateKey));
    }
  }

  class DiffieHellman {
    constructor(sizeOrKey, keyEncoding, generator, genEncoding) {
      if (typeof sizeOrKey === "number") {
        const bits = Math.max(64, Number(sizeOrKey));
        const pBytes = hostCall("crypto.webcrypto", JSON.stringify({ op: "generatePrime", modulusLength: bits, safe: false }));
        this._prime = new Buffer(pBytes.buffer, pBytes.byteOffset, pBytes.byteLength);
      } else {
        this._prime = typeof sizeOrKey === "string" ? Buffer.from(sizeOrKey, keyEncoding || "utf8") : Buffer.from(toBytesInput(sizeOrKey));
      }
      if (typeof generator === "number") {
        this._gen = Buffer.from([generator & 0xff]);
      } else if (generator !== undefined) {
        this._gen = typeof generator === "string" ? Buffer.from(generator, genEncoding || "utf8") : Buffer.from(toBytesInput(generator));
      } else {
        this._gen = Buffer.from([2]);
      }
      this._priv = null;
      this._pub = null;
    }
    generateKeys(encoding) {
      if (!this._priv) {
        this._priv = randomBytes(this._prime.byteLength);
        this._priv[0] &= 0x7f;
      }
      const payload = Buffer.concat([this._prime, this._priv, this._gen]);
      const raw = hostCall(
        "crypto.webcrypto",
        JSON.stringify({ op: "dhCompute", keyLen: this._prime.byteLength, sigLen: this._priv.byteLength }),
        payload
      );
      this._pub = new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
      return encodeDigestOutput(this._pub, encoding);
    }
    computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
      const other = typeof otherPublicKey === "string" ? Buffer.from(otherPublicKey, inputEncoding || "utf8") : Buffer.from(toBytesInput(otherPublicKey));
      if (!this._priv) {
        throw makeNodeError("ERR_CRYPTO_INVALID_STATE", "Invalid state for operation computeSecret", Error);
      }
      const payload = Buffer.concat([this._prime, this._priv, other]);
      const raw = hostCall(
        "crypto.webcrypto",
        JSON.stringify({ op: "dhCompute", keyLen: this._prime.byteLength, sigLen: this._priv.byteLength }),
        payload
      );
      return encodeDigestOutput(raw, outputEncoding);
    }
    getPrime(encoding) { return encodeDigestOutput(this._prime, encoding); }
    getGenerator(encoding) { return encodeDigestOutput(this._gen, encoding); }
    getPublicKey(encoding) { return encodeDigestOutput(this._pub || Buffer.alloc(0), encoding); }
    getPrivateKey(encoding) { return encodeDigestOutput(this._priv || Buffer.alloc(0), encoding); }
    setPublicKey(k, enc) { this._pub = typeof k === "string" ? Buffer.from(k, enc || "utf8") : Buffer.from(toBytesInput(k)); return this; }
    setPrivateKey(k, enc) { this._priv = typeof k === "string" ? Buffer.from(k, enc || "utf8") : Buffer.from(toBytesInput(k)); return this; }
  }

  function generatePrimeSync(size, options = {}) {
    const bits = Number(size);
    if (!Number.isInteger(bits) || bits < 2) {
      throw makeNodeError("ERR_OUT_OF_RANGE", "The value of 'size' must be >= 2", RangeError);
    }
    const raw = hostCall(
      "crypto.webcrypto",
      JSON.stringify({ op: "generatePrime", modulusLength: bits, safe: Boolean(options && options.safe) })
    );
    const buf = new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
    if (options && options.bigint) {
      return BigInt("0x" + (buf.toString("hex") || "0"));
    }
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  function generatePrime(size, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    queueMicrotask(() => {
      try { cb(null, generatePrimeSync(size, options)); } catch (e) { cb(e); }
    });
  }

  function checkPrimeSync(candidate, options = {}) {
    let bytes;
    if (typeof candidate === "bigint") {
      if (candidate < 0n) throw makeNodeError("ERR_OUT_OF_RANGE", "candidate must be non-negative", RangeError);
      let hex = candidate.toString(16);
      if (hex.length % 2 !== 0) hex = "0" + hex;
      bytes = Buffer.from(hex, "hex");
    } else {
      bytes = toBytesInput(candidate);
    }
    const checks = options && options.checks ? Number(options.checks) : 0;
    return hostCall("crypto.webcrypto", JSON.stringify({ op: "checkPrime", saltLength: checks }), bytes) === "true";
  }

  function checkPrime(candidate, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    queueMicrotask(() => {
      try { cb(null, checkPrimeSync(candidate, options)); } catch (e) { cb(e); }
    });
  }

  function publicEncrypt(key, buffer) {
    const keyOpts = (key && typeof key === "object" && !(key instanceof KeyObject) && !(key instanceof CryptoKey) && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer) && key.key !== undefined) ? key : { key };
    const pubObj = createPublicKey(key);
    const spki = new Uint8Array(Buffer.from(pubObj._meta.spki, "base64"));
    const data = toBytesInput(buffer);
    const padding = keyOpts.padding !== undefined ? Number(keyOpts.padding) : 4;
    const oaepHash = normalizeNodeSignHash(keyOpts.oaepHash || "sha1");
    const op = padding === 1 ? "rsaPKCS1Encrypt" : "encrypt";
    const raw = hostCall(
      "crypto.webcrypto",
      JSON.stringify({ op, alg: "RSA-OAEP", hash: oaepHash, keyLen: spki.byteLength }),
      Buffer.concat([spki, data])
    );
    return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  function privateDecrypt(privateKey, buffer) {
    const keyOpts = (privateKey && typeof privateKey === "object" && !(privateKey instanceof KeyObject) && !(privateKey instanceof CryptoKey) && !ArrayBuffer.isView(privateKey) && !(privateKey instanceof ArrayBuffer) && privateKey.key !== undefined) ? privateKey : { key: privateKey };
    const privObj = createPrivateKey(privateKey);
    const pkcs8 = new Uint8Array(Buffer.from(privObj._meta.pkcs8, "base64"));
    const data = toBytesInput(buffer);
    const padding = keyOpts.padding !== undefined ? Number(keyOpts.padding) : 4;
    const oaepHash = normalizeNodeSignHash(keyOpts.oaepHash || "sha1");
    const op = padding === 1 ? "rsaPKCS1Decrypt" : "decrypt";
    const raw = hostCall(
      "crypto.webcrypto",
      JSON.stringify({ op, alg: "RSA-OAEP", hash: oaepHash, keyLen: pkcs8.byteLength }),
      Buffer.concat([pkcs8, data])
    );
    return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  function privateEncrypt(privateKey, buffer) {
    const privObj = createPrivateKey(privateKey);
    const pkcs8 = new Uint8Array(Buffer.from(privObj._meta.pkcs8, "base64"));
    const data = toBytesInput(buffer);
    const raw = hostCall(
      "crypto.webcrypto",
      JSON.stringify({ op: "rsaPrivEncrypt", keyLen: pkcs8.byteLength }),
      Buffer.concat([pkcs8, data])
    );
    return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  function publicDecrypt(key, buffer) {
    const pubObj = createPublicKey(key);
    const spki = new Uint8Array(Buffer.from(pubObj._meta.spki, "base64"));
    const data = toBytesInput(buffer);
    const raw = hostCall(
      "crypto.webcrypto",
      JSON.stringify({ op: "rsaPubDecrypt", keyLen: spki.byteLength }),
      Buffer.concat([spki, data])
    );
    return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  class X509Certificate {
    constructor(buffer) {
      const info = JSON.parse(hostCall("crypto.webcrypto", JSON.stringify({ op: "parseX509" }), toBytesInput(buffer)));
      this.subject = info.subject || "";
      this.issuer = info.issuer || "";
      this.validFrom = info.validFrom || "";
      this.validTo = info.validTo || "";
      this.serialNumber = info.serialNumber || "";
      this.fingerprint = info.fingerprint || "";
      this.fingerprint256 = info.fingerprint256 || "";
      this.fingerprint512 = info.fingerprint512 || "";
      this.ca = Boolean(info.ca);
      this._raw = Buffer.from(info.raw || "", "base64");
      this._spki = info.spki || "";
    }
    get raw() { return this._raw; }
    get publicKey() {
      return createPublicKey({ key: Buffer.from(this._spki, "base64"), format: "der", type: "spki" });
    }
    toString() {
      return derWrapPEM(this._raw.toString("base64"), "CERTIFICATE");
    }
    toJSON() { return this.toString(); }
  }

  function getCipherInfo(nameOrNid, options) {
    const name = String(nameOrNid || "").toLowerCase();
    if (name === "chacha20-poly1305") {
      if (options && options.keyLength !== undefined && Number(options.keyLength) !== 32) return undefined;
      if (options && options.ivLength !== undefined && Number(options.ivLength) !== 12) return undefined;
      return { name, nid: 0, blockSize: 1, ivLength: 12, keyLength: 32, mode: "stream" };
    }
    const m = /^aes-(128|192|256)-(cbc|ctr|gcm)$/.exec(name);
    if (!m) return undefined;
    const keyLength = Number(m[1]) / 8;
    const mode = m[2];
    const ivLength = mode === "gcm" ? 12 : 16;
    const blockSize = mode === "cbc" ? 16 : 1;
    if (options && options.keyLength !== undefined && Number(options.keyLength) !== keyLength) return undefined;
    if (options && options.ivLength !== undefined && Number(options.ivLength) !== ivLength) return undefined;
    return { name, nid: 0, blockSize, ivLength, keyLength, mode };
  }

  const DH_GROUPS = {
    modp1: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A3620FFFFFFFFFFFFFFFF",
    modp2: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF",
    modp5: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA237327FFFFFFFFFFFFFFFF",
    modp14: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF",
    modp15: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
    modp16: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF",
    modp17: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DCC4024FFFFFFFFFFFFFFFF",
    modp18: "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E438777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F5683423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A364597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F924009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E7160C980DD98EDD3DFFFFFFFFFFFFFFFFFF",
  };

  class DiffieHellmanGroup extends DiffieHellman {
    constructor(name) {
      const hex = DH_GROUPS[String(name || "").toLowerCase()];
      if (!hex) {
        throw makeNodeError("ERR_CRYPTO_UNKNOWN_DH_GROUP", `Unknown DH group: ${name}`, TypeError);
      }
      super(Buffer.from(hex, "hex"), undefined, 2);
    }
  }
  class Certificate {
    static exportChallenge(spkac) { return Buffer.from(toBytesInput(spkac)); }
    static exportPublicKey(spkac) { return Buffer.from(toBytesInput(spkac)); }
    static verifySpkac(spkac) { return toBytesInput(spkac).byteLength > 0; }
    exportChallenge(spkac) { return Certificate.exportChallenge(spkac); }
    exportPublicKey(spkac) { return Certificate.exportPublicKey(spkac); }
    verifySpkac(spkac) { return Certificate.verifySpkac(spkac); }
  }

  builtins["crypto"] = {
    Hash,
    Hmac,
    Cipher: Cipheriv,
    Decipher: Decipheriv,
    Cipheriv,
    Decipheriv,
    CryptoKey,
    KeyObject,
    Sign: SignStream,
    Verify: VerifyStream,
    DiffieHellman,
    DiffieHellmanGroup,
    ECDH,
    X509Certificate,
    Certificate,
    createHash: (alg, options) => new Hash(alg, options),
    createHmac: (alg, key) => new Hmac(alg, key),
    createCipheriv: (alg, key, iv, options) => new Cipheriv(alg, key, iv, options),
    createDecipheriv: (alg, key, iv, options) => new Decipheriv(alg, key, iv, options),
    createSign: (alg) => new SignStream(alg),
    createVerify: (alg) => new VerifyStream(alg),
    createSecretKey,
    createPublicKey,
    createPrivateKey,
    generateKeyPairSync,
    generateKeyPair,
    generateKeySync,
    generateKey,
    sign: signOneShot,
    verify: verifyOneShot,
    publicEncrypt,
    privateDecrypt,
    privateEncrypt,
    publicDecrypt,
    diffieHellman,
    createDiffieHellman: (sizeOrKey, keyEnc, gen, genEnc) => new DiffieHellman(sizeOrKey, keyEnc, gen, genEnc),
    createDiffieHellmanGroup: (name) => new DiffieHellmanGroup(name),
    getDiffieHellman: (name) => new DiffieHellmanGroup(name),
    createECDH: (curve) => new ECDH(curve),
    generatePrimeSync,
    generatePrime,
    checkPrimeSync,
    checkPrime,
    getCipherInfo,
    getFips: () => 0,
    setFips: () => {},
    setEngine: () => {},
    secureHeapUsed: () => ({ total: 0, min: 0, used: 0, utilization: 0 }),
    getCurves: () => ["prime256v1", "secp384r1", "secp521r1"],
    hash(alg, data, optionsOrEnc = "hex") {
      let outputEncoding = "hex";
      let outputLength;
      if (typeof optionsOrEnc === "string") {
        outputEncoding = optionsOrEnc;
      } else if (optionsOrEnc && typeof optionsOrEnc === "object") {
        if (optionsOrEnc.outputEncoding !== undefined) outputEncoding = optionsOrEnc.outputEncoding;
        if (typeof optionsOrEnc.outputLength === "number") outputLength = optionsOrEnc.outputLength;
      }
      const arg = outputLength !== undefined ? JSON.stringify({ alg: String(alg), outputLength }) : String(alg);
      const raw = hostCall("crypto.hash", arg, toBytesInput(data));
      return encodeDigestOutput(raw, outputEncoding);
    },
    getHashes: () => [
      "blake2b512", "blake2s256",
      "md5", "ripemd160", "sha1", "sha224", "sha256", "sha384", "sha512",
      "sha512-224", "sha512-256",
      "sha3-224", "sha3-256", "sha3-384", "sha3-512",
      "shake128", "shake256",
    ],
    getCiphers: () => [
      "aes-128-cbc", "aes-192-cbc", "aes-256-cbc",
      "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
      "aes-128-gcm", "aes-192-gcm", "aes-256-gcm",
      "chacha20-poly1305",
    ],
    randomBytes,
    randomFillSync,
    randomFill,
    randomInt,
    randomUUID,
    getRandomValues,
    pbkdf2Sync,
    pbkdf2,
    hkdfSync,
    hkdf,
    scryptSync,
    scrypt,
    timingSafeEqual,
    subtle: subtleCrypto,
    webcrypto: webcryptoObj,
    constants: {
      RSA_PKCS1_PADDING: 1,
      RSA_NO_PADDING: 3,
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PSS_PADDING: 6,
      RSA_PSS_SALTLEN_DIGEST: -1,
      RSA_PSS_SALTLEN_MAX_SIGN: -2,
      RSA_PSS_SALTLEN_AUTO: -2,
    },
  };

  function validateZlibOptions(options) {
    if (options && typeof options === "object") {
      if (options.maxOutputLength !== undefined) {
        if (typeof options.maxOutputLength !== "number" || Number.isNaN(options.maxOutputLength)) {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", 'The "options.maxOutputLength" property must be of type number', TypeError);
        }
        if (!Number.isFinite(options.maxOutputLength) || !Number.isInteger(options.maxOutputLength) || options.maxOutputLength < 1 || options.maxOutputLength > 0x7fffffff) {
          throw makeNodeError("ERR_OUT_OF_RANGE", `The value of "options.maxOutputLength" is out of range. It must be >= 1 and <= 2147483647. Received ${options.maxOutputLength}`, RangeError);
        }
      }
      if (options.level !== undefined) {
        if (typeof options.level !== "number" || Number.isNaN(options.level)) {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", 'The "options.level" property must be of type number', TypeError);
        }
        if (!Number.isInteger(options.level) || options.level < -1 || options.level > 9) {
          throw makeNodeError("ERR_OUT_OF_RANGE", `The value of "options.level" is out of range. It must be >= -1 and <= 9. Received ${options.level}`, RangeError);
        }
      }
    }
  }
  function makeZlibSync(mode) {
    return function (buffer, options) {
      validateZlibOptions(options);
      let arg = mode;
      if (options && typeof options === "object") {
        arg = JSON.stringify({
          mode,
          level: typeof options.level === "number" ? options.level : undefined,
          maxOutputLength: typeof options.maxOutputLength === "number" ? options.maxOutputLength : undefined,
        });
      }
      const raw = hostCall("zlib.transform", arg, toBytesInput(buffer));
      return new Buffer(raw.buffer, raw.byteOffset, raw.byteLength);
    };
  }
  let nextZlibStreamId = 1;
  function makeZlibStream(mode) {
    const syncFn = makeZlibSync(mode);
    const isDecompress = mode === "gunzip" || mode === "unzip" || mode === "inflate" || mode === "inflateRaw" || mode === "brotliDecompress" || mode === "zstdDecompress";
    const isStreamCompress = mode === "gzip" || mode === "deflate" || mode === "deflateRaw";
    return function (options) {
      validateZlibOptions(options);
      if (isStreamCompress) {
        const streamId = nextZlibStreamId++;
        const level = options && typeof options === "object" && typeof options.level === "number" ? options.level : undefined;
        const maxOutputLength = options && typeof options === "object" && typeof options.maxOutputLength === "number" ? options.maxOutputLength : undefined;
        let finished = false;
        const st = new Transform({
          transform(chunk, enc, cb) {
            const bytes = toBytesInput(chunk, enc);
            if (bytes.byteLength === 0) {
              cb();
              return;
            }
            try {
              const raw = hostCall("zlib.transform", JSON.stringify({ mode, streamId, level, maxOutputLength, flush: false, finish: false }), bytes);
              if (raw && raw.byteLength > 0) {
                this.push(new Buffer(raw.buffer, raw.byteOffset, raw.byteLength));
              }
              cb();
            } catch (e) {
              finished = true;
              cb(e);
            }
          },
          flush(cb) {
            if (finished) {
              cb();
              return;
            }
            finished = true;
            try {
              const raw = hostCall("zlib.transform", JSON.stringify({ mode, streamId, level, maxOutputLength, flush: false, finish: true }), new Uint8Array(0));
              if (raw && raw.byteLength > 0) {
                this.push(new Buffer(raw.buffer, raw.byteOffset, raw.byteLength));
              }
              cb();
            } catch (e) {
              cb(e);
            }
          },
        });
        const origDestroy = st.destroy.bind(st);
        st.destroy = function (err) {
          if (!finished) {
            finished = true;
            try { hostCall("zlib.transform", JSON.stringify({ mode, streamId, cancel: true }), new Uint8Array(0)); } catch (_) {}
          }
          return origDestroy(err);
        };
        st.flush = function (kind, cb) {
          if (typeof kind === "function") cb = kind;
          if (!finished) {
            try {
              const raw = hostCall("zlib.transform", JSON.stringify({ mode, streamId, level, maxOutputLength, flush: true, finish: false }), new Uint8Array(0));
              if (raw && raw.byteLength > 0) {
                st.push(new Buffer(raw.buffer, raw.byteOffset, raw.byteLength));
              }
            } catch (e) {
              finished = true;
              if (typeof cb === "function") processObj.nextTick(() => cb(e));
              st.destroy(e);
              return;
            }
          }
          if (typeof cb === "function") processObj.nextTick(cb);
        };
        return st;
      }
      const chunks = [];
      let flushedManual = false;
      let triedSingle = false;
      const st = new Transform({
        transform(chunk, enc, cb) {
          const bytes = toBytesInput(chunk, enc);
          if (bytes.byteLength === 0) {
            processObj.nextTick(cb);
            return;
          }
          chunks.push(bytes);
          flushedManual = false;
          if (isDecompress && chunks.length === 1 && !triedSingle) {
            triedSingle = true;
            try {
              const out = syncFn(bytes, options);
              chunks.length = 0;
              flushedManual = true;
              processObj.nextTick(() => cb(null, out));
              return;
            } catch (e) {
              if (e && e.code === "ERR_BUFFER_TOO_LARGE") {
                chunks.length = 0;
                processObj.nextTick(() => cb(e));
                return;
              }
            }
          }
          processObj.nextTick(cb);
        },
        flush(cb) {
          if (chunks.length === 0) {
            if (flushedManual || isDecompress) {
              processObj.nextTick(cb);
              return;
            }
            try {
              const out = syncFn(Buffer.alloc(0), options);
              processObj.nextTick(() => cb(null, out));
            } catch (e) {
              processObj.nextTick(() => cb(e));
            }
            return;
          }
          try {
            const input = Buffer.concat(chunks);
            chunks.length = 0;
            const out = syncFn(input, options);
            processObj.nextTick(() => cb(null, out));
          } catch (e) {
            chunks.length = 0;
            processObj.nextTick(() => cb(e));
          }
        },
      });
      st.flush = function (kind, cb) {
        if (typeof kind === "function") {
          cb = kind;
        }
        if (chunks.length > 0) {
          try {
            const input = Buffer.concat(chunks);
            chunks.length = 0;
            const out = syncFn(input, options);
            flushedManual = true;
            st.push(out);
          } catch (e) {
            if (typeof cb === "function") processObj.nextTick(() => cb(e));
            st.destroy(e);
            return;
          }
        }
        if (typeof cb === "function") processObj.nextTick(cb);
      };
      return st;
    };
  }

  const gzipSync = makeZlibSync("gzip");
  const gunzipSync = makeZlibSync("gunzip");
  const deflateSync = makeZlibSync("deflate");
  const inflateSync = makeZlibSync("inflate");
  const deflateRawSync = makeZlibSync("deflateRaw");
  const inflateRawSync = makeZlibSync("inflateRaw");
  const unzipSync = makeZlibSync("unzip");
  const brotliCompressSync = makeZlibSync("brotliCompress");
  const brotliDecompressSync = makeZlibSync("brotliDecompress");
  const zstdCompressSync = makeZlibSync("zstdCompress");
  const zstdDecompressSync = makeZlibSync("zstdDecompress");

  let crc32Table = null;
  function crc32(data, value = 0) {
    const bytes = toBytesInput(data);
    if (value !== undefined && typeof value !== "number") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "value" argument must be of type number. Received ${value === null ? "null" : typeof value}`, TypeError);
    }
    if (!crc32Table) {
      crc32Table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
          c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crc32Table[i] = c >>> 0;
      }
    }
    let crc = (value ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.byteLength; i++) {
      crc = (crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const createGzip = makeZlibStream("gzip");
  const createGunzip = makeZlibStream("gunzip");
  const createDeflate = makeZlibStream("deflate");
  const createInflate = makeZlibStream("inflate");
  const createDeflateRaw = makeZlibStream("deflateRaw");
  const createInflateRaw = makeZlibStream("inflateRaw");
  const createUnzip = makeZlibStream("unzip");
  const createBrotliCompress = makeZlibStream("brotliCompress");
  const createBrotliDecompress = makeZlibStream("brotliDecompress");
  const createZstdCompress = makeZlibStream("zstdCompress");
  const createZstdDecompress = makeZlibStream("zstdDecompress");

  builtins["zlib"] = {
    crc32,
    gzipSync,
    gunzipSync,
    deflateSync,
    inflateSync,
    deflateRawSync,
    inflateRawSync,
    unzipSync,
    brotliCompressSync,
    brotliDecompressSync,
    zstdCompressSync,
    zstdDecompressSync,
    gzip: wrapCallback(gzipSync),
    gunzip: wrapCallback(gunzipSync),
    deflate: wrapCallback(deflateSync),
    inflate: wrapCallback(inflateSync),
    deflateRaw: wrapCallback(deflateRawSync),
    inflateRaw: wrapCallback(inflateRawSync),
    unzip: wrapCallback(unzipSync),
    brotliCompress: wrapCallback(brotliCompressSync),
    brotliDecompress: wrapCallback(brotliDecompressSync),
    zstdCompress: wrapCallback(zstdCompressSync),
    zstdDecompress: wrapCallback(zstdDecompressSync),
    createGzip,
    createGunzip,
    createDeflate,
    createInflate,
    createDeflateRaw,
    createInflateRaw,
    createUnzip,
    createBrotliCompress,
    createBrotliDecompress,
    createZstdCompress,
    createZstdDecompress,
    Gzip: createGzip,
    Gunzip: createGunzip,
    Deflate: createDeflate,
    Inflate: createInflate,
    DeflateRaw: createDeflateRaw,
    InflateRaw: createInflateRaw,
    Unzip: createUnzip,
    BrotliCompress: createBrotliCompress,
    BrotliDecompress: createBrotliDecompress,
    ZstdCompress: createZstdCompress,
    ZstdDecompress: createZstdDecompress,
    constants: {
      Z_NO_FLUSH: 0,
      Z_PARTIAL_FLUSH: 1,
      Z_SYNC_FLUSH: 2,
      Z_FULL_FLUSH: 3,
      Z_FINISH: 4,
      Z_BLOCK: 5,
      Z_TREES: 6,
      Z_OK: 0,
      Z_STREAM_END: 1,
      Z_NEED_DICT: 2,
      Z_ERRNO: -1,
      Z_STREAM_ERROR: -2,
      Z_DATA_ERROR: -3,
      Z_MEM_ERROR: -4,
      Z_BUF_ERROR: -5,
      Z_VERSION_ERROR: -6,
      Z_NO_COMPRESSION: 0,
      Z_BEST_SPEED: 1,
      Z_BEST_COMPRESSION: 9,
      Z_DEFAULT_COMPRESSION: -1,
      Z_FILTERED: 1,
      Z_HUFFMAN_ONLY: 2,
      Z_RLE: 3,
      Z_FIXED: 4,
      Z_DEFAULT_STRATEGY: 0,
      Z_BINARY: 0,
      Z_TEXT: 1,
      Z_ASCII: 1,
      Z_UNKNOWN: 2,
      Z_DEFLATED: 8,
      Z_MIN_WINDOWBITS: 8,
      Z_MAX_WINDOWBITS: 15,
      Z_DEFAULT_WINDOWBITS: 15,
      Z_MIN_CHUNK: 64,
      Z_MAX_CHUNK: Infinity,
      Z_DEFAULT_CHUNK: 16384,
      Z_MIN_MEMLEVEL: 1,
      Z_MAX_MEMLEVEL: 9,
      Z_DEFAULT_MEMLEVEL: 8,
      Z_MIN_LEVEL: -1,
      Z_MAX_LEVEL: 9,
      Z_DEFAULT_LEVEL: -1,
      DEFLATE: 1,
      INFLATE: 2,
      GZIP: 3,
      GUNZIP: 4,
      DEFLATERAW: 5,
      INFLATERAW: 6,
      UNZIP: 7,
      BROTLI_DECODE: 8,
      BROTLI_ENCODE: 9,
      BROTLI_OPERATION_PROCESS: 0,
      BROTLI_OPERATION_FLUSH: 1,
      BROTLI_OPERATION_FINISH: 2,
      BROTLI_OPERATION_EMIT_METADATA: 3,
      BROTLI_PARAM_MODE: 0,
      BROTLI_MODE_GENERIC: 0,
      BROTLI_MODE_TEXT: 1,
      BROTLI_MODE_FONT: 2,
      BROTLI_PARAM_QUALITY: 1,
      BROTLI_MIN_QUALITY: 0,
      BROTLI_MAX_QUALITY: 11,
      BROTLI_DEFAULT_QUALITY: 11,
      BROTLI_PARAM_LGWIN: 2,
      BROTLI_MIN_WINDOW_BITS: 10,
      BROTLI_MAX_WINDOW_BITS: 24,
      BROTLI_DEFAULT_WINDOW: 22,
    },
  };

  // =========================================================================
  // 15. Fetch, Headers, Request, Response, FormData, HTTP, HTTPS, Net, DNS
  // =========================================================================

  const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;
  function validateFetchHeaderName(name) {
    const k = String(name);
    if (!HTTP_TOKEN_RE.test(k)) {
      throw new TypeError(`Headers: Invalid header name: "${k}"`);
    }
    return k.toLowerCase();
  }
  function normalizeFetchHeaderValue(value) {
    const v = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
    if (/[\r\n\0]/.test(v)) {
      throw new TypeError(`Headers: Invalid header value: "${v}"`);
    }
    return v;
  }

  class Headers {
    constructor(initHeaders) {
      this._map = new Map();
      this._cookies = [];
      if (initHeaders instanceof Headers) {
        for (const [k, v] of initHeaders._map.entries()) this._map.set(k, v);
        this._cookies = initHeaders._cookies.slice();
      } else if (Array.isArray(initHeaders) || (initHeaders && typeof initHeaders === "object" && typeof initHeaders[Symbol.iterator] === "function")) {
        for (const pair of initHeaders) {
          if (!pair || typeof pair !== "object" || pair.length !== 2) {
            throw new TypeError("Headers constructor: expected [name, value] tuple");
          }
          this.append(pair[0], pair[1]);
        }
      } else if (initHeaders && typeof initHeaders === "object") {
        for (const [k, v] of Object.entries(initHeaders)) {
          if (k.toLowerCase() === "set-cookie" && Array.isArray(v)) {
            for (const item of v) this.append(k, item);
          } else {
            this.append(k, v);
          }
        }
      }
    }
    append(name, value) {
      const k = validateFetchHeaderName(name);
      const v = normalizeFetchHeaderValue(value);
      if (k === "set-cookie") {
        this._cookies.push(v);
      }
      this._map.set(k, this._map.has(k) ? `${this._map.get(k)}, ${v}` : v);
    }
    set(name, value) {
      const k = validateFetchHeaderName(name);
      const v = normalizeFetchHeaderValue(value);
      if (k === "set-cookie") {
        this._cookies = [v];
      }
      this._map.set(k, v);
    }
    get(name) {
      const k = validateFetchHeaderName(name);
      return this._map.has(k) ? this._map.get(k) : null;
    }
    getSetCookie() {
      return this._cookies.slice();
    }
    has(name) {
      return this._map.has(validateFetchHeaderName(name));
    }
    delete(name) {
      const k = validateFetchHeaderName(name);
      if (k === "set-cookie") {
        this._cookies = [];
      }
      this._map.delete(k);
    }
    forEach(cb, thisArg) {
      for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
    }
    *entries() {
      for (const [k, v] of this._map.entries()) {
        if (k === "set-cookie") {
          for (const c of this._cookies) yield [k, c];
        } else {
          yield [k, v];
        }
      }
    }
    *keys() {
      for (const [k] of this.entries()) yield k;
    }
    *values() {
      for (const [, v] of this.entries()) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }

  class FormData {
    constructor() { this._entries = []; }
    _normalizeValue(value, filename) {
      if (value instanceof Blob) {
        if (filename !== undefined) {
          return new File([value], String(filename), { type: value.type });
        }
        if (!(value instanceof File)) {
          return new File([value], "blob", { type: value.type });
        }
        return value;
      }
      return String(value);
    }
    append(name, value, filename) {
      this._entries.push([String(name), this._normalizeValue(value, filename)]);
    }
    set(name, value, filename) {
      const k = String(name);
      const norm = this._normalizeValue(value, filename);
      let replaced = false;
      const next = [];
      for (const entry of this._entries) {
        if (entry[0] === k) {
          if (!replaced) {
            next.push([k, norm]);
            replaced = true;
          }
        } else {
          next.push(entry);
        }
      }
      if (!replaced) {
        next.push([k, norm]);
      }
      this._entries = next;
    }
    get(name) {
      const found = this._entries.find(([k]) => k === String(name));
      return found ? found[1] : null;
    }
    getAll(name) {
      return this._entries.filter(([k]) => k === String(name)).map(([, v]) => v);
    }
    has(name) {
      return this._entries.some(([k]) => k === String(name));
    }
    delete(name) {
      this._entries = this._entries.filter(([k]) => k !== String(name));
    }
    forEach(cb, thisArg) {
      for (const [k, v] of this._entries) cb.call(thisArg, v, k, this);
    }
    *entries() { for (const p of this._entries) yield p; }
    *keys() { for (const [k] of this._entries) yield k; }
    *values() { for (const [, v] of this._entries) yield v; }
    [Symbol.iterator]() { return this.entries(); }
  }

  function serializeFormData(fd) {
    const boundary = "----IndirectFormBoundary" + randomUUID().replace(/-/g, "");
    const parts = [];
    for (const [name, value] of fd._entries) {
      const safeName = String(name).replace(/"/g, "%22");
      if (value instanceof Blob) {
        const filename = (value.name || "blob").replace(/"/g, "%22");
        const contentType = value.type || "application/octet-stream";
        parts.push(
          utf8Encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
          )
        );
        parts.push(value._bytes);
        parts.push(utf8Encode("\r\n"));
      } else {
        parts.push(
          utf8Encode(`--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${String(value)}\r\n`)
        );
      }
    }
    parts.push(utf8Encode(`--${boundary}--\r\n`));
    return {
      bytes: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function isBodyStreamLike(body) {
    return Boolean(
      body &&
      typeof body === "object" &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof FormData) &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body) &&
      (body instanceof ReadableStream ||
        body instanceof Readable ||
        typeof body.getReader === "function" ||
        typeof body[Symbol.asyncIterator] === "function" ||
        typeof body.on === "function")
    );
  }

  async function consumeStreamLikeToBytes(stream) {
    const chunks = [];
    let total = 0;
    const maxBodyBytes = 64 * 1024 * 1024;
    const pushChunk = (raw) => {
      const b = toBytesInput(raw);
      total += b.byteLength;
      if (total > maxBodyBytes) {
        const err = new RangeError(`Request body size (${total}) exceeds maximum buffer (${maxBodyBytes})`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
      chunks.push(b);
    };
    if (typeof stream.getReader === "function") {
      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined && value !== null) pushChunk(value);
      }
    } else if (typeof stream[Symbol.asyncIterator] === "function") {
      for await (const item of stream) {
        if (item !== undefined && item !== null) pushChunk(item);
      }
    } else if (typeof stream.on === "function") {
      await new Promise((resolve, reject) => {
        stream.on("data", (c) => {
          try {
            if (c !== undefined && c !== null) pushChunk(c);
          } catch (e) {
            reject(e);
          }
        });
        stream.once("end", resolve);
        stream.once("error", reject);
      });
    }
    return chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks);
  }

  async function pumpStreamLikeToFetch(id, stream) {
    let total = 0;
    const maxBodyBytes = 64 * 1024 * 1024;
    const writeChunk = (raw) => {
      if (!pendingFetches.has(id)) return false;
      const b = toBytesInput(raw);
      total += b.byteLength;
      if (total > maxBodyBytes) {
        const err = new RangeError(`Request body size (${total}) exceeds maximum buffer (${maxBodyBytes})`);
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
      if (b.byteLength > 0) {
        hostCall("http.writeFetchBody", JSON.stringify({ id, eof: false }), b);
      }
      return true;
    };
    if (typeof stream.getReader === "function") {
      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined && value !== null) {
          if (!writeChunk(value)) return;
        }
      }
    } else if (typeof stream[Symbol.asyncIterator] === "function") {
      for await (const item of stream) {
        if (item !== undefined && item !== null) {
          if (!writeChunk(item)) return;
        }
      }
    } else if (typeof stream.on === "function") {
      await new Promise((resolve, reject) => {
        stream.on("data", (c) => {
          try {
            if (c !== undefined && c !== null) writeChunk(c);
          } catch (e) {
            reject(e);
          }
        });
        stream.once("end", resolve);
        stream.once("error", reject);
      });
    }
    if (pendingFetches.has(id)) {
      hostCall("http.writeFetchBody", JSON.stringify({ id, eof: true }), new Uint8Array(0));
    }
  }

  function extractBodyBytes(body, headers) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") {
      if (headers && !headers.has("content-type")) {
        headers.set("content-type", "text/plain;charset=UTF-8");
      }
      return utf8Encode(body);
    }
    if (body instanceof URLSearchParams) {
      if (headers && !headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      }
      return utf8Encode(body.toString());
    }
    if (body instanceof FormData) {
      const { bytes, contentType } = serializeFormData(body);
      if (headers && !headers.has("content-type")) {
        headers.set("content-type", contentType);
      }
      return bytes;
    }
    if (body instanceof Blob) {
      if (headers && body.type && !headers.has("content-type")) {
        headers.set("content-type", body.type);
      }
      return body._bytes;
    }
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (isBodyStreamLike(body)) return undefined;
    return utf8Encode(String(body));
  }

  function extractPemOption(v) {
    if (!v) return "";
    if (Array.isArray(v)) return v.map(extractPemOption).filter(Boolean).join("\n");
    if (Buffer.isBuffer(v)) return v.toString("utf8");
    if (v instanceof Uint8Array || ArrayBuffer.isView(v)) {
      return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
    }
    return String(v);
  }

  function classifyNetworkError(rawMsg, defaultCode = "ECONNRESET") {
    const msg = String(rawMsg || "Network error");
    const lower = msg.toLowerCase();
    const err = new Error(msg);
    if (lower.includes("certificate has expired") || (lower.includes("certificate") && lower.includes("expired"))) {
      err.code = "CERT_HAS_EXPIRED";
    } else if (lower.includes("self-signed") || lower.includes("self signed") || lower.includes("unknown authority")) {
      err.code = "DEPTH_ZERO_SELF_SIGNED_CERT";
    } else if (lower.includes("tls:") || lower.includes("x509:") || lower.includes("certificate")) {
      err.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    } else if (lower.includes("refused") || lower.includes("connectex")) {
      err.code = "ECONNREFUSED";
      err.errno = -111;
      err.syscall = "connect";
    } else if (lower.includes("no such host") || lower.includes("lookup")) {
      err.code = "ENOTFOUND";
      err.errno = -3008;
      err.syscall = "getaddrinfo";
    } else if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline exceeded")) {
      err.code = "ETIMEDOUT";
      err.errno = -110;
      err.syscall = "connect";
    } else if (lower.includes("permission") || lower.includes("access is denied")) {
      err.code = "EACCES";
      err.errno = -13;
      err.syscall = "connect";
    } else if (lower.includes("reset") || lower.includes("broken pipe") || lower.includes("forcibly closed")) {
      err.code = "ECONNRESET";
      err.errno = -104;
    } else {
      err.code = defaultCode;
    }
    return err;
  }

  function parseBodyAsFormData(bytes, contentType) {
    const ct = String(contentType || "");
    const lower = ct.toLowerCase();
    const fd = new FormData();
    if (lower.includes("application/x-www-form-urlencoded")) {
      const sp = new URLSearchParams(utf8Decode(bytes));
      for (const [k, v] of sp.entries()) fd.append(k, v);
      return fd;
    }
    if (lower.includes("multipart/form-data")) {
      const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
      if (!m) throw new TypeError("Multipart: Boundary not found");
      const boundary = m[1] || m[2];
      const rawText = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
      const delim = `--${boundary}`;
      const segments = rawText.split(delim);
      for (let i = 1; i < segments.length; i++) {
        let seg = segments[i];
        if (seg.startsWith("--")) break;
        if (seg.startsWith("\r\n")) seg = seg.slice(2);
        else if (seg.startsWith("\n")) seg = seg.slice(1);
        if (seg.endsWith("\r\n")) seg = seg.slice(0, -2);
        else if (seg.endsWith("\n")) seg = seg.slice(0, -1);
        const hdrEnd = seg.indexOf("\r\n\r\n");
        const altEnd = hdrEnd < 0 ? seg.indexOf("\n\n") : -1;
        const splitPos = hdrEnd >= 0 ? hdrEnd : altEnd;
        if (splitPos < 0) continue;
        const hdrBlock = seg.slice(0, splitPos);
        const bodyLatin1 = seg.slice(splitPos + (hdrEnd >= 0 ? 4 : 2));
        const nameMatch = /name="([^"]*)"/i.exec(hdrBlock);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1].replace(/%22/g, "\"");
        const fileMatch = /filename="([^"]*)"/i.exec(hdrBlock);
        const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(hdrBlock);
        const bodyBuf = Buffer.from(bodyLatin1, "latin1");
        if (fileMatch) {
          const fileName = fileMatch[1].replace(/%22/g, "\"");
          const mime = typeMatch ? typeMatch[1].trim() : "application/octet-stream";
          fd.append(fieldName, new File([bodyBuf], fileName, { type: mime }));
        } else {
          fd.append(fieldName, bodyBuf.toString("utf8"));
        }
      }
      return fd;
    }
    throw new TypeError("Could not parse content as FormData.");
  }

  class Request {
    constructor(input, options = {}) {
      options = options || {};
      const sig = options.signal !== undefined ? options.signal : (input instanceof Request ? input.signal : null);
      if (sig !== null && sig !== undefined) {
        if (typeof sig !== "object" || typeof sig.aborted !== "boolean" || typeof sig.addEventListener !== "function") {
          const err = new TypeError("Failed to construct 'Request': member signal is not of type AbortSignal.");
          err.code = "ERR_INVALID_ARG_TYPE";
          throw err;
        }
      }
      const agentOpts = (options.agent && options.agent.options) || {};
      this._insecureSkipVerify = Boolean(
        options.rejectUnauthorized === false ||
        options.insecureSkipVerify === true ||
        agentOpts.rejectUnauthorized === false ||
        (input instanceof Request && input._insecureSkipVerify)
      );
      this._ca = extractPemOption(options.ca || agentOpts.ca || (input instanceof Request ? input._ca : ""));
      this._cert = extractPemOption(options.cert || agentOpts.cert || (input instanceof Request ? input._cert : ""));
      this._key = extractPemOption(options.key || agentOpts.key || (input instanceof Request ? input._key : ""));
      if (input instanceof Request) {
        if (input.bodyUsed && options.body === undefined) {
          throw new TypeError("Body is unusable: Body has already been read");
        }
        this.url = input.url;
        this.method = String(options.method || input.method || "GET").toUpperCase();
        this.headers = new Headers(options.headers || input.headers);
        this._bodyStream = options.body !== undefined ? (isBodyStreamLike(options.body) ? options.body : null) : input._bodyStream;
        this._body = options.body !== undefined ? extractBodyBytes(options.body, this.headers) : input._body;
        if (options.body === undefined && (input._bodyStream !== null || (input._body !== undefined && input._body !== null))) {
          input.bodyUsed = true;
        }
        this.signal = sig || new AbortController().signal;
        this.redirect = options.redirect || input.redirect || "follow";
        this.mode = options.mode || input.mode || "cors";
        this.credentials = options.credentials || input.credentials || "same-origin";
        this.cache = options.cache || input.cache || "default";
        this.duplex = options.duplex || input.duplex || "half";
        this.keepalive = Boolean(options.keepalive !== undefined ? options.keepalive : input.keepalive);
        this.referrer = options.referrer !== undefined ? String(options.referrer) : input.referrer;
        this.referrerPolicy = options.referrerPolicy !== undefined ? String(options.referrerPolicy) : input.referrerPolicy;
        this.integrity = options.integrity !== undefined ? String(options.integrity) : input.integrity;
        this.destination = "";
      } else {
        this.url = new URL(String(input)).href;
        this.method = String(options.method || "GET").toUpperCase();
        this.headers = new Headers(options.headers);
        this._bodyStream = isBodyStreamLike(options.body) ? options.body : null;
        this._body = extractBodyBytes(options.body, this.headers);
        this.signal = sig || new AbortController().signal;
        this.redirect = options.redirect || "follow";
        this.mode = options.mode || "cors";
        this.credentials = options.credentials || "same-origin";
        this.cache = options.cache || "default";
        this.duplex = options.duplex || "half";
        this.keepalive = Boolean(options.keepalive);
        this.referrer = options.referrer !== undefined ? String(options.referrer) : "about:client";
        this.referrerPolicy = options.referrerPolicy !== undefined ? String(options.referrerPolicy) : "";
        this.integrity = options.integrity !== undefined ? String(options.integrity) : "";
        this.destination = "";
      }
      if ((this.method === "GET" || this.method === "HEAD") && (this._body !== undefined || this._bodyStream !== null)) {
        throw new TypeError("Request with GET/HEAD method cannot have body.");
      }
      if (this._bodyStream !== null) {
        if (this._bodyStream instanceof ReadableStream) {
          this.body = this._bodyStream;
        } else {
          const streamRef = this._bodyStream;
          this.body = new ReadableStream({
            start: async (ctrl) => {
              const b = await consumeStreamLikeToBytes(streamRef);
              if (b && b.byteLength > 0) ctrl.enqueue(b);
              ctrl.close();
            },
            _onConsume: () => {
              this.bodyUsed = true;
            },
          });
        }
      } else if (this._body !== undefined && this._body !== null) {
        const reqBytes = this._body;
        this.body = new ReadableStream({
          start(ctrl) {
            if (reqBytes.byteLength > 0) ctrl.enqueue(reqBytes);
            ctrl.close();
          },
          _onConsume: () => {
            this.bodyUsed = true;
          },
        });
      } else {
        this.body = null;
      }
      this.bodyUsed = false;
    }
    _markBodyUsed() {
      if (this.bodyUsed) {
        throw new TypeError("Body is unusable: Body has already been read");
      }
      this.bodyUsed = true;
    }
    async _resolveBodyBytes() {
      if (this._bodyStream) {
        const s = this._bodyStream;
        this._bodyStream = null;
        this._body = await consumeStreamLikeToBytes(s);
      }
      return this._body;
    }
    async text() {
      this._markBodyUsed();
      const b = await this._resolveBodyBytes();
      const s = b ? utf8Decode(b) : "";
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }
    async json() {
      return JSON.parse(await this.text());
    }
    async arrayBuffer() {
      this._markBodyUsed();
      const b = await this._resolveBodyBytes();
      if (!b) return new ArrayBuffer(0);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    async bytes() {
      this._markBodyUsed();
      const b = await this._resolveBodyBytes();
      return b ? new Uint8Array(b) : new Uint8Array(0);
    }
    async blob() {
      return new Blob([await this.bytes()], { type: this.headers.get("content-type") || "" });
    }
    async formData() {
      const b = await this.bytes();
      return parseBodyAsFormData(b, this.headers.get("content-type") || "");
    }
    clone() {
      if (this.bodyUsed) throw new TypeError("Cannot clone a Request whose body has already been used");
      const cloned = new Request(this.url, {
        method: this.method,
        headers: this.headers,
        body: this._body ? new Uint8Array(this._body) : undefined,
        redirect: this.redirect,
        mode: this.mode,
        credentials: this.credentials,
        cache: this.cache,
        duplex: this.duplex,
        keepalive: this.keepalive,
        referrer: this.referrer,
        referrerPolicy: this.referrerPolicy,
        integrity: this.integrity,
        signal: this.signal,
      });
      if (this._bodyStream instanceof ReadableStream) {
        const [b1, b2] = this._bodyStream.tee();
        this._bodyStream = b1;
        this.body = b1;
        cloned._bodyStream = b2;
        cloned.body = b2;
      }
      return cloned;
    }
  }

  class Response {
    constructor(body = null, options = {}) {
      options = options || {};
      const fromFetch = Boolean(options._fromFetch);
      const rawStatus = options.status !== undefined ? Number(options.status) : 200;
      if (!fromFetch) {
        if (!Number.isInteger(rawStatus) || rawStatus < 200 || rawStatus > 599) {
          throw new RangeError(`The status provided (${options.status}) is outside the range [200, 599].`);
        }
      }
      const isWebStreamBody = body instanceof ReadableStream;
      const isOtherStreamBody = !isWebStreamBody && isBodyStreamLike(body);
      const isStreamBody = isWebStreamBody || isOtherStreamBody;
      const hasBody = body !== null && body !== undefined;
      if (!fromFetch && hasBody && (rawStatus === 101 || rawStatus === 204 || rawStatus === 205 || rawStatus === 304)) {
        throw new TypeError(`Response constructor: Invalid response status code ${rawStatus} for a body.`);
      }
      this._rawHeaders = Array.isArray(options._rawHeaders)
        ? options._rawHeaders.slice()
        : (Array.isArray(options.headers) ? options.headers.slice() : null);
      this.headers = new Headers(options.headers);
      this._streaming = Boolean(options._streaming || isStreamBody);
      this._body = (this._streaming || !hasBody) ? null : (extractBodyBytes(body, this.headers) || new Uint8Array(0));
      this.status = rawStatus;
      this.statusText = options.statusText !== undefined ? String(options.statusText) : "";
      this.ok = this.status >= 200 && this.status < 300;
      this.url = options.url || "";
      this.redirected = Boolean(options.redirected);
      this.type = fromFetch ? "basic" : "default";
      this.bodyUsed = false;
      this._streamCtrl = null;
      if (isWebStreamBody) {
        this.body = body;
      } else if (isOtherStreamBody) {
        const streamRef = body;
        this.body = new ReadableStream({
          start: async (ctrl) => {
            const b = await consumeStreamLikeToBytes(streamRef);
            if (b && b.byteLength > 0) ctrl.enqueue(b);
            ctrl.close();
          },
          _onConsume: () => {
            this.bodyUsed = true;
          },
        });
      } else if (this._streaming) {
        this.body = new ReadableStream({
          start: (ctrl) => {
            this._streamCtrl = ctrl;
          },
          pull: () => {
            this.bodyUsed = true;
          },
          cancel: () => {
            if (typeof options._onCancel === "function") options._onCancel();
          },
          _onConsume: () => {
            this.bodyUsed = true;
            if (typeof options._onPull === "function") options._onPull();
          },
          _onWaitStart: options._onWaitStart || null,
          _onWaitEnd: options._onWaitEnd || null,
        });
      } else if (!hasBody) {
        this.body = null;
      } else {
        const bytes = this._body;
        this.body = new ReadableStream({
          start(ctrl) {
            if (bytes.byteLength > 0) ctrl.enqueue(bytes);
            ctrl.close();
          },
          _onConsume: () => {
            this.bodyUsed = true;
          },
        });
      }
    }
    async _consumeBytes() {
      if (this.bodyUsed) {
        throw new TypeError("Body is unusable: Body has already been read");
      }
      if (!this.body) {
        if (this._streaming && this._onCancel) {
          this._onCancel();
        }
        return new Uint8Array(0);
      }
      this.bodyUsed = true;
      if (this._streaming) {
        const chunks = [];
        const reader = this.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) chunks.push(value);
        }
        this._body = chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks);
        this._streaming = false;
      }
      return this._body || new Uint8Array(0);
    }
    async text() {
      const s = utf8Decode(await this._consumeBytes());
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }
    async json() {
      return JSON.parse(await this.text());
    }
    async arrayBuffer() {
      const b = await this._consumeBytes();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    async bytes() {
      return new Uint8Array(await this._consumeBytes());
    }
    async blob() {
      return new Blob([await this.bytes()], { type: this.headers.get("content-type") || "" });
    }
    async formData() {
      const b = await this.bytes();
      return parseBodyAsFormData(b, this.headers.get("content-type") || "");
    }
    clone() {
      if (this.bodyUsed) throw new TypeError("Cannot clone a Response whose body has already been used");
      if (this._streaming && this.body && typeof this.body.tee === "function") {
        const [b1, b2] = this.body.tee();
        this.body = b1;
        const cloned = new Response(null, {
          status: this.status,
          statusText: this.statusText,
          headers: this.headers,
          url: this.url,
          redirected: this.redirected,
          _streaming: true,
          _fromFetch: true,
        });
        cloned.body = b2;
        return cloned;
      }
      return new Response(this._body ? new Uint8Array(this._body) : null, {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
        url: this.url,
        redirected: this.redirected,
        _fromFetch: true,
      });
    }
    static json(data, initOpts = {}) {
      const headers = new Headers(initOpts.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new Response(JSON.stringify(data), Object.assign({}, initOpts, { headers }));
    }
    static redirect(url, status = 302) {
      if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) {
        throw new RangeError(`Response.redirect: Invalid redirect status code ${status}`);
      }
      return new Response(null, { status, headers: { location: String(url) } });
    }
    static error() {
      const r = new Response(null, { status: 0, statusText: "", _fromFetch: true });
      r.type = "error";
      r.ok = false;
      return r;
    }
  }

  function fetch(input, options) {
    return new Promise((resolve, reject) => {
      let reqObj;
      try {
        reqObj = new Request(input, options);
      } catch (e) {
        return reject(e);
      }
      if (reqObj.signal && reqObj.signal.aborted) {
        return reject(reqObj.signal.reason !== undefined ? reqObj.signal.reason : new DOMException("This operation was aborted", "AbortError"));
      }
      const id = nextAsyncId++;
      let onAbort = null;
      const cleanupSignal = () => {
        if (onAbort && reqObj.signal) {
          reqObj.signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };
      incRef();
      const entry = {
        resolve,
        reject,
        cleanup: cleanupSignal,
        resp: null,
        method: reqObj.method,
        rawHttp: false,
        headersResolved: false,
        headerRefed: true,
        releaseHeaderRef() {
          if (this.headerRefed) {
            this.headerRefed = false;
            decRef();
          }
        },
        cancelFetch: () => {
          if (pendingFetches.has(id)) {
            const e = pendingFetches.get(id);
            pendingFetches.delete(id);
            cleanupSignal();
            if (e) e.releaseHeaderRef();
            try {
              hostCall("http.abortFetch", String(id));
            } catch (_) {}
          }
        },
      };
      pendingFetches.set(id, entry);
      if (reqObj.signal) {
        onAbort = () => {
          const abortErr = reqObj.signal.reason !== undefined ? reqObj.signal.reason : new DOMException("This operation was aborted", "AbortError");
          if (pendingFetches.has(id)) {
            pendingFetches.delete(id);
            cleanupSignal();
            entry.releaseHeaderRef();
            try {
              hostCall("http.abortFetch", String(id));
            } catch (_) {}
            if (!entry.headersResolved) {
              reject(abortErr);
            } else if (entry.resp && entry.resp._streamCtrl) {
              entry.resp._streamCtrl.error(abortErr);
            }
          }
        };
        reqObj.signal.addEventListener("abort", onAbort, { once: true });
      }
      const hdrs = [];
      for (const [k, v] of reqObj.headers.entries()) hdrs.push([k, v]);
      if (reqObj._bodyStream !== null) {
        const bodyStream = reqObj._bodyStream;
        reqObj._bodyStream = null;
        reqObj.bodyUsed = true;
        try {
          hostCall(
            "http.fetchAsync",
            JSON.stringify({
              id,
              url: reqObj.url,
              method: reqObj.method,
              headers: hdrs,
              redirect: reqObj.redirect,
              streamBody: true,
              insecureSkipVerify: Boolean(reqObj._insecureSkipVerify),
              ca: reqObj._ca || "",
              cert: reqObj._cert || "",
              key: reqObj._key || "",
            }),
            undefined
          );
          pumpStreamLikeToFetch(id, bodyStream).catch((err) => {
            if (pendingFetches.has(id)) {
              pendingFetches.delete(id);
              cleanupSignal();
              entry.releaseHeaderRef();
              try {
                hostCall("http.abortFetch", String(id));
              } catch (_) {}
              if (entry.headersResolved && entry.resp && entry.resp._streamCtrl) {
                entry.resp._streamCtrl.error(err);
              } else {
                reject(err);
              }
            }
          });
        } catch (err) {
          if (pendingFetches.has(id)) {
            pendingFetches.delete(id);
            cleanupSignal();
            entry.releaseHeaderRef();
          }
          reject(err);
        }
        return;
      }
      if (reqObj._body !== undefined && reqObj._body !== null) {
        reqObj.bodyUsed = true;
      }
      Promise.resolve()
        .then(() => reqObj._resolveBodyBytes())
        .then((bodyBytes) => {
          if (!pendingFetches.has(id)) return;
          hostCall(
            "http.fetchAsync",
            JSON.stringify({
              id,
              url: reqObj.url,
              method: reqObj.method,
              headers: hdrs,
              redirect: reqObj.redirect,
              insecureSkipVerify: Boolean(reqObj._insecureSkipVerify),
              ca: reqObj._ca || "",
              cert: reqObj._cert || "",
              key: reqObj._key || "",
            }),
            bodyBytes
          );
        })
        .catch((err) => {
          if (pendingFetches.has(id)) {
            pendingFetches.delete(id);
            cleanupSignal();
            entry.releaseHeaderRef();
          }
          reject(err);
        });
    });
  }

  class WebSocket extends EventTarget {
    constructor(url, protocols = []) {
      super();
      const parsed = new URL(String(url));
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new SyntaxError(`The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol}' is not allowed.`);
      }
      this.url = parsed.href;
      this.readyState = 0; // CONNECTING
      this.protocol = "";
      this.extensions = "";
      this.bufferedAmount = 0;
      this.binaryType = "blob";
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._protocols = typeof protocols === "string" ? [protocols] : Array.isArray(protocols) ? protocols.map(String) : [];
      this._sock = null;
      this._upgraded = false;
      this._rxBuf = Buffer.alloc(0);
      this._fragChunks = [];
      this._fragOpcode = 0;
      queueMicrotask(() => this._connect(parsed));
    }
    _connect(parsed) {
      if (this.readyState !== 0) return;
      const isSecure = parsed.protocol === "wss:" || parsed.protocol === "https:";
      const port = parsed.port ? Number(parsed.port) : (isSecure ? 443 : 80);
      const host = parsed.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1";
      const key = randomBytes(16).toString("base64");
      const sock = isSecure ? new TLSSocket(null, { servername: host }) : new NetSocket();
      this._sock = sock;
      sock.on("error", (err) => {
        const ev = new Event("error");
        ev.error = err;
        this.dispatchEvent(ev);
        if (typeof this.onerror === "function") this.onerror(ev);
        this._handleClose(1006, "", false);
      });
      sock.on("close", () => {
        this._handleClose(1006, "", false);
      });
      sock.on("data", (chunk) => {
        this._rxBuf = Buffer.concat([this._rxBuf, Buffer.from(chunk)]);
        if (!this._upgraded) {
          const idx = this._rxBuf.indexOf("\r\n\r\n");
          if (idx < 0) return;
          const headStr = this._rxBuf.subarray(0, idx).toString("latin1");
          this._rxBuf = this._rxBuf.subarray(idx + 4);
          if (!/^HTTP\/1\.[01]\s+101\b/i.test(headStr)) {
            sock.destroy(new Error("WebSocket handshake failed"));
            return;
          }
          const protoMatch = /sec-websocket-protocol:\s*([^\r\n]+)/i.exec(headStr);
          if (protoMatch) this.protocol = protoMatch[1].trim();
          this._upgraded = true;
          this.readyState = 1; // OPEN
          const openEv = new Event("open");
          this.dispatchEvent(openEv);
          if (typeof this.onopen === "function") this.onopen(openEv);
        }
        this._drainFrames();
      });
      sock.connect(port, host, () => {
        const path = (parsed.pathname || "/") + (parsed.search || "");
        let req = `GET ${path} HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
        if (this._protocols.length > 0) {
          req += `Sec-WebSocket-Protocol: ${this._protocols.join(", ")}\r\n`;
        }
        req += "\r\n";
        sock.write(req);
      });
    }
    _drainFrames() {
      while (this._rxBuf.length >= 2) {
        const b0 = this._rxBuf[0];
        const b1 = this._rxBuf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (this._rxBuf.length < 4) return;
          payloadLen = (this._rxBuf[2] << 8) | this._rxBuf[3];
          offset = 4;
        } else if (payloadLen === 127) {
          if (this._rxBuf.length < 10) return;
          payloadLen = Number(this._rxBuf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (this._rxBuf.length < offset + maskLen + payloadLen) return;
        const payload = Buffer.from(this._rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen));
        if (masked) {
          const mask = this._rxBuf.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        this._rxBuf = this._rxBuf.subarray(offset + maskLen + payloadLen);
        if (opcode === 0x8) {
          let code = 1005;
          let reason = "";
          if (payload.length >= 2) {
            code = (payload[0] << 8) | payload[1];
            reason = payload.subarray(2).toString("utf8");
          }
          this._handleClose(code, reason, true);
          if (this._sock) this._sock.end();
          return;
        }
        if (opcode === 0x9) {
          this._sendFrame(0xA, payload);
          continue;
        }
        if (opcode === 0xA) {
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) {
            this._fragOpcode = opcode;
            this._fragChunks = [payload];
            continue;
          }
          this._emitMessageFrame(opcode, payload);
        } else if (opcode === 0x0 && this._fragOpcode !== 0) {
          this._fragChunks.push(payload);
          if (fin) {
            const fullPayload = Buffer.concat(this._fragChunks);
            const finalOpcode = this._fragOpcode;
            this._fragChunks = [];
            this._fragOpcode = 0;
            this._emitMessageFrame(finalOpcode, fullPayload);
          }
        }
      }
    }
    _emitMessageFrame(opcode, payload) {
      const data = opcode === 0x1
        ? payload.toString("utf8")
        : (this.binaryType === "arraybuffer"
            ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
            : new Blob([payload]));
      const ev = new Event("message");
      ev.data = data;
      this.dispatchEvent(ev);
      if (typeof this.onmessage === "function") this.onmessage(ev);
    }
    _sendFrame(opcode, payloadBytes) {
      if (!this._sock || this._sock.destroyed) return;
      const mask = randomBytes(4);
      const len = payloadBytes.byteLength;
      let header;
      if (len < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | len;
        mask.copy(header, 2);
      } else if (len < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header[2] = (len >>> 8) & 0xff;
        header[3] = len & 0xff;
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payloadBytes[i] ^ mask[i & 3];
      this._sock.write(Buffer.concat([header, masked]));
    }
    send(data) {
      if (this.readyState === 0) {
        throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
      }
      if (this.readyState !== 1) return;
      if (typeof data === "string") {
        this._sendFrame(0x1, Buffer.from(data, "utf8"));
      } else if (data instanceof Blob) {
        this._sendFrame(0x2, data._bytes);
      } else {
        this._sendFrame(0x2, toBytesInput(data));
      }
    }
    close(code = 1000, reason = "") {
      if (this.readyState === 2 || this.readyState === 3) return;
      this.readyState = 2; // CLOSING
      const reasonBytes = Buffer.from(String(reason), "utf8");
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload[0] = (code >>> 8) & 0xff;
      payload[1] = code & 0xff;
      reasonBytes.copy(payload, 2);
      this._sendFrame(0x8, payload);
      if (this._sock) this._sock.end();
      this._handleClose(code, String(reason), true);
    }
    _handleClose(code, reason, wasClean) {
      if (this.readyState === 3) return;
      this.readyState = 3; // CLOSED
      const ev = new Event("close");
      ev.code = code;
      ev.reason = reason;
      ev.wasClean = Boolean(wasClean);
      this.dispatchEvent(ev);
      if (typeof this.onclose === "function") this.onclose(ev);
    }
  }
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;

  globalThis.Headers = Headers;
  globalThis.FormData = FormData;
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis.fetch = fetch;
  globalThis.WebSocket = WebSocket;

  // Node http / https module
  function createHTTPSocket(meta, ownerDestroy) {
    const remoteAddress = (meta && meta.remoteAddress) || "127.0.0.1";
    const remotePort = (meta && meta.remotePort) || 0;
    const remoteFamily = (meta && meta.remoteFamily) || (remoteAddress.includes(":") ? "IPv6" : "IPv4");
    const localAddress = (meta && meta.localAddress) || (remoteAddress.includes(":") ? "::1" : "127.0.0.1");
    const localPort = (meta && meta.localPort) || 0;
    const sock = new NetSocket({
      remoteAddress,
      remotePort,
      localAddress,
      localPort,
    });
    sock.remoteFamily = remoteFamily;
    const origDestroy = sock.destroy.bind(sock);
    sock.destroy = function (err) {
      if (sock.destroyed) return sock;
      origDestroy(err);
      if (typeof ownerDestroy === "function") {
        ownerDestroy(err);
      }
      return sock;
    };
    return sock;
  }

  class IncomingMessage extends Readable {
    constructor(meta, bodyBytes, streaming = false) {
      super({ highWaterMark: 65536 });
      this.statusCode = meta.status || 200;
      this.statusMessage = meta.statusText || "OK";
      this.headers = Object.create(null);
      this.rawHeaders = [];
      const addHdr = (rawK, rawV) => {
        const k = String(rawK).toLowerCase();
        if (Array.isArray(rawV)) {
          for (const item of rawV) addHdr(rawK, item);
          return;
        }
        const v = String(rawV);
        this.rawHeaders.push(String(rawK), v);
        if (k === "set-cookie") {
          if (!this.headers[k]) this.headers[k] = [];
          this.headers[k].push(v);
        } else if (k === "cookie" && this.headers[k] !== undefined) {
          this.headers[k] = `${this.headers[k]}; ${v}`;
        } else if (this.headers[k] !== undefined) {
          this.headers[k] = `${this.headers[k]}, ${v}`;
        } else {
          this.headers[k] = v;
        }
      };
      if (Array.isArray(meta.rawHeaders) && meta.rawHeaders.length > 0) {
        if (Array.isArray(meta.rawHeaders[0])) {
          for (const [k, v] of meta.rawHeaders) addHdr(k, v);
        } else {
          for (let i = 0; i + 1 < meta.rawHeaders.length; i += 2) {
            addHdr(meta.rawHeaders[i], meta.rawHeaders[i + 1]);
          }
        }
      } else if (Array.isArray(meta.headers)) {
        for (const [k, v] of meta.headers) addHdr(k, v);
      } else if (meta.headers && typeof meta.headers === "object") {
        for (const [k, v] of Object.entries(meta.headers)) addHdr(k, v);
      }
      this.method = meta.method || "GET";
      this.url = meta.url || "/";
      this.httpVersion = meta.httpVersion || "1.1";
      this.httpVersionMajor = meta.httpVersionMajor !== undefined ? meta.httpVersionMajor : 1;
      this.httpVersionMinor = meta.httpVersionMinor !== undefined ? meta.httpVersionMinor : 1;
      this.trailers = Object.create(null);
      this.rawTrailers = [];
      this.complete = !streaming;
      this._serverRes = null;
      this._clientReq = null;
      this.socket = meta._socket || createHTTPSocket(meta, (err) => {
        if (!this.destroyed) this.destroy(err);
      });
      this.connection = this.socket;
      this.once("end", () => {
        this.complete = true;
      });
      if (streaming) {
        if (bodyBytes && bodyBytes.byteLength > 0) {
          this.push(new Buffer(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength));
        }
      } else {
        if (bodyBytes && bodyBytes.byteLength > 0) {
          this.push(new Buffer(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength));
        }
        this.push(null);
      }
    }
    push(chunk, encoding) {
      if (chunk === null) this.complete = true;
      return super.push(chunk, encoding);
    }
    destroy(err) {
      if (this.destroyed) return this;
      if (typeof this._onPull === "function") {
        try { this._onPull(0); } catch (_) {}
      }
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroyed = true;
      }
      if (this._serverRes && !this._serverRes._respondedDone) {
        this._serverRes.destroy(err);
      }
      if (this._clientReq && !this._destroyedFromReq) {
        this._clientReq._destroyFromIm(err);
      }
      return super.destroy(err);
    }
  }

  class ClientRequest extends Writable {
    constructor(urlStr, options, cb) {
      super({ highWaterMark: 65536 });
      this._url = urlStr;
      this._method = (options && options.method) || "GET";
      this._headerMap = Object.create(null);
      this._headerNames = Object.create(null);
      if (options && options.headers) {
        if (options.headers instanceof Headers) {
          for (const [k, v] of options.headers.entries()) this.setHeader(k, v);
        } else if (Array.isArray(options.headers)) {
          for (const [k, v] of options.headers) this.setHeader(k, v);
        } else if (typeof options.headers === "object") {
          for (const [k, v] of Object.entries(options.headers)) {
            if (v !== undefined) this.setHeader(k, v);
          }
        }
      }
      if (options && options.auth && !this.hasHeader("authorization")) {
        this.setHeader("Authorization", "Basic " + Buffer.from(String(options.auth)).toString("base64"));
      }
      this._redirect = (options && options.redirect) || "manual";
      const agentOpts = (options && options.agent && options.agent.options) || {};
      this._insecureSkipVerify = Boolean(
        (options && options.rejectUnauthorized === false) ||
        agentOpts.rejectUnauthorized === false
      );
      this._ca = extractPemOption((options && options.ca) || agentOpts.ca);
      this._cert = extractPemOption((options && options.cert) || agentOpts.cert);
      this._key = extractPemOption((options && options.key) || agentOpts.key);
      this._chunks = [];
      this._chunksBytes = 0;
      this._pendingWriteCb = null;
      this._aborted = false;
      this._ending = false;
      this._fetchStarted = false;
      this._fetchId = 0;
      this._isDuplex = true;
      this._responseReceived = false;
      this.aborted = false;
      this.headersSent = false;
      this._ac = new AbortController();
      this._timeoutTimer = null;
      this._timeoutMs = options && options.timeout > 0 ? Number(options.timeout) : 0;
      let initHost = "127.0.0.1";
      let initPort = 80;
      try {
        const parsedU = new URL(urlStr);
        const hn = parsedU.hostname.startsWith("[") && parsedU.hostname.endsWith("]")
          ? parsedU.hostname.slice(1, -1)
          : parsedU.hostname;
        if (hn && hn !== "localhost") initHost = hn;
        initPort = parsedU.port ? Number(parsedU.port) : (parsedU.protocol === "https:" ? 443 : 80);
      } catch (_) {}
      this.socket = createHTTPSocket(
        { remoteAddress: initHost, remotePort: initPort },
        (err) => {
          if (!this.destroyed) this.destroy(err);
        }
      );
      this.connection = this.socket;
      processObj.nextTick(() => {
        if (!this.destroyed) this.emit("socket", this.socket);
      });
      if (typeof cb === "function") this.once("response", cb);
      if (this._timeoutMs > 0) this.setTimeout(this._timeoutMs);
      if (options && options.signal) {
        const sig = options.signal;
        const makeAbortErr = () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          err.code = "ABORT_ERR";
          if (sig.reason !== undefined) err.cause = sig.reason;
          return err;
        };
        if (sig.aborted) {
          processObj.nextTick(() => this.destroy(makeAbortErr()));
        } else if (typeof sig.addEventListener === "function") {
          const onAbort = () => {
            this.destroy(makeAbortErr());
          };
          sig.addEventListener("abort", onAbort, { once: true });
          this.once("close", () => {
            if (typeof sig.removeEventListener === "function") sig.removeEventListener("abort", onAbort);
          });
        }
      }
    }
    setTimeout(ms, cb) {
      if (typeof cb === "function") this.once("timeout", cb);
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = null;
      }
      this._timeoutMs = Number(ms) || 0;
      if (this._timeoutMs > 0 && !this._aborted && !this.destroyed) {
        this._timeoutTimer = setTimeout(() => {
          this._timeoutTimer = null;
          this.emit("timeout");
        }, this._timeoutMs);
        if (!this._responseReceived) {
          this._timeoutTimer.unref();
        }
      }
      return this;
    }
    _clearTimeout() {
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = null;
      }
    }
    setHeader(name, value) {
      if (this.headersSent || this.writableEnded) {
        throw makeNodeError("ERR_HTTP_HEADERS_SENT", "Cannot set headers after they are sent to the client", Error);
      }
      validateHeaderName(name);
      validateHeaderValue(name, value);
      const lower = String(name).toLowerCase();
      this._headerNames[lower] = String(name);
      this._headerMap[lower] = Array.isArray(value) ? value.map(String) : String(value);
      return this;
    }
    getHeader(name) {
      validateHeaderName(name);
      return this._headerMap[String(name).toLowerCase()];
    }
    getHeaders() {
      return Object.assign(Object.create(null), this._headerMap);
    }
    getHeaderNames() {
      return Object.keys(this._headerMap);
    }
    getRawHeaderNames() {
      return Object.values(this._headerNames);
    }
    hasHeader(name) {
      validateHeaderName(name);
      return String(name).toLowerCase() in this._headerMap;
    }
    removeHeader(name) {
      if (this.headersSent || this.writableEnded) {
        throw makeNodeError("ERR_HTTP_HEADERS_SENT", "Cannot remove headers after they are sent to the client", Error);
      }
      validateHeaderName(name);
      const lower = String(name).toLowerCase();
      delete this._headerMap[lower];
      delete this._headerNames[lower];
    }
    _buildWireHeaderPairs() {
      const hdrs = [];
      for (const lower of Object.keys(this._headerMap)) {
        const origName = this._headerNames[lower] || lower;
        const val = this._headerMap[lower];
        if (Array.isArray(val)) {
          for (const item of val) hdrs.push([origName, String(item)]);
        } else {
          hdrs.push([origName, String(val)]);
        }
      }
      return hdrs;
    }
    _startRequest(streamBody, bodyBytes) {
      if (this._fetchStarted || this._aborted) return;
      this._fetchStarted = true;
      this.headersSent = true;
      const id = nextAsyncId++;
      this._fetchId = id;
      let onAbort = null;
      const sig = this._ac.signal;
      const cleanupSignal = () => {
        if (onAbort && sig) {
          sig.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };
      incRef();
      const entry = {
        resolve: (res) => this._handleFetchResponse(res),
        reject: (err) => this._handleFetchError(err),
        onWriteDrain: () => {
          this._backpressured = false;
          if (this._pendingWriteCb) {
            const wcb = this._pendingWriteCb;
            this._pendingWriteCb = null;
            wcb();
          } else if (this._needDrain && !this.destroyed && !this.writableEnded) {
            this._needDrain = false;
            this.emit("drain");
          }
        },
        cleanup: cleanupSignal,
        resp: null,
        method: this._method,
        rawHttp: true,
        headersResolved: false,
        headerRefed: true,
        releaseHeaderRef() {
          if (this.headerRefed) {
            this.headerRefed = false;
            decRef();
          }
        },
        cancelFetch: () => {
          if (pendingFetches.has(id)) {
            const e = pendingFetches.get(id);
            pendingFetches.delete(id);
            cleanupSignal();
            if (e) e.releaseHeaderRef();
            try {
              hostCall("http.abortFetch", String(id));
            } catch (_) {}
          }
        },
      };
      pendingFetches.set(id, entry);
      onAbort = () => {
        const abortErr = sig.reason !== undefined ? sig.reason : new DOMException("This operation was aborted", "AbortError");
        if (pendingFetches.has(id)) {
          pendingFetches.delete(id);
          cleanupSignal();
          entry.releaseHeaderRef();
          try {
            hostCall("http.abortFetch", String(id));
          } catch (_) {}
          if (!entry.headersResolved) {
            entry.reject(abortErr);
          } else if (entry.resp && entry.resp._streamCtrl) {
            entry.resp._streamCtrl.error(abortErr);
          }
        }
      };
      sig.addEventListener("abort", onAbort, { once: true });
      try {
        hostCall(
          "http.fetchAsync",
          JSON.stringify({
            id,
            url: this._url,
            method: this._method,
            headers: this._buildWireHeaderPairs(),
            redirect: this._redirect,
            rawHttp: true,
            streamBody: Boolean(streamBody),
            insecureSkipVerify: this._insecureSkipVerify,
            ca: this._ca || "",
            cert: this._cert || "",
            key: this._key || "",
          }),
          bodyBytes
        );
      } catch (err) {
        if (pendingFetches.has(id)) {
          pendingFetches.delete(id);
          cleanupSignal();
          entry.releaseHeaderRef();
        }
        this._handleFetchError(err);
      }
    }
    _handleFetchResponse(res) {
      if (this._aborted) return;
      this._responseReceived = true;
      if (this.socket) {
        if (res._remoteAddress) {
          this.socket.remoteAddress = res._remoteAddress;
          this.socket.remoteFamily = res._remoteFamily || (res._remoteAddress.includes(":") ? "IPv6" : "IPv4");
        }
        if (res._remotePort) this.socket.remotePort = res._remotePort;
        if (res._localAddress) this.socket.localAddress = res._localAddress;
        if (res._localPort) this.socket.localPort = res._localPort;
      }
      let hdrs;
      if (Array.isArray(res._rawHeaders)) {
        hdrs = res._rawHeaders;
      } else {
        hdrs = [];
        for (const [k, v] of res.headers.entries()) hdrs.push([k, v]);
      }
      const im = new IncomingMessage(
        {
          status: res.status,
          statusText: res.statusText,
          rawHeaders: hdrs,
          headers: hdrs,
          httpVersion: res._httpVersion || "1.1",
          httpVersionMajor: res._httpVersionMajor !== undefined ? res._httpVersionMajor : 1,
          httpVersionMinor: res._httpVersionMinor !== undefined ? res._httpVersionMinor : 1,
          _socket: this.socket,
        },
        null,
        true
      );
      im._clientReq = this;
      this._im = im;
      let pullResume = null;
      im._onPull = () => {
        if (pullResume) {
          const fn = pullResume;
          pullResume = null;
          fn();
        }
      };
      const emitReqClose = () => {
        if (!this._closeEmitted) {
          this._closeEmitted = true;
          this.emit("close");
        }
      };
      im.once("close", emitReqClose);
      im.once("end", () => {
        queueMicrotask(() => {
          if (!im._closeEmitted) {
            im._closeEmitted = true;
            im.emit("close");
          }
          emitReqClose();
        });
      });
      this.emit("response", im);
      (async () => {
        try {
          const reader = res.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (this._aborted || im.destroyed) {
              if (!im.destroyed && !im.complete) {
                im.aborted = true;
                im.emit("aborted");
                im.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET", _fromReqAbort: true }));
              }
              return;
            }
            if (done) break;
            if (value && value.byteLength > 0) {
              const canContinue = im.push(new Buffer(value.buffer, value.byteOffset, value.byteLength));
              if (!canContinue && !this._aborted && !im.destroyed) {
                await new Promise((resolve) => {
                  pullResume = resolve;
                });
              }
            }
          }
          this._clearTimeout();
          if (this._aborted || im.destroyed) {
            if (!im.destroyed && !im.complete) {
              im.aborted = true;
              im.emit("aborted");
              im.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET", _fromReqAbort: true }));
            }
            return;
          }
          if (res._trailers && typeof res._trailers === "object") {
            Object.assign(im.trailers, res._trailers);
          }
          if (Array.isArray(res._rawTrailers) && res._rawTrailers.length > 0) {
            im.rawTrailers.push(...res._rawTrailers);
          }
          if (!im.destroyed) im.push(null);
        } catch (err) {
          this._clearTimeout();
          if (!im.destroyed) {
            if (this._aborted) {
              im.aborted = true;
              im.emit("aborted");
              im.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET", _fromReqAbort: true }));
            } else {
              im.destroy(err);
            }
          }
        }
      })();
    }
    _handleFetchError(err) {
      this._clearTimeout();
      if (!this._aborted) {
        const rawMsg = err && err.cause ? err.cause.message || String(err.cause) : (err ? err.message || String(err) : "Request failed");
        const reqErr = classifyNetworkError(rawMsg);
        this.emit("error", reqErr);
        if (!this._closeEmitted) {
          this._closeEmitted = true;
          this.emit("close");
        }
      }
    }
    flushHeaders() {
      this.headersSent = true;
      if (!this._fetchStarted && !this._ending) {
        this._startRequest(true);
      }
    }
    end(chunk, encoding, cb) {
      this._ending = true;
      return super.end(chunk, encoding, cb);
    }
    _write(chunk, encoding, cb) {
      this.headersSent = true;
      const b = toBytesInput(chunk, encoding);
      this._chunksBytes = (this._chunksBytes || 0) + b.byteLength;
      if (this._fetchStarted || !this._ending) {
        if (!this._fetchStarted) {
          this._startRequest(true);
        }
        if (this._fetchId && !this._aborted) {
          try {
            const ok = hostCall("http.writeFetchBody", JSON.stringify({ id: this._fetchId, eof: false }), b);
            if (ok === "false") {
              this._backpressured = true;
              this._pendingWriteCb = cb;
              return;
            }
          } catch (err) {
            cb(err);
            return;
          }
        }
        cb();
        return;
      }
      this._chunks.push(b);
      cb();
    }
    _final(cb) {
      this.headersSent = true;
      cb();
      if (this._aborted) return;
      if (this._fetchStarted) {
        if (this._fetchId) {
          const tail = this._chunks.length > 0 ? Buffer.concat(this._chunks) : new Uint8Array(0);
          this._chunks.length = 0;
          try {
            hostCall("http.writeFetchBody", JSON.stringify({ id: this._fetchId, eof: true }), tail);
          } catch (_) {}
        }
        return;
      }
      const body = this._chunks.length > 0 ? Buffer.concat(this._chunks) : undefined;
      this._startRequest(false, body);
    }
    _destroyFromIm(_err) {
      this._clearTimeout();
      this._aborted = true;
      this._pendingWriteCb = null;
      this._ac.abort();
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroyed = true;
      }
    }
    abort() {
      if (this._aborted) return;
      this._clearTimeout();
      this._aborted = true;
      this.aborted = true;
      this._pendingWriteCb = null;
      this._ac.abort();
      this.emit("abort");
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroyed = true;
      }
      if (this._im && !this._im.destroyed && !this._im.complete) {
        this._im.aborted = true;
        this._im.emit("aborted");
        this._im.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET", _fromReqAbort: true }));
      }
      processObj.nextTick(() => {
        if (!this._closeEmitted) {
          this._closeEmitted = true;
          this.emit("close");
        }
      });
    }
    destroy(err) {
      if (this.destroyed) return this;
      this._clearTimeout();
      const wasAborted = this._aborted;
      this._aborted = true;
      this._pendingWriteCb = null;
      this._ac.abort();
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroyed = true;
      }
      if (this._im && !this._im.destroyed && !this._im.complete) {
        this._im.aborted = true;
        this._im._destroyedFromReq = true;
        this._im.emit("aborted");
        const imErr = err || Object.assign(new Error("aborted"), { code: "ECONNRESET", _fromReqAbort: true });
        this._im.destroy(imErr);
      }
      if (!err && !this._responseReceived && !wasAborted) {
        err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return super.destroy(err);
    }
  }

  const activeServerReqs = new Map();

  function validateHTTPStatusCode(statusCode) {
    const n = Number(statusCode);
    if (!Number.isInteger(n) || n < 100 || n > 999) {
      const err = new RangeError(`Invalid status code: ${statusCode}. Status code must be an integer between 100 and 999.`);
      err.code = "ERR_HTTP_INVALID_STATUS_CODE";
      throw err;
    }
    return n;
  }

  class ServerResponse extends Writable {
    constructor(serverId, reqId, srv) {
      super();
      this._serverId = serverId;
      this._reqId = reqId;
      this._srv = srv || null;
      this._reqRefed = true;
      incRef();
      if (this._srv) this._srv._activeReqs++;
      this.statusCode = 200;
      this.statusMessage = undefined;
      this._headers = Object.create(null);
      this._headerNames = Object.create(null);
      this._trailers = null;
      this.headersSent = false;
      this._respondedDone = false;
    }
    _releaseReq() {
      activeServerReqs.delete(this._reqId);
      if (!this._reqRefed) return;
      this._reqRefed = false;
      decRef();
      if (this._srv) {
        this._srv._activeReqs = Math.max(0, this._srv._activeReqs - 1);
        if (this._srv._closing && this._srv._activeReqs === 0) {
          let pendingInGo = 0;
          try {
            pendingInGo = Number(hostCall("http.serverStopAccept", String(this._srv._id))) || 0;
          } catch (_) {}
          if (pendingInGo === 0) {
            this._srv._finishClose();
          }
        }
      }
    }
    _buildWireHeaders() {
      const out = Object.create(null);
      for (const lower of Object.keys(this._headers)) {
        const origName = this._headerNames[lower] || lower;
        out[origName] = this._headers[lower];
      }
      return out;
    }
    setHeader(name, value) {
      if (this.headersSent) {
        throw makeNodeError("ERR_HTTP_HEADERS_SENT", "Cannot set headers after they are sent to the client", Error);
      }
      if (name === undefined || name === null || typeof name !== "string" || name.length === 0) {
        throw makeNodeError("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token ["${name}"]`, TypeError);
      }
      if (value === undefined) {
        throw makeNodeError("ERR_HTTP_INVALID_HEADER_VALUE", `Invalid value "undefined" for header "${name}"`, TypeError);
      }
      const lower = String(name).toLowerCase();
      this._headerNames[lower] = String(name);
      this._headers[lower] = Array.isArray(value) ? value.map(String) : String(value);
      return this;
    }
    getHeader(name) { return this._headers[String(name).toLowerCase()]; }
    getHeaders() { return Object.assign(Object.create(null), this._headers); }
    getHeaderNames() { return Object.keys(this._headers); }
    getRawHeaderNames() { return Object.values(this._headerNames); }
    hasHeader(name) { return String(name).toLowerCase() in this._headers; }
    removeHeader(name) {
      if (this.headersSent) {
        throw makeNodeError("ERR_HTTP_HEADERS_SENT", "Cannot remove headers after they are sent to the client", Error);
      }
      const lower = String(name).toLowerCase();
      delete this._headers[lower];
      delete this._headerNames[lower];
    }
    writeHead(statusCode, statusMessage, headers) {
      if (this.headersSent) {
        throw makeNodeError("ERR_HTTP_HEADERS_SENT", "Cannot write headers after they are sent to the client", Error);
      }
      if (typeof statusMessage === "object" && statusMessage !== null) {
        headers = statusMessage;
        statusMessage = undefined;
      }
      this.statusCode = validateHTTPStatusCode(statusCode);
      if (statusMessage !== undefined) this.statusMessage = String(statusMessage);
      if (headers) {
        if (Array.isArray(headers)) {
          const appendHdr = (rawK, rawV) => {
            const k = String(rawK).toLowerCase();
            this._headerNames[k] = String(rawK);
            const v = String(rawV);
            if (k === "set-cookie") {
              if (!Array.isArray(this._headers[k])) {
                this._headers[k] = this._headers[k] !== undefined ? [String(this._headers[k])] : [];
              }
              this._headers[k].push(v);
            } else if (this._headers[k] !== undefined) {
              this._headers[k] = `${this._headers[k]}, ${v}`;
            } else {
              this._headers[k] = v;
            }
          };
          if (headers.length > 0 && Array.isArray(headers[0])) {
            for (const pair of headers) {
              if (Array.isArray(pair) && pair.length >= 2) appendHdr(pair[0], pair[1]);
            }
          } else {
            if (headers.length % 2 !== 0) {
              throw makeNodeError("ERR_INVALID_ARG_VALUE", `The argument 'headers' must be an even-length array of key/value strings`, TypeError);
            }
            for (let i = 0; i < headers.length; i += 2) {
              appendHdr(headers[i], headers[i + 1]);
            }
          }
        } else {
          for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
        }
      }
      this.headersSent = true;
      return this;
    }
    flushHeaders() {
      if (this._respondedDone) return;
      const status = validateHTTPStatusCode(this.statusCode);
      this.headersSent = true;
      try {
        hostCall(
          "http.serverRespond",
          JSON.stringify({
            serverId: this._serverId,
            reqId: this._reqId,
            status,
            statusMessage: this.statusMessage || "",
            headers: this._buildWireHeaders(),
            flushHeaders: true,
            done: false,
          }),
          new Uint8Array(0)
        );
      } catch (_) {}
    }
    writeContinue(cb) {
      if (!this.headersSent && !this._respondedDone) {
        try {
          hostCall(
            "http.serverRespond",
            JSON.stringify({
              serverId: this._serverId,
              reqId: this._reqId,
              writeContinue: true,
              done: false,
            }),
            new Uint8Array(0)
          );
        } catch (_) {}
      }
      if (typeof cb === "function") queueMicrotask(cb);
    }
    addTrailers(headers) {
      if (!headers || typeof headers !== "object") return;
      if (!this._trailers) this._trailers = Object.create(null);
      if (Array.isArray(headers)) {
        for (const [k, v] of headers) this._trailers[String(k)] = String(v);
      } else {
        for (const [k, v] of Object.entries(headers)) this._trailers[String(k)] = String(v);
      }
    }
    _write(chunk, encoding, cb) {
      let status;
      try {
        status = validateHTTPStatusCode(this.statusCode);
      } catch (err) {
        cb(err);
        return;
      }
      const body = toBytesInput(chunk, encoding);
      this.headersSent = true;
      const ok = hostCall(
        "http.serverRespond",
        JSON.stringify({
          serverId: this._serverId,
          reqId: this._reqId,
          status,
          statusMessage: this.statusMessage || "",
          headers: this._buildWireHeaders(),
          done: false,
        }),
        body
      );
      if (ok === "false") {
        this._backpressured = true;
      }
      cb();
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = "utf8";
      }
      if (this.destroyed || this._respondedDone) {
        this.writableEnded = true;
        if (typeof cb === "function") processObj.nextTick(cb);
        return this;
      }
      if (
        chunk !== undefined &&
        chunk !== null &&
        !this.writableEnded &&
        !this.destroyed &&
        !this._writing &&
        (!this._writeQueue || this._writeQueue.length === 0)
      ) {
        this._singleShotEndBody = toBytesInput(chunk, encoding || this._defaultEncoding || "utf8");
        return super.end(undefined, undefined, cb);
      }
      return super.end(chunk, encoding, cb);
    }
    _final(cb) {
      let status;
      try {
        status = validateHTTPStatusCode(this.statusCode);
      } catch (err) {
        this._releaseReq();
        cb(err);
        return;
      }
      const finalBody = this._singleShotEndBody || new Uint8Array(0);
      this._singleShotEndBody = null;
      this.headersSent = true;
      this._respondedDone = true;
      try {
        hostCall(
          "http.serverRespond",
          JSON.stringify({
            serverId: this._serverId,
            reqId: this._reqId,
            status,
            statusMessage: this.statusMessage || "",
            headers: this._buildWireHeaders(),
            trailers: this._trailers || undefined,
            done: true,
          }),
          finalBody
        );
      } finally {
        this._releaseReq();
      }
      cb();
    }
    destroy(err) {
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroyed = true;
      }
      if (!this._respondedDone) {
        this._respondedDone = true;
        try {
          hostCall(
            "http.serverRespond",
            JSON.stringify({
              serverId: this._serverId,
              reqId: this._reqId,
              destroy: true,
              done: true,
            }),
            new Uint8Array(0)
          );
        } catch (_) {}
      }
      this._releaseReq();
      return super.destroy(err);
    }
  }

  class Server extends EventEmitter {
    constructor(options, requestListener) {
      super();
      if (typeof options === "function") {
        requestListener = options;
        options = {};
      }
      this._options = options || {};
      this._id = nextAsyncId++;
      this._addr = null;
      this._wantRef = true;
      this._refed = false;
      this._listening = false;
      this._closing = false;
      this._activeReqs = 0;
      this.timeout = 0;
      this.keepAliveTimeout = 5000;
      this.headersTimeout = 60000;
      this.requestTimeout = 300000;
      this.maxRequestsPerSocket = 0;
      if (typeof requestListener === "function") this.on("request", requestListener);
    }
    setTimeout(ms = 0, cb) {
      this.timeout = Number(ms) || 0;
      if (typeof cb === "function") this.on("timeout", cb);
      return this;
    }
    closeAllConnections() {
      try {
        hostCall("http.serverCloseConns", String(this._id));
      } catch (_) {}
      for (const [reqId, entry] of activeServerReqs.entries()) {
        if (entry && entry.res && entry.res._serverId === this._id) {
          activeServerReqs.delete(reqId);
          entry.res._respondedDone = true;
          entry.res.destroyed = true;
          entry.req.destroyed = true;
          if (entry.req.socket) entry.req.socket.destroyed = true;
          entry.res._releaseReq();
          processObj.nextTick(() => {
            if (!entry.req._closeEmitted) {
              entry.req._closeEmitted = true;
              entry.req.emit("close");
            }
            if (!entry.res._closeEmitted) {
              entry.res._closeEmitted = true;
              entry.res.emit("close");
            }
          });
        }
      }
    }
    closeIdleConnections() {
      try {
        hostCall("http.serverCloseConns", JSON.stringify({ id: this._id, idleOnly: true }));
      } catch (_) {}
    }
    listen(port = 0, host = "", backlog, cb) {
      if (this._listening || this._closing) {
        const err = new Error("Listen method has been called more than once without closing.");
        err.code = "ERR_SERVER_ALREADY_LISTEN";
        throw err;
      }
      let listenSignal;
      if (typeof port === "function") {
        cb = port;
        port = 0;
        host = "";
      } else if (typeof port === "object" && port !== null) {
        const opts = port;
        cb = host;
        port = opts.port || 0;
        host = opts.host || "";
        listenSignal = opts.signal;
      } else if (typeof host === "function") {
        cb = host;
        host = "";
      } else if (typeof backlog === "function") {
        cb = backlog;
      }
      if (listenSignal !== undefined) {
        if (!listenSignal || typeof listenSignal !== "object" || typeof listenSignal.aborted !== "boolean") {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "options.signal" property must be an instance of AbortSignal. Received ${listenSignal === null ? "null" : typeof listenSignal}`, TypeError);
        }
      }
      if (typeof cb === "function") this.once("listening", cb);
      try {
        const isTLS = Boolean(this._options._tls || (this._options.key && this._options.cert));
        const keyStr = this._options.key ? (Buffer.isBuffer(this._options.key) ? this._options.key.toString("utf8") : String(this._options.key)) : "";
        const certStr = this._options.cert ? (Buffer.isBuffer(this._options.cert) ? this._options.cert.toString("utf8") : String(this._options.cert)) : "";
        const info = JSON.parse(
          hostCall(
            "http.serverListen",
            JSON.stringify({
              id: this._id,
              port: Number(port) || 0,
              host: String(host || ""),
              tls: isTLS,
              key: keyStr,
              cert: certStr,
            })
          )
        );
        this._addr = info;
        this._listening = true;
        this._closing = false;
        if (this._wantRef && !this._refed) {
          this._refed = true;
          incRef();
        }
        activeServers.set(this._id, this);
        if (listenSignal) {
          if (listenSignal.aborted) {
            processObj.nextTick(() => this.close());
          } else if (typeof listenSignal.addEventListener === "function") {
            const onAbort = () => this.close();
            listenSignal.addEventListener("abort", onAbort, { once: true });
            this.once("close", () => {
              if (typeof listenSignal.removeEventListener === "function") {
                listenSignal.removeEventListener("abort", onAbort);
              }
            });
          }
        }
        processObj.nextTick(() => this.emit("listening"));
      } catch (err) {
        processObj.nextTick(() => this.emit("error", err));
      }
      return this;
    }
    get listening() { return Boolean(this._listening); }
    address() { return this._addr; }
    _finishClose() {
      if (!this._closing) return;
      this._closing = false;
      this._listening = false;
      this._addr = null;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      if (activeServers.has(this._id)) {
        activeServers.delete(this._id);
        try {
          hostCall("http.serverClose", String(this._id));
        } catch (_) {}
      }
      processObj.nextTick(() => {
        this.emit("close");
      });
    }
    close(cb) {
      if (typeof cb === "function") this.once("close", cb);
      if (!this._listening && !this._closing) {
        processObj.nextTick(() => {
          this.emit("close");
        });
        return this;
      }
      if (this._closing) return this;
      this._closing = true;
      this._listening = false;
      this._addr = null;
      let pendingInGo = 0;
      try {
        pendingInGo = Number(hostCall("http.serverStopAccept", String(this._id))) || 0;
      } catch (_) {}
      if (this._activeReqs === 0 && pendingInGo === 0) {
        this._finishClose();
      }
      return this;
    }
    ref() {
      this._wantRef = true;
      if (!this._refed && this._listening && !this._closing) {
        this._refed = true;
        incRef();
      }
      return this;
    }
    unref() {
      this._wantRef = false;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      return this;
    }
  }

  function hasUnescapedRequestPathChars(p) {
    for (let i = 0; i < p.length; i++) {
      if (p.charCodeAt(i) <= 0x20) return true;
    }
    return false;
  }

  function makeHTTPReq(defaultProtocol) {
    function request(urlOrOpts, options, cb) {
      if (typeof urlOrOpts === "string" || urlOrOpts instanceof URL) {
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        options = Object.assign({}, options || {});
        const u = urlOrOpts instanceof URL ? new URL(urlOrOpts.href) : new URL(urlOrOpts);
        if ((u.username || u.password) && !options.auth) {
          options.auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
          u.username = "";
          u.password = "";
        }
        if (options.path !== undefined) {
          const p = String(options.path);
          if (hasUnescapedRequestPathChars(p)) {
            throw makeNodeError("ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters", TypeError);
          }
          const qIdx = p.indexOf("?");
          if (qIdx >= 0) {
            u.pathname = p.slice(0, qIdx) || "/";
            u.search = p.slice(qIdx);
          } else {
            u.pathname = p;
            u.search = "";
          }
        }
        return new ClientRequest(u.href, options, cb);
      }
      cb = options;
      options = urlOrOpts || {};
      const proto = options.protocol || defaultProtocol;
      let host = String(options.hostname || options.host || "localhost");
      let port = options.port ? `:${options.port}` : "";
      if (!options.hostname && options.host) {
        const rawHost = String(options.host);
        if (rawHost.startsWith("[")) {
          const closeIdx = rawHost.indexOf("]");
          if (closeIdx > 0) {
            host = rawHost.slice(0, closeIdx + 1);
            if (!port && rawHost.slice(closeIdx + 1).startsWith(":")) {
              port = rawHost.slice(closeIdx + 1);
            }
          }
        } else if (rawHost.includes(":") && rawHost.indexOf(":") === rawHost.lastIndexOf(":")) {
          const parts = rawHost.split(":");
          host = parts[0];
          if (!port && parts[1]) port = `:${parts[1]}`;
        }
      }
      if (host.includes(":") && !host.startsWith("[")) {
        host = `[${host}]`;
      }
      const path = options.path !== undefined ? String(options.path) : "/";
      if (hasUnescapedRequestPathChars(path)) {
        throw makeNodeError("ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters", TypeError);
      }
      return new ClientRequest(`${proto}//${host}${port}${path}`, options, cb);
    }
    function get(urlOrOpts, options, cb) {
      const req = request(urlOrOpts, options, cb);
      req.end();
      return req;
    }
    return { request, get };
  }

  const httpFns = makeHTTPReq("http:");
  const httpsFns = makeHTTPReq("https:");
  class Agent {
    constructor(options = {}) {
      this.options = options || {};
    }
  }

  function validateHeaderName(name) {
    if (typeof name !== "string" || !name || !HTTP_TOKEN_RE.test(name)) {
      throw makeNodeError("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token ["${name}"]`, TypeError);
    }
  }
  function validateHeaderValue(name, value) {
    if (value === undefined) {
      throw makeNodeError("ERR_HTTP_INVALID_HEADER_VALUE", `Invalid value "undefined" for header "${name}"`, TypeError);
    }
    if (/[\r\n\0]/.test(String(value))) {
      throw makeNodeError("ERR_INVALID_CHAR", `Invalid character in header content ["${name}"]`, TypeError);
    }
  }

  builtins["http"] = {
    Agent,
    globalAgent: new Agent(),
    ClientRequest,
    IncomingMessage,
    OutgoingMessage: Writable,
    Server,
    ServerResponse,
    createServer: (opts, listener) => new Server(opts, listener),
    request: httpFns.request,
    get: httpFns.get,
    maxHeaderSize: 16384,
    validateHeaderName,
    validateHeaderValue,
    METHODS: ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PRI", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"],
    STATUS_CODES: {
      100: "Continue",
      101: "Switching Protocols",
      102: "Processing",
      103: "Early Hints",
      200: "OK",
      201: "Created",
      202: "Accepted",
      203: "Non-Authoritative Information",
      204: "No Content",
      205: "Reset Content",
      206: "Partial Content",
      207: "Multi-Status",
      208: "Already Reported",
      226: "IM Used",
      300: "Multiple Choices",
      301: "Moved Permanently",
      302: "Found",
      303: "See Other",
      304: "Not Modified",
      305: "Use Proxy",
      307: "Temporary Redirect",
      308: "Permanent Redirect",
      400: "Bad Request",
      401: "Unauthorized",
      402: "Payment Required",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      406: "Not Acceptable",
      407: "Proxy Authentication Required",
      408: "Request Timeout",
      409: "Conflict",
      410: "Gone",
      411: "Length Required",
      412: "Precondition Failed",
      413: "Payload Too Large",
      414: "URI Too Long",
      415: "Unsupported Media Type",
      416: "Range Not Satisfiable",
      417: "Expectation Failed",
      418: "I'm a Teapot",
      421: "Misdirected Request",
      422: "Unprocessable Entity",
      423: "Locked",
      424: "Failed Dependency",
      425: "Too Early",
      426: "Upgrade Required",
      428: "Precondition Required",
      429: "Too Many Requests",
      431: "Request Header Fields Too Large",
      451: "Unavailable For Legal Reasons",
      500: "Internal Server Error",
      501: "Not Implemented",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
      505: "HTTP Version Not Supported",
      506: "Variant Also Negotiates",
      507: "Insufficient Storage",
      508: "Loop Detected",
      509: "Bandwidth Limit Exceeded",
      510: "Not Extended",
      511: "Network Authentication Required",
    },
  };
  builtins["https"] = {
    Agent,
    globalAgent: new Agent(),
    ClientRequest,
    Server,
    createServer: (opts, listener) => {
      if (typeof opts === "function") return new Server({ _tls: true }, opts);
      return new Server(Object.assign({}, opts, { _tls: true }), listener);
    },
    request: httpsFns.request,
    get: httpsFns.get,
  };

  function isIPv4(s) {
    if (typeof s !== "string") return false;
    const parts = s.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d+$/.test(p) && (p.length === 1 || !p.startsWith("0")) && Number(p) >= 0 && Number(p) <= 255);
  }
  function isIPv6(s) {
    if (typeof s !== "string" || s.length === 0) return false;
    let addr = s;
    const zoneIdx = addr.indexOf("%");
    if (zoneIdx !== -1) {
      if (zoneIdx === addr.length - 1) return false;
      addr = addr.slice(0, zoneIdx);
    }
    if (!addr.includes(":")) return false;
    if (/:::/.test(addr)) return false;
    const dblParts = addr.split("::");
    if (dblParts.length > 2) return false;
    const lastColon = addr.lastIndexOf(":");
    const tail = addr.slice(lastColon + 1);
    if (tail.includes(".")) {
      if (!isIPv4(tail)) return false;
      addr = addr.slice(0, lastColon) + ":0:0";
    }
    const parts = addr.split("::");
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
    const isHexGroup = (g) => /^[0-9a-fA-F]{1,4}$/.test(g);
    if (!left.every(isHexGroup) || !right.every(isHexGroup)) return false;
    if (parts.length === 2) {
      return left.length + right.length < 8;
    }
    return left.length === 8;
  }
  function isIP(s) {
    return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0;
  }

  const activeNetListeners = new Map();
  const activeNetSockets = new Map();

  class NetSocket extends Duplex {
    constructor(options = {}) {
      super(options);
      this._id = options._id || 0;
      this._wantRef = true;
      this._refed = false;
      this._remoteEOF = false;
      this._timeoutMs = options && options.timeout ? Math.max(0, Number(options.timeout) || 0) : 0;
      this._timeoutTimer = null;
      this.allowHalfOpen = Boolean(options.allowHalfOpen);
      this.remoteAddress = options.remoteAddress || undefined;
      this.remotePort = options.remotePort || undefined;
      this.remoteFamily = options.remoteFamily || (options.remoteAddress ? (String(options.remoteAddress).includes(":") ? "IPv6" : "IPv4") : undefined);
      this.localAddress = options.localAddress || undefined;
      this.localPort = options.localPort || undefined;
      this.bytesRead = 0;
      this.bytesWritten = 0;
      this.connecting = false;
      this._pendingConnectQueue = [];
      this._onPull = (n) => {
        if (this._id && !this.destroyed) {
          try {
            hostCall("net.pullConn", JSON.stringify({ id: this._id, n: n || 1 }));
          } catch (_) {}
        }
      };
    }
    address() {
      if (this.destroyed || !this.localAddress) return {};
      return {
        address: this.localAddress,
        family: String(this.localAddress).includes(":") ? "IPv6" : "IPv4",
        port: this.localPort || 0,
      };
    }
    get readyState() {
      if (this.connecting) return "opening";
      if (this.destroyed || !this._id) return "closed";
      const rOpen = !this._remoteEOF && !this.readableEnded;
      const wOpen = !this.writableEnded;
      if (rOpen && wOpen) return "open";
      if (rOpen && !wOpen) return "readOnly";
      if (!rOpen && wOpen) return "writeOnly";
      return "closed";
    }
    _resetTimeout() {
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = null;
      }
      if (this._timeoutMs > 0 && !this.destroyed) {
        this._timeoutTimer = setTimeout(() => {
          this._timeoutTimer = null;
          this.emit("timeout");
        }, this._timeoutMs);
        this._timeoutTimer.unref();
      }
    }
    _clearTimeout() {
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = null;
      }
    }
    connect(portOrOpts, hostOrCb, cb) {
      let port;
      let host = "127.0.0.1";
      let opts = null;
      if (typeof portOrOpts === "object" && portOrOpts !== null) {
        opts = portOrOpts;
        port = Number(portOrOpts.port) || 0;
        host = portOrOpts.host || portOrOpts.hostname || "127.0.0.1";
        cb = hostOrCb;
      } else {
        port = Number(portOrOpts) || 0;
        if (typeof hostOrCb === "function") {
          cb = hostOrCb;
        } else if (typeof hostOrCb === "string") {
          host = hostOrCb;
        } else if (typeof hostOrCb === "object" && hostOrCb !== null) {
          opts = hostOrCb;
          host = hostOrCb.host || hostOrCb.hostname || "127.0.0.1";
        }
      }
      if (typeof cb === "function") this.once(this._isTLS ? "secureConnect" : "connect", cb);
      if (opts && opts.allowHalfOpen !== undefined) {
        this.allowHalfOpen = Boolean(opts.allowHalfOpen);
      }
      if (opts && opts.timeout !== undefined) {
        this._timeoutMs = Math.max(0, Number(opts.timeout) || 0);
      }
      this._id = nextAsyncId++;
      this.connecting = true;
      if (this._wantRef && !this._refed) {
        this._refed = true;
        incRef();
      }
      activeNetSockets.set(this._id, this);
      this._resetTimeout();
      const tlsOpts = Object.assign({}, this._tlsOptions || {}, opts || {});
      const toPemStr = (v) => {
        if (!v) return "";
        if (Array.isArray(v)) return v.map(toPemStr).join("\n");
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
        return String(v);
      };
      hostCall(
        "net.connect",
        JSON.stringify({
          id: this._id,
          port,
          host,
          tls: Boolean(this._isTLS),
          servername: tlsOpts.servername ? String(tlsOpts.servername) : "",
          rejectUnauthorized: tlsOpts.rejectUnauthorized !== undefined ? Boolean(tlsOpts.rejectUnauthorized) : undefined,
          ca: toPemStr(tlsOpts.ca),
          cert: toPemStr(tlsOpts.cert),
          key: toPemStr(tlsOpts.key),
          alpnProtocols: Array.isArray(tlsOpts.ALPNProtocols) ? tlsOpts.ALPNProtocols.map(String) : undefined,
        })
      );
      return this;
    }
    _write(chunk, encoding, cb) {
      if (this.destroyed) {
        cb(Object.assign(new Error("Socket is closed"), { code: "EPIPE" }));
        return;
      }
      if (this.connecting) {
        if (!this._pendingConnectQueue) this._pendingConnectQueue = [];
        this._pendingConnectQueue.push((err) => {
          if (err) return cb(err);
          this._write(chunk, encoding, cb);
        });
        return;
      }
      if (!this._id) {
        cb(makeNodeError("ERR_SOCKET_CLOSED", "Socket is closed", Error));
        return;
      }
      try {
        this._resetTimeout();
        if (this._id) {
          const bytes = toBytesInput(chunk, encoding);
          this.bytesWritten += bytes.byteLength;
          const ok = hostCall("net.write", String(this._id), bytes);
          if (ok === "false") {
            this._backpressured = true;
          }
        }
        cb();
      } catch (err) {
        cb(err);
      }
    }
    _final(cb) {
      if (this.connecting) {
        if (!this._pendingConnectQueue) this._pendingConnectQueue = [];
        this._pendingConnectQueue.push((err) => {
          if (err) return cb(err);
          this._final(cb);
        });
        return;
      }
      this._clearTimeout();
      if (this._id) {
        if (this._remoteEOF) {
          activeNetSockets.delete(this._id);
          if (this._refed) {
            this._refed = false;
            decRef();
          }
          try {
            hostCall("net.closeConn", JSON.stringify({ id: this._id, halfClose: false }));
          } catch (_) {}
        } else {
          try {
            hostCall("net.closeConn", JSON.stringify({ id: this._id, halfClose: true }));
          } catch (_) {}
        }
      }
      cb();
    }
    destroy(err) {
      this._clearTimeout();
      if (this._pendingConnectQueue) this._pendingConnectQueue.length = 0;
      if (this._id && activeNetSockets.has(this._id)) {
        activeNetSockets.delete(this._id);
        if (this._refed) {
          this._refed = false;
          decRef();
        }
        try { hostCall("net.closeConn", JSON.stringify({ id: this._id, destroy: true })); } catch (_) {}
      }
      return super.destroy(err);
    }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    setTimeout(ms, cb) {
      this._timeoutMs = Math.max(0, Number(ms) || 0);
      if (typeof cb === "function") this.once("timeout", cb);
      this._resetTimeout();
      return this;
    }
    ref() {
      this._wantRef = true;
      if (!this._refed && activeNetSockets.has(this._id)) {
        this._refed = true;
        incRef();
      }
      return this;
    }
    unref() {
      this._wantRef = false;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      return this;
    }
  }

  class NetServer extends EventEmitter {
    constructor(options, connectionListener) {
      super();
      if (typeof options === "function") {
        connectionListener = options;
        options = {};
      }
      this._options = options || {};
      this._isTLS = Boolean(this._options._isTLS);
      this._id = nextAsyncId++;
      this._addr = null;
      this._wantRef = true;
      this._refed = false;
      this._listening = false;
      this._closing = false;
      this._connections = new Set();
      if (typeof connectionListener === "function") {
        this.on(this._isTLS ? "secureConnection" : "connection", connectionListener);
      }
    }
    listen(port = 0, host = "", backlog, cb) {
      if (this._listening || this._closing) {
        const err = new Error("Listen method has been called more than once without closing.");
        err.code = "ERR_SERVER_ALREADY_LISTEN";
        throw err;
      }
      let listenSignal;
      if (typeof port === "function") {
        cb = port;
        port = 0;
        host = "";
      } else if (typeof port === "object" && port !== null) {
        const opts = port;
        cb = host;
        port = opts.port || 0;
        host = opts.host || "";
        listenSignal = opts.signal;
      } else if (typeof host === "function") {
        cb = host;
        host = "";
      } else if (typeof backlog === "function") {
        cb = backlog;
      }
      if (listenSignal !== undefined) {
        if (!listenSignal || typeof listenSignal !== "object" || typeof listenSignal.aborted !== "boolean") {
          throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "options.signal" property must be an instance of AbortSignal. Received ${listenSignal === null ? "null" : typeof listenSignal}`, TypeError);
        }
      }
      if (typeof cb === "function") this.once("listening", cb);
      try {
        const toPem = (v) => {
          if (!v) return "";
          if (Array.isArray(v)) return v.map(toPem).join("\n");
          if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
          return String(v);
        };
        const listenPayload = {
          id: this._id,
          port: Number(port) || 0,
          host: String(host || ""),
        };
        if (this._isTLS) {
          listenPayload.tls = true;
          listenPayload.key = toPem(this._options.key);
          listenPayload.cert = toPem(this._options.cert);
          listenPayload.ca = toPem(this._options.ca);
          listenPayload.requestCert = Boolean(this._options.requestCert);
          if (this._options.rejectUnauthorized !== undefined) {
            listenPayload.rejectUnauthorized = Boolean(this._options.rejectUnauthorized);
          }
          if (Array.isArray(this._options.ALPNProtocols)) {
            listenPayload.ALPNProtocols = this._options.ALPNProtocols.map(String);
          }
        }
        const info = JSON.parse(
          hostCall("net.listen", JSON.stringify(listenPayload))
        );
        this._addr = info;
        this._listening = true;
        this._closing = false;
        if (this._wantRef && !this._refed) {
          this._refed = true;
          incRef();
        }
        activeNetListeners.set(this._id, this);
        if (listenSignal) {
          if (listenSignal.aborted) {
            processObj.nextTick(() => this.close());
          } else if (typeof listenSignal.addEventListener === "function") {
            const onAbort = () => this.close();
            listenSignal.addEventListener("abort", onAbort, { once: true });
            this.once("close", () => {
              if (typeof listenSignal.removeEventListener === "function") {
                listenSignal.removeEventListener("abort", onAbort);
              }
            });
          }
        }
        processObj.nextTick(() => this.emit("listening"));
      } catch (err) {
        processObj.nextTick(() => this.emit("error", err));
      }
      return this;
    }
    get listening() { return Boolean(this._listening); }
    address() { return this._addr; }
    getConnections(cb) {
      if (typeof cb === "function") {
        processObj.nextTick(() => cb(null, this._connections.size));
      }
      return this;
    }
    _finishClose() {
      if (!this._closing) return;
      this._closing = false;
      this._listening = false;
      this._addr = null;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      processObj.nextTick(() => {
        this.emit("close");
      });
    }
    close(cb) {
      if (typeof cb === "function") this.once("close", cb);
      if (!this._listening && !this._closing) {
        processObj.nextTick(() => {
          this.emit("close");
        });
        return this;
      }
      if (this._closing) return this;
      this._closing = true;
      this._listening = false;
      this._addr = null;
      if (activeNetListeners.has(this._id)) {
        activeNetListeners.delete(this._id);
        try {
          hostCall("net.closeServer", String(this._id));
        } catch (_) {}
      }
      if (this._connections.size === 0) {
        this._finishClose();
      }
      return this;
    }
    ref() {
      this._wantRef = true;
      if (!this._refed && this._listening && !this._closing) {
        this._refed = true;
        incRef();
      }
      return this;
    }
    unref() {
      this._wantRef = false;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      return this;
    }
  }

  function netConnect(...args) {
    const first = args[0];
    const sock = new NetSocket(typeof first === "object" && first !== null ? first : undefined);
    return sock.connect(...args);
  }

  class SocketAddress {
    constructor(options = {}) {
      options = options || {};
      this.address = String(options.address || (options.family === "ipv6" ? "::" : "127.0.0.1"));
      this.family = String(options.family || (isIPv6(this.address) ? "ipv6" : "ipv4")).toLowerCase();
      this.port = Number(options.port) || 0;
      this.flowlabel = Number(options.flowlabel) || 0;
    }
    static parse(input) {
      try {
        const u = new URL(`http://${input}`);
        const host = u.hostname.replace(/^\[|\]$/g, "");
        return new SocketAddress({
          address: host,
          family: isIPv6(host) ? "ipv6" : "ipv4",
          port: u.port ? Number(u.port) : 0,
        });
      } catch (_) {
        return undefined;
      }
    }
  }

  function parseIPBigInt(addr, family) {
    if (typeof addr !== "string" || !addr) return null;
    const fam = String(family || "ipv4").toLowerCase();
    if (fam === "ipv4") {
      if (!isIPv4(addr)) return null;
      const parts = addr.split(".");
      let val = 0n;
      for (let i = 0; i < 4; i++) {
        val = (val << 8n) | BigInt(Number(parts[i]));
      }
      return val;
    }
    if (fam === "ipv6") {
      const clean = addr.split("%")[0];
      if (!isIPv6(clean)) return null;
      let work = clean;
      const lastColon = work.lastIndexOf(":");
      if (lastColon >= 0 && work.indexOf(".", lastColon) >= 0) {
        const v4Part = work.slice(lastColon + 1);
        const v4Val = parseIPBigInt(v4Part, "ipv4");
        if (v4Val === null) return null;
        const hi = Number((v4Val >> 16n) & 0xffffn).toString(16);
        const lo = Number(v4Val & 0xffffn).toString(16);
        work = work.slice(0, lastColon + 1) + hi + ":" + lo;
      }
      const halves = work.split("::");
      if (halves.length > 2) return null;
      const left = halves[0] ? halves[0].split(":") : [];
      const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
      const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
      if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
      const groups = [...left, ...new Array(missing).fill("0"), ...right];
      if (groups.length !== 8) return null;
      let val = 0n;
      for (let i = 0; i < 8; i++) {
        const g = parseInt(groups[i] || "0", 16);
        if (Number.isNaN(g) || g < 0 || g > 0xffff) return null;
        val = (val << 16n) | BigInt(g);
      }
      return val;
    }
    return null;
  }

  class BlockList {
    constructor() {
      this._rules = [];
    }
    addAddress(address, type = "ipv4") {
      const addr = address instanceof SocketAddress ? address.address : String(address);
      const t = address instanceof SocketAddress ? address.family : String(type).toLowerCase();
      this._rules.push({ kind: "addr", address: addr.toLowerCase(), type: t });
    }
    addRange(start, end, type = "ipv4") {
      const s = start instanceof SocketAddress ? start.address : String(start);
      const e = end instanceof SocketAddress ? end.address : String(end);
      const t = start instanceof SocketAddress ? start.family : String(type).toLowerCase();
      this._rules.push({ kind: "range", start: s.toLowerCase(), end: e.toLowerCase(), type: t });
    }
    addSubnet(net, prefix, type = "ipv4") {
      const addr = net instanceof SocketAddress ? net.address : String(net);
      const t = net instanceof SocketAddress ? net.family : String(type).toLowerCase();
      this._rules.push({ kind: "subnet", net: addr.toLowerCase(), prefix: Number(prefix), type: t });
    }
    check(address, type = "ipv4") {
      const addr = address instanceof SocketAddress ? address.address.toLowerCase() : String(address).toLowerCase();
      const t = address instanceof SocketAddress ? address.family : String(type).toLowerCase();
      const addrVal = parseIPBigInt(addr, t);
      return this._rules.some((r) => {
        let checkVal = addrVal;
        if (r.type !== t) {
          if (t === "ipv6" && r.type === "ipv4" && addrVal !== null && (addrVal >> 32n) === 0xffffn) {
            checkVal = addrVal & 0xffffffffn;
          } else if (t === "ipv4" && r.type === "ipv6" && addrVal !== null) {
            checkVal = 0xffff00000000n | addrVal;
          } else {
            return false;
          }
        }
        if (checkVal === null) {
          return r.address === addr || r.start === addr || r.end === addr || r.net === addr;
        }
        if (r.kind === "addr") {
          const rv = parseIPBigInt(r.address, r.type);
          return rv !== null ? rv === checkVal : r.address === addr;
        }
        if (r.kind === "range") {
          const sv = parseIPBigInt(r.start, r.type);
          const ev = parseIPBigInt(r.end, r.type);
          return sv !== null && ev !== null && checkVal >= sv && checkVal <= ev;
        }
        if (r.kind === "subnet") {
          const nv = parseIPBigInt(r.net, r.type);
          if (nv === null) return false;
          const totalBits = r.type === "ipv6" ? 128 : 32;
          const pref = Math.max(0, Math.min(totalBits, Math.trunc(Number(r.prefix) || 0)));
          if (pref === 0) return true;
          const shift = BigInt(totalBits - pref);
          return (checkVal >> shift) === (nv >> shift);
        }
        return false;
      });
    }
    get rules() {
      return this._rules.map((r) => {
        if (r.kind === "addr") return `Address: ${r.type.toUpperCase()} ${r.address}`;
        if (r.kind === "range") return `Range: ${r.type.toUpperCase()} ${r.start}-${r.end}`;
        return `Subnet: ${r.type.toUpperCase()} ${r.net}/${r.prefix}`;
      });
    }
  }

  builtins["net"] = {
    isIP,
    isIPv4,
    isIPv6,
    Socket: NetSocket,
    Server: NetServer,
    BlockList,
    SocketAddress,
    createServer: (opts, listener) => new NetServer(opts, listener),
    connect: netConnect,
    createConnection: netConnect,
  };

  let dnsDefaultResultOrder = "verbatim";
  let dnsServers = ["8.8.8.8", "1.1.1.1"];

  const DNS_CONSTANTS = {
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    NODATA: "ENODATA",
    FORMERR: "EFORMERR",
    SERVFAIL: "ESERVFAIL",
    NOTFOUND: "ENOTFOUND",
    NOTIMP: "ENOTIMP",
    REFUSED: "EREFUSED",
    BADQUERY: "EBADQUERY",
    BADNAME: "EBADNAME",
    BADFAMILY: "EBADFAMILY",
    BADRESP: "EBADRESP",
    CONNREFUSED: "ECONNREFUSED",
    TIMEOUT: "ETIMEDOUT",
    EOF: "EOF",
    FILE: "EFILE",
    NOMEM: "ENOMEM",
    DESTRUCTION: "EDESTRUCTION",
    BADSTR: "EBADSTR",
    BADFLAGS: "EBADFLAGS",
    NONAME: "ENONAME",
    BADHINTS: "EBADHINTS",
    NOTINITIALIZED: "ENOTINITIALIZED",
    LOADIPHLPAPI: "ELOADIPHLPAPI",
    ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS",
    CANCELLED: "ECANCELLED",
  };

  function validateDNSServers(servers) {
    if (!Array.isArray(servers)) {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'servers' argument must be an Array", TypeError);
    }
    return servers.map((srv) => {
      if (typeof srv !== "string") {
        throw makeNodeError("ERR_INVALID_ARG_TYPE", "Each element of 'servers' must be a string", TypeError);
      }
      let ip = srv;
      if (ip.startsWith("[")) {
        const closeIdx = ip.indexOf("]");
        if (closeIdx < 0) {
          throw makeNodeError("ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${srv}`, TypeError);
        }
        const rest = ip.slice(closeIdx + 1);
        if (rest && !/^:\d+$/.test(rest)) {
          throw makeNodeError("ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${srv}`, TypeError);
        }
        ip = ip.slice(1, closeIdx);
      } else if (ip.includes(":") && ip.indexOf(":") === ip.lastIndexOf(":")) {
        const [hostPart, portPart] = ip.split(":");
        if (!/^\d+$/.test(portPart)) {
          throw makeNodeError("ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${srv}`, TypeError);
        }
        ip = hostPart;
      }
      if (isIP(ip) === 0) {
        throw makeNodeError("ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${srv}`, TypeError);
      }
      return srv;
    });
  }

  class DNSResolver {
    constructor() {
      this._servers = dnsServers.slice();
    }
    getServers() { return this._servers.slice(); }
    setServers(servers) {
      this._servers = validateDNSServers(servers);
    }
    setLocalAddress() {}
    cancel() {}
  }

  async function dnsLookupAsync(hostname, options) {
    let family = 0;
    let all = false;
    if (typeof options === "number") family = options;
    else if (options && typeof options === "object") {
      family = options.family || 0;
      all = Boolean(options.all);
    }
    const raw = await hostAsyncCall("dns.lookup", JSON.stringify({ hostname: String(hostname), family, all }));
    return JSON.parse(raw);
  }
  async function dnsResolveAsync(hostname, rrtype = "A") {
    const raw = await hostAsyncCall("dns.resolve", JSON.stringify({ hostname: String(hostname), rrtype: String(rrtype) }));
    return JSON.parse(raw);
  }
  async function dnsLookupServiceAsync(address, port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      throw makeNodeError("ERR_SOCKET_BAD_PORT", `Port should be >= 0 and < 65536. Received ${port}.`, RangeError);
    }
    let host = String(address);
    try {
      const ptrs = await dnsResolveAsync(host, "PTR");
      if (Array.isArray(ptrs) && ptrs.length > 0) host = ptrs[0];
    } catch (_) {}
    const services = { 22: "ssh", 53: "domain", 80: "http", 443: "https" };
    return { hostname: host, service: services[p] || String(p) };
  }
  function wrapDnsCallback(asyncFn) {
    return function (...args) {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      asyncFn(...args).then(
        (res) => { if (cb) cb(null, res); },
        (err) => { if (cb) cb(err); }
      );
    };
  }

  class DNSPromisesResolver {
    constructor() {
      this._servers = dnsServers.slice();
    }
    getServers() { return this._servers.slice(); }
    setServers(servers) {
      this._servers = validateDNSServers(servers);
    }
    setLocalAddress() {}
    cancel() {}
  }

  const dnsAsyncMethods = {
    resolve: dnsResolveAsync,
    resolve4: (hostname) => dnsResolveAsync(hostname, "A"),
    resolve6: (hostname) => dnsResolveAsync(hostname, "AAAA"),
    resolveAny: (hostname) => dnsResolveAsync(hostname, "ANY"),
    resolveCaa: (hostname) => dnsResolveAsync(hostname, "CAA"),
    resolveCname: (hostname) => dnsResolveAsync(hostname, "CNAME"),
    resolveMx: (hostname) => dnsResolveAsync(hostname, "MX"),
    resolveNaptr: (hostname) => dnsResolveAsync(hostname, "NAPTR"),
    resolveNs: (hostname) => dnsResolveAsync(hostname, "NS"),
    resolvePtr: (hostname) => dnsResolveAsync(hostname, "PTR"),
    resolveSoa: (hostname) => dnsResolveAsync(hostname, "SOA"),
    resolveSrv: (hostname) => dnsResolveAsync(hostname, "SRV"),
    resolveTxt: (hostname) => dnsResolveAsync(hostname, "TXT"),
    reverse: (ip) => dnsResolveAsync(ip, "PTR"),
  };
  Object.assign(DNSPromisesResolver.prototype, dnsAsyncMethods);

  const dnsPromises = {
    Resolver: DNSPromisesResolver,
    lookup: dnsLookupAsync,
    lookupService: dnsLookupServiceAsync,
    ...dnsAsyncMethods,
    getServers: () => dnsServers.slice(),
    setServers: (s) => {
      dnsServers = validateDNSServers(s);
    },
    getDefaultResultOrder: () => dnsDefaultResultOrder,
    setDefaultResultOrder: (o) => { dnsDefaultResultOrder = String(o); },
    ...DNS_CONSTANTS,
  };
  const dnsCallbacks = {
    resolve: wrapDnsCallback(dnsResolveAsync),
    resolve4: wrapDnsCallback((h) => dnsResolveAsync(h, "A")),
    resolve6: wrapDnsCallback((h) => dnsResolveAsync(h, "AAAA")),
    resolveAny: wrapDnsCallback((h) => dnsResolveAsync(h, "ANY")),
    resolveCaa: wrapDnsCallback((h) => dnsResolveAsync(h, "CAA")),
    resolveCname: wrapDnsCallback((h) => dnsResolveAsync(h, "CNAME")),
    resolveMx: wrapDnsCallback((h) => dnsResolveAsync(h, "MX")),
    resolveNaptr: wrapDnsCallback((h) => dnsResolveAsync(h, "NAPTR")),
    resolveNs: wrapDnsCallback((h) => dnsResolveAsync(h, "NS")),
    resolvePtr: wrapDnsCallback((h) => dnsResolveAsync(h, "PTR")),
    resolveSoa: wrapDnsCallback((h) => dnsResolveAsync(h, "SOA")),
    resolveSrv: wrapDnsCallback((h) => dnsResolveAsync(h, "SRV")),
    resolveTxt: wrapDnsCallback((h) => dnsResolveAsync(h, "TXT")),
    reverse: wrapDnsCallback((ip) => dnsResolveAsync(ip, "PTR")),
  };
  Object.assign(DNSResolver.prototype, dnsCallbacks);
  builtins["dns"] = {
    promises: dnsPromises,
    Resolver: DNSResolver,
    lookup(hostname, options, cb) {
      if (typeof options === "function") { cb = options; options = {}; }
      dnsLookupAsync(hostname, options).then(
        (res) => {
          if (typeof cb !== "function") return;
          if (Array.isArray(res)) cb(null, res);
          else cb(null, res.address, res.family);
        },
        (err) => {
          if (typeof cb === "function") cb(err);
        }
      );
    },
    lookupService(address, port, cb) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 0 || p > 65535) {
        throw makeNodeError("ERR_SOCKET_BAD_PORT", `Port should be >= 0 and < 65536. Received ${port}.`, RangeError);
      }
      dnsLookupServiceAsync(address, p).then(
        (res) => {
          if (typeof cb === "function") cb(null, res.hostname, res.service);
        },
        (err) => {
          if (typeof cb === "function") cb(err);
        }
      );
    },
    ...dnsCallbacks,
    getServers: dnsPromises.getServers,
    setServers: dnsPromises.setServers,
    getDefaultResultOrder: dnsPromises.getDefaultResultOrder,
    setDefaultResultOrder: dnsPromises.setDefaultResultOrder,
    ...DNS_CONSTANTS,
  };
  builtins["dns/promises"] = dnsPromises;

  // =========================================================================
  // 16. CommonJS Module System (require, module, createRequire) & Compat Stubs
  // =========================================================================

  const cjsCache = Object.create(null);

  function resolveCJS(id, baseDir) {
    const s = String(id);
    if (s.startsWith("node:")) {
      const name = s.slice(5);
      if (name in builtins) return "node:" + name;
    }
    if (s in builtins) return s;
    return hostCall("module.resolve", JSON.stringify({ id: s, baseDir: baseDir || processObj.cwd() }));
  }

  function stripJSCommentsAndStrings(code) {
    const s = String(code);
    let out = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i];
      if (ch === "/" && i + 1 < n && s[i + 1] === "/") {
        i += 2;
        while (i < n && s[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && i + 1 < n && s[i + 1] === "*") {
        i += 2;
        while (i + 1 < n && !(s[i] === "*" && s[i + 1] === "/")) {
          if (s[i] === "\n") out += "\n";
          i++;
        }
        if (i + 1 < n) i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        const quote = ch;
        out += quote + quote;
        i++;
        while (i < n) {
          if (s[i] === "\\") {
            i += 2;
            continue;
          }
          if (s[i] === "\n") out += "\n";
          if (s[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  function isESModuleSource(resolvedPath, code) {
    const lower = String(resolvedPath || "").toLowerCase();
    if (lower.endsWith(".mjs")) return true;
    if (lower.endsWith(".cjs")) return false;
    const stripped = stripJSCommentsAndStrings(code);
    if (/\b(?:module\.exports|exports\.[a-zA-Z_$][\w$]*)\s*=/.test(stripped)) {
      return false;
    }
    if (
      /(?:^|[\r\n;{}])\s*(?:import\s+(?:[\w*{]|["'])|import\s*\(|import\.meta\b|export\s+(?:default|const|let|var|function|class|async|\{|\*))/m.test(stripped) ||
      /\bimport\.meta\b/.test(stripped)
    ) {
      return true;
    }
    if (resolvedPath && lower.endsWith(".js")) {
      let dir = activePath.dirname(resolvedPath);
      const rootCwd = processObj.cwd();
      for (let depth = 0; depth < 32 && dir; depth++) {
        const pkgFile = activePath.join(dir, "package.json");
        try {
          if (existsSync(pkgFile)) {
            const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
            if (pkg && typeof pkg === "object" && typeof pkg.type === "string") {
              return pkg.type === "module";
            }
            break;
          }
        } catch (_) {
          break;
        }
        if (dir === rootCwd) break;
        const parent = activePath.dirname(dir);
        if (!parent || parent === dir) break;
        dir = parent;
      }
    }
    return false;
  }

  function makeRequire(fromFile) {
    const getBaseDir = () => (fromFile ? activePath.dirname(fromFile) : processObj.cwd());
    function req(id) {
      if (typeof id !== "string" || !id) throw new TypeError("The 'id' argument must be a non-empty string");
      if (id.startsWith("node:")) {
        const name = id.slice(5);
        if (name in builtins) return builtins[name];
      }
      if (id in builtins) return builtins[id];

      const resolved = resolveCJS(id, getBaseDir());
      if (resolved.startsWith("node:")) {
        return builtins[resolved.slice(5)];
      }
      if (cjsCache[resolved]) {
        return cjsCache[resolved].exports;
      }

      const mod = {
        id: resolved,
        filename: resolved,
        loaded: false,
        exports: {},
        paths: [],
        children: [],
      };
      cjsCache[resolved] = mod;

      try {
        if (resolved.toLowerCase().endsWith(".json")) {
          const raw = readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
          mod.exports = JSON.parse(raw);
          mod.loaded = true;
          return mod.exports;
        }
        const code = readFileSync(resolved, "utf8");
        const dirname = activePath.dirname(resolved);
        if (typeof rawRequireESM === "function" && isESModuleSource(resolved, code)) {
          const ns = rawRequireESM(code, resolved, pathToFileURL(resolved).href, dirname);
          mod.exports = ns;
          mod.loaded = true;
          return mod.exports;
        }
        const childReq = makeRequire(resolved);
        const fn = evalCJS(code, resolved);
        fn.call(mod.exports, mod.exports, childReq, mod, resolved, dirname);
        mod.loaded = true;
        return mod.exports;
      } catch (err) {
        delete cjsCache[resolved];
        throw err;
      }
    }
    req.resolve = function (id, options) {
      if (options && Array.isArray(options.paths)) {
        let lastErr = null;
        for (const p of options.paths) {
          if (!p) continue;
          try {
            return resolveCJS(id, String(p));
          } catch (err) {
            lastErr = err;
          }
        }
        if (lastErr) throw lastErr;
      }
      return resolveCJS(id, getBaseDir());
    };
    req.cache = cjsCache;
    req.main = mainModuleObj;
    return req;
  }

  const mainModuleObj = {
    id: ".",
    filename: init.entryFile || activePath.join(processObj.cwd(), "[eval].js"),
    path: init.entryDir || processObj.cwd(),
    exports: {},
    loaded: false,
    children: [],
    paths: [],
  };
  let isEntryESM = Boolean(init.isESMEntry);
  if (!isEntryESM && !init.isEvalEntry && mainModuleObj.filename) {
    try {
      if (existsSync(mainModuleObj.filename)) {
        isEntryESM = isESModuleSource(mainModuleObj.filename, readFileSync(mainModuleObj.filename, "utf8"));
      }
    } catch (_) {}
  }
  if (!isEntryESM) {
    cjsCache[mainModuleObj.filename] = mainModuleObj;
  }
  const rootRequire = makeRequire(init.isEvalEntry ? "" : mainModuleObj.filename);

  globalThis.require = rootRequire;
  globalThis.__qjs_require = function (id, fromFile) {
    if (fromFile) return makeRequire(fromFile)(id);
    return rootRequire(id);
  };
  globalThis.__qjs_require.makeMetaResolve = function (metaUrl) {
    return function resolve(specifier) {
      const s = String(specifier);
      if (s.startsWith("node:")) return s;
      if (s in builtins) return "node:" + s;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^[a-zA-Z]:[\\/]/.test(s)) {
        if (s.startsWith("file://")) {
          try {
            const p = fileURLToPath(s);
            const resolved = hostCall("module.resolve", JSON.stringify({ id: p, baseDir: processObj.cwd(), isESM: true }));
            return pathToFileURL(resolved).href;
          } catch (_) {
            return new URL(s).href;
          }
        }
        return s;
      }
      let baseDir = processObj.cwd();
      if (metaUrl) {
        try {
          const fp = metaUrl.startsWith("file://") ? fileURLToPath(metaUrl) : String(metaUrl);
          if (fp && fp !== "[eval]") baseDir = activePath.dirname(fp);
        } catch (_) {}
      }
      try {
        const resolved = hostCall("module.resolve", JSON.stringify({ id: s, baseDir, isESM: true }));
        if (resolved.startsWith("node:")) return resolved;
        return pathToFileURL(resolved).href;
      } catch (err) {
        if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
          const baseUrl = metaUrl && metaUrl.startsWith("file://") ? metaUrl : pathToFileURL(activePath.join(baseDir, "_")).href;
          return new URL(s, baseUrl).href;
        }
        throw err;
      }
    };
  };
  globalThis.module = mainModuleObj;
  globalThis.exports = mainModuleObj.exports;
  globalThis.__filename = mainModuleObj.filename;
  globalThis.__dirname = mainModuleObj.path;
  globalThis.__qjs_cjs_main_args = [
    mainModuleObj.exports,
    rootRequire,
    mainModuleObj,
    mainModuleObj.filename,
    mainModuleObj.path,
  ];
  builtins["sys"] = builtins["util"];

  const builtinNames = Object.keys(builtins);
  class Module {
    static createRequire(filename) {
      let f;
      let isTrailingSlash;
      if (filename instanceof URL) {
        isTrailingSlash = filename.pathname.endsWith("/");
        f = fileURLToPath(filename);
      } else if (typeof filename === "string" && filename.startsWith("file://")) {
        const u = new URL(filename);
        isTrailingSlash = u.pathname.endsWith("/");
        f = fileURLToPath(u);
      } else if (typeof filename === "string" && filename.length > 0) {
        isTrailingSlash = filename.endsWith("/") || filename.endsWith("\\");
        f = filename;
      } else {
        const err = new TypeError(`The "filename" argument must be a file URL object, file URL string, or absolute path string. Received ${filename}`);
        err.code = "ERR_INVALID_ARG_VALUE";
        throw err;
      }
      if (isTrailingSlash) {
        f = activePath.join(f, "noop.js");
      }
      return makeRequire(f);
    }
    static isBuiltin(moduleName) {
      const s = String(moduleName);
      if (s.startsWith("node:")) return s.slice(5) in builtins;
      return s in builtins;
    }
    static _resolveFilename(request, parent) {
      const base = parent && parent.filename ? activePath.dirname(parent.filename) : processObj.cwd();
      return resolveCJS(request, base);
    }
  }
  Module.builtinModules = builtinNames;
  Module.Module = Module;
  builtins["module"] = Module;

  builtins["tty"] = {
    isatty: () => false,
    ReadStream: Readable,
    WriteStream: Writable,
  };

  const activeALS = [];
  const alsRestoreMap = new Map();
  const promiseMetaMap = new WeakMap();
  const jobSnapQueue = [];
  const alsHookStack = [];
  let alsPromiseHookInstalled = false;
  let inPromiseThen = 0;
  let inPromiseResolve = 0;
  let lastCreatedPromise = null;

  function snapshotALS() {
    if (activeALS.length === 0) return null;
    return activeALS.map((als) => [als, als._store]);
  }
  function ensureALSPromiseHook() {
    if (alsPromiseHookInstalled || typeof rawSetPromiseHook !== "function") return;
    alsPromiseHookInstalled = true;
    const origResolve = Promise.resolve;
    Promise.resolve = function (v) {
      inPromiseResolve++;
      try {
        return origResolve.call(this, v);
      } finally {
        inPromiseResolve--;
      }
    };
    const origReject = Promise.reject;
    Promise.reject = function (v) {
      inPromiseResolve++;
      try {
        return origReject.call(this, v);
      } finally {
        inPromiseResolve--;
      }
    };
    Object.defineProperty(Promise.prototype, "constructor", {
      configurable: true,
      enumerable: false,
      get() {
        if (activeALS.length > 0 && inPromiseThen === 0 && inPromiseResolve === 0 && this && typeof this === "object") {
          const snap = snapshotALS();
          let meta = promiseMetaMap.get(this);
          if (!meta) {
            meta = { settled: false, reactions: [] };
            promiseMetaMap.set(this, meta);
          }
          if (meta.settled) {
            jobSnapQueue.push(snap);
          } else {
            meta.reactions.push(snap);
          }
        }
        return Promise;
      },
      set(v) {
        Object.defineProperty(this, "constructor", {
          value: v,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      },
    });
    rawSetPromiseHook(function (type, promise, _parent) {
      if (activeALS.length === 0) return;
      if (type === 0) { // INIT
        if (promise && typeof promise === "object") {
          promiseMetaMap.set(promise, { settled: false, initSnap: snapshotALS(), reactions: [] });
          lastCreatedPromise = promise;
        }
      } else if (type === 3) { // RESOLVE
        if (promise && typeof promise === "object") {
          let meta = promiseMetaMap.get(promise);
          if (!meta) {
            meta = { settled: true, reactions: [] };
            promiseMetaMap.set(promise, meta);
          } else {
            meta.settled = true;
          }
          if (promise === lastCreatedPromise && inPromiseThen === 0 && inPromiseResolve === 0 && meta.reactions.length === 0) {
            // Possibly OP_await on a non-Promise primitive value (which creates and immediately resolves a promise in C)
            // Note: new Promise((r) => r()) in user code also resolves during constructor, so only record initSnap on meta
            meta.resolvedSyncInInit = true;
          }
          lastCreatedPromise = null;
          if (meta.reactions.length > 0) {
            for (let i = 0; i < meta.reactions.length; i++) {
              jobSnapQueue.push(meta.reactions[i]);
            }
            meta.reactions.length = 0;
          }
        }
      } else if (type === 4) { // BEFORE JOB
        const prev = activeALS.map((als) => [als, als._store]);
        alsHookStack.push(prev);
        const snap = jobSnapQueue.length > 0 ? jobSnapQueue.shift() : null;
        if (snap) {
          for (const [als, val] of snap) {
            als._store = val;
          }
        }
      } else if (type === 5) { // AFTER JOB
        const prev = alsHookStack.pop();
        if (prev) {
          for (const [als, val] of prev) {
            als._store = val;
          }
        }
      }
    });
  }
  function wrapALS(fn) {
    if (typeof fn !== "function") return fn;
    const snap = snapshotALS();
    if (!snap) return fn;
    return function (...args) {
      const prev = activeALS.map((als) => [als, als._store]);
      for (const [als, val] of snap) {
        als._store = val;
      }
      try {
        return fn.apply(this, args);
      } finally {
        for (const [als, old] of prev) {
          als._store = old;
        }
      }
    };
  }
  const origPromiseThen = Promise.prototype.then;
  Promise.prototype.then = function (onFulfilled, onRejected) {
    if (activeALS.length > 0 && this && typeof this === "object") {
      const snap = snapshotALS();
      let meta = promiseMetaMap.get(this);
      if (!meta) {
        meta = { settled: false, reactions: [] };
        promiseMetaMap.set(this, meta);
      }
      if (meta.settled) {
        jobSnapQueue.push(snap);
      } else {
        meta.reactions.push(snap);
      }
    }
    inPromiseThen++;
    try {
      return origPromiseThen.call(this, wrapALS(onFulfilled), wrapALS(onRejected));
    } finally {
      inPromiseThen--;
    }
  };
  const origQueueMicrotask = globalThis.queueMicrotask;
  globalThis.queueMicrotask = function (cb) {
    if (activeALS.length > 0) {
      jobSnapQueue.push(snapshotALS());
    }
    return origQueueMicrotask(wrapALS(cb));
  };
  const origNextTick = processObj.nextTick;
  processObj.nextTick = function (cb, ...args) {
    return origNextTick(wrapALS(cb), ...args);
  };
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (cb, ms, ...args) {
    return origSetTimeout(wrapALS(cb), ms, ...args);
  };
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = function (cb, ms, ...args) {
    return origSetInterval(wrapALS(cb), ms, ...args);
  };
  const origSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = function (cb, ...args) {
    return origSetImmediate(wrapALS(cb), ...args);
  };

  class AsyncLocalStorage {
    constructor() {
      this._store = undefined;
      this._enabled = false;
    }
    _ensureActive() {
      if (!this._enabled) {
        this._enabled = true;
        activeALS.push(this);
        ensureALSPromiseHook();
      }
    }
    getStore() { return this._store; }
    run(store, callback, ...args) {
      this._ensureActive();
      const prev = this._store;
      this._store = store;
      try {
        return callback(...args);
      } finally {
        this._store = prev;
      }
    }
    enterWith(store) {
      this._ensureActive();
      this._store = store;
    }
    disable() {
      this._store = undefined;
      this._enabled = false;
      const idx = activeALS.indexOf(this);
      if (idx !== -1) activeALS.splice(idx, 1);
    }
  }
  class AsyncResource {
    constructor(type) {
      this.type = type;
      this._snap = snapshotALS();
    }
    runInAsyncScope(fn, thisArg, ...args) {
      if (!this._snap) return fn.apply(thisArg, args);
      const prev = this._snap.map(([als, val]) => {
        const old = als._store;
        als._store = val;
        return [als, old];
      });
      try {
        return fn.apply(thisArg, args);
      } finally {
        for (const [als, old] of prev) als._store = old;
      }
    }
    asyncId() { return 1; }
    triggerAsyncId() { return 0; }
  }
  builtins["async_hooks"] = {
    AsyncLocalStorage,
    AsyncResource,
    executionAsyncId: () => 1,
    triggerAsyncId: () => 0,
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
  };

  const V8_TYPED_ARRAY_CTORS = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };
  const V8_ERROR_CTORS = {
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    EvalError,
  };

  function v8EncodeVal(val, seen = new Map()) {
    if (val === undefined) return { __v8t: "undef" };
    if (typeof val === "number") {
      if (Number.isNaN(val)) return { __v8t: "nan" };
      if (val === Infinity) return { __v8t: "inf" };
      if (val === -Infinity) return { __v8t: "-inf" };
      if (Object.is(val, -0)) return { __v8t: "-0" };
      return val;
    }
    if (typeof val === "bigint") return { __v8t: "bigint", v: val.toString() };
    if (typeof val === "function" || typeof val === "symbol") {
      const err = new Error(`${typeof val} could not be cloned.`);
      err.name = "DataCloneError";
      throw err;
    }
    if (!val || typeof val !== "object") return val;
    if (uncloneableObjects.has(val)) {
      throw new DOMException("Object could not be cloned.", "DataCloneError");
    }
    if (seen.has(val)) {
      return { __v8t: "ref", id: seen.get(val) };
    }
    const id = seen.size + 1;
    seen.set(val, id);
    if (val instanceof Date) return { __v8t: "date", id, v: val.getTime() };
    if (val instanceof RegExp) return { __v8t: "regexp", id, s: val.source, f: val.flags };
    if (Buffer.isBuffer(val)) {
      return { __v8t: "buf", id, v: Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString("base64") };
    }
    if (val instanceof ArrayBuffer) {
      return { __v8t: "ab", id, v: Buffer.from(val).toString("base64") };
    }
    if (typeof SharedArrayBuffer !== "undefined" && val instanceof SharedArrayBuffer) {
      return { __v8t: "sab", id, v: Buffer.from(new Uint8Array(val)).toString("base64") };
    }
    if (ArrayBuffer.isView(val)) {
      const b64 = Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString("base64");
      if (val instanceof DataView) {
        return { __v8t: "dv", id, v: b64 };
      }
      const ctorName = val.constructor && val.constructor.name ? val.constructor.name : "Uint8Array";
      return { __v8t: "ta", id, c: ctorName, v: b64 };
    }
    if (val instanceof Error) {
      const props = {};
      for (const k of Object.keys(val)) {
        props[k] = v8EncodeVal(val[k], seen);
      }
      return {
        __v8t: "err",
        id,
        n: val.name || "Error",
        m: val.message || "",
        st: val.stack || "",
        cause: "cause" in val ? v8EncodeVal(val.cause, seen) : undefined,
        hasCause: "cause" in val,
        p: props,
      };
    }
    if (val instanceof Map) {
      return {
        __v8t: "map",
        id,
        v: Array.from(val.entries()).map(([k, v]) => [v8EncodeVal(k, seen), v8EncodeVal(v, seen)]),
      };
    }
    if (val instanceof Set) {
      return {
        __v8t: "set",
        id,
        v: Array.from(val.values()).map((x) => v8EncodeVal(x, seen)),
      };
    }
    if (Array.isArray(val)) {
      return {
        __v8t: "arr",
        id,
        v: val.map((x) => v8EncodeVal(x, seen)),
      };
    }
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = v8EncodeVal(v, seen);
    }
    return { __v8t: "obj", id, v: out };
  }
  function v8DecodeVal(val, refs = new Map()) {
    if (!val || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map((x) => v8DecodeVal(x, refs));
    if (typeof val.__v8t === "string") {
      switch (val.__v8t) {
        case "undef": return undefined;
        case "nan": return NaN;
        case "inf": return Infinity;
        case "-inf": return -Infinity;
        case "-0": return -0;
        case "bigint": return BigInt(val.v);
        case "ref": return refs.get(val.id);
        case "date": {
          const d = new Date(val.v);
          if (val.id) refs.set(val.id, d);
          return d;
        }
        case "regexp": {
          const r = new RegExp(val.s, val.f);
          if (val.id) refs.set(val.id, r);
          return r;
        }
        case "buf": {
          const b = Buffer.from(val.v, "base64");
          if (val.id) refs.set(val.id, b);
          return b;
        }
        case "ab": {
          const b = Buffer.from(val.v, "base64");
          const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          if (val.id) refs.set(val.id, ab);
          return ab;
        }
        case "sab": {
          const b = Buffer.from(val.v, "base64");
          const sab = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(b.byteLength) : new ArrayBuffer(b.byteLength);
          new Uint8Array(sab).set(b);
          if (val.id) refs.set(val.id, sab);
          return sab;
        }
        case "dv": {
          const b = Buffer.from(val.v, "base64");
          const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          const dv = new DataView(ab);
          if (val.id) refs.set(val.id, dv);
          return dv;
        }
        case "ta": {
          const b = Buffer.from(val.v, "base64");
          const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          const Ctor = V8_TYPED_ARRAY_CTORS[val.c] || Uint8Array;
          const ta = new Ctor(ab);
          if (val.id) refs.set(val.id, ta);
          return ta;
        }
        case "err": {
          const ErrCtor = V8_ERROR_CTORS[val.n] || Error;
          const e = new ErrCtor(val.m);
          if (val.id) refs.set(val.id, e);
          e.name = val.n;
          if (val.st) e.stack = val.st;
          if (val.hasCause) e.cause = v8DecodeVal(val.cause, refs);
          if (val.p && typeof val.p === "object") {
            for (const [k, pv] of Object.entries(val.p)) {
              e[k] = v8DecodeVal(pv, refs);
            }
          }
          return e;
        }
        case "map": {
          const m = new Map();
          if (val.id) refs.set(val.id, m);
          for (const [k, mv] of val.v) {
            m.set(v8DecodeVal(k, refs), v8DecodeVal(mv, refs));
          }
          return m;
        }
        case "set": {
          const s = new Set();
          if (val.id) refs.set(val.id, s);
          for (const sv of val.v) {
            s.add(v8DecodeVal(sv, refs));
          }
          return s;
        }
        case "arr": {
          const arr = [];
          if (val.id) refs.set(val.id, arr);
          for (let i = 0; i < val.v.length; i++) {
            arr[i] = v8DecodeVal(val.v[i], refs);
          }
          return arr;
        }
        case "obj": {
          const obj = {};
          if (val.id) refs.set(val.id, obj);
          for (const [k, ov] of Object.entries(val.v)) {
            obj[k] = v8DecodeVal(ov, refs);
          }
          return obj;
        }
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = v8DecodeVal(v, refs);
    return out;
  }
  function v8Serialize(v) {
    if (v && typeof v === "object" && !uncloneableObjects.has(v)) {
      if (Buffer.isBuffer(v)) {
        const out = Buffer.allocUnsafe(3 + v.byteLength);
        out[0] = 0xff;
        out[1] = 0x10;
        out[2] = 0x01;
        out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), 3);
        return out;
      }
      if (v instanceof ArrayBuffer) {
        const out = Buffer.allocUnsafe(3 + v.byteLength);
        out[0] = 0xff;
        out[1] = 0x10;
        out[2] = 0x02;
        out.set(new Uint8Array(v), 3);
        return out;
      }
      if (v instanceof Uint8Array && v.constructor === Uint8Array) {
        const out = Buffer.allocUnsafe(3 + v.byteLength);
        out[0] = 0xff;
        out[1] = 0x10;
        out[2] = 0x03;
        out.set(v, 3);
        return out;
      }
    }
    const body = Buffer.from(JSON.stringify(v8EncodeVal(v)), "utf8");
    const out = Buffer.allocUnsafe(2 + body.length);
    out[0] = 0xff;
    out[1] = 0x0f;
    out.set(body, 2);
    return out;
  }
  function v8Deserialize(b) {
    const buf = Buffer.from(b);
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0x10) {
      const sub = buf.subarray(3);
      if (buf[2] === 0x01) return Buffer.from(sub);
      const ab = sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
      if (buf[2] === 0x02) return ab;
      return new Uint8Array(ab);
    }
    const start = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x0f ? 2 : 0;
    return v8DecodeVal(JSON.parse(buf.subarray(start).toString("utf8")));
  }

  class MessagePort extends EventEmitter {
    constructor() {
      super();
      this._peer = null;
      this._msgQueue = [];
      this._started = false;
      this._closed = false;
      this._onmessage = null;
    }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) {
      if (this._onmessage) super.off("message", this._onmessage);
      this._onmessage = typeof fn === "function" ? (data) => fn({ data }) : null;
      if (this._onmessage) {
        this.on("message", this._onmessage);
      }
    }
    _deliver(val) {
      if (this._closed) return;
      if (this._started && this.listenerCount("message") > 0) {
        this.emit("message", val);
      } else {
        this._msgQueue.push(val);
      }
    }
    _drainQueue() {
      if (!this._started || this._closed) return;
      while (this._msgQueue.length > 0 && this.listenerCount("message") > 0 && !this._closed) {
        const val = this._msgQueue.shift();
        this.emit("message", val);
      }
    }
    postMessage(val, transferList) {
      if (this._closed) return;
      const cloned = transferList !== undefined
        ? globalThis.structuredClone(val, { transfer: transferList })
        : globalThis.structuredClone(val);
      const target = this._peer || this;
      if (target._closed) return;
      target._msgQueue.push(cloned);
      queueMicrotask(() => target._drainQueue());
    }
    start() {
      this._started = true;
      queueMicrotask(() => this._drainQueue());
    }
    on(ev, fn) {
      super.on(ev, fn);
      if (ev === "message") {
        this._started = true;
        queueMicrotask(() => this._drainQueue());
      }
      return this;
    }
    once(ev, fn) {
      super.once(ev, fn);
      if (ev === "message") {
        this._started = true;
        queueMicrotask(() => this._drainQueue());
      }
      return this;
    }
    addListener(ev, fn) {
      return this.on(ev, fn);
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      this._msgQueue.length = 0;
      this.emit("close");
      const peer = this._peer;
      if (peer && !peer._closed) {
        queueMicrotask(() => {
          if (!peer._closed) {
            peer._closed = true;
            peer._msgQueue.length = 0;
            peer.emit("close");
          }
        });
      }
    }
    ref() { return this; }
    unref() { return this; }
  }
  class MessageChannel {
    constructor() {
      this.port1 = new MessagePort();
      this.port2 = new MessagePort();
      this.port1._peer = this.port2;
      this.port2._peer = this.port1;
    }
  }
  const broadcastChannels = new Map();
  let ensureWorkerConnForBC = null;
  function deliverBroadcastChannelLocal(name, data, excludeCh) {
    const set = broadcastChannels.get(name);
    if (!set || set.size === 0) return;
    const targets = Array.from(set).filter((ch) => ch !== excludeCh && !ch._closed);
    if (targets.length === 0) return;
    queueMicrotask(() => {
      for (const ch of targets) {
        if (!ch._closed) {
          const cloned = globalThis.structuredClone(data);
          ch.emit("message", { data: cloned, target: ch });
        }
      }
    });
  }
  class BroadcastChannel extends EventEmitter {
    constructor(name) {
      super();
      this.name = String(name);
      this._closed = false;
      this._wantRef = true;
      this._refed = false;
      this._onmessage = null;
      this._onmessageerror = null;
      let set = broadcastChannels.get(this.name);
      if (!set) {
        set = new Set();
        broadcastChannels.set(this.name, set);
      }
      set.add(this);
    }
    _updateRef() {
      const hasListeners = this.listenerCount("message") > 0 || this.listenerCount("messageerror") > 0;
      const shouldRef = !this._closed && this._wantRef && hasListeners;
      if (shouldRef && !this._refed) {
        this._refed = true;
        incRef();
      } else if (!shouldRef && this._refed) {
        this._refed = false;
        decRef();
      }
      if (!this._closed && hasListeners && typeof ensureWorkerConnForBC === "function") {
        ensureWorkerConnForBC();
      }
    }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) {
      if (this._onmessage) super.off("message", this._onmessage);
      this._onmessage = typeof fn === "function" ? fn : null;
      if (this._onmessage) super.on("message", this._onmessage);
      this._updateRef();
    }
    get onmessageerror() { return this._onmessageerror; }
    set onmessageerror(fn) {
      if (this._onmessageerror) super.off("messageerror", this._onmessageerror);
      this._onmessageerror = typeof fn === "function" ? fn : null;
      if (this._onmessageerror) super.on("messageerror", this._onmessageerror);
      this._updateRef();
    }
    on(ev, fn) {
      super.on(ev, fn);
      this._updateRef();
      return this;
    }
    once(ev, fn) {
      super.once(ev, fn);
      this._updateRef();
      return this;
    }
    addListener(ev, fn) {
      return this.on(ev, fn);
    }
    off(ev, fn) {
      super.off(ev, fn);
      this._updateRef();
      return this;
    }
    removeListener(ev, fn) {
      return this.off(ev, fn);
    }
    removeAllListeners(ev) {
      super.removeAllListeners(ev);
      this._updateRef();
      return this;
    }
    addEventListener(type, listener, options) {
      if (typeof listener !== "function") return;
      if (options && options.once) this.once(type, listener);
      else this.on(type, listener);
    }
    removeEventListener(type, listener) {
      if (typeof listener !== "function") return;
      this.off(type, listener);
    }
    postMessage(message) {
      if (this._closed) {
        throw Object.assign(new Error("BroadcastChannel is closed"), { name: "InvalidStateError" });
      }
      const cloned = globalThis.structuredClone(message);
      deliverBroadcastChannelLocal(this.name, cloned, this);
      if (isWorkerChild) {
        try {
          if (typeof ensureWorkerConnForBC === "function") ensureWorkerConnForBC();
          hostCall("worker.send", "0", v8Serialize({ __indirectBC: this.name, data: cloned }));
        } catch (_) {}
      } else if (activeWorkers.size > 0) {
        const wire = v8Serialize({ __indirectBC: this.name, data: cloned });
        for (const [tid, w] of activeWorkers.entries()) {
          if (!w._exited) {
            try { hostCall("worker.send", String(tid), wire); } catch (_) {}
          }
        }
      }
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      this._updateRef();
      const set = broadcastChannels.get(this.name);
      if (set) {
        set.delete(this);
        if (set.size === 0) broadcastChannels.delete(this.name);
      }
    }
    ref() {
      this._wantRef = true;
      this._updateRef();
      return this;
    }
    unref() {
      this._wantRef = false;
      this._updateRef();
      return this;
    }
  }
  const activeWorkers = new Map();
  class Worker extends EventEmitter {
    constructor(filename, options = {}) {
      super();
      this.threadId = nextAsyncId++;
      const isEval = Boolean(options && options.eval);
      const codeOrFile = filename instanceof URL ? fileURLToPath(filename) : String(filename);
      const pipeStdout = Boolean(options && options.stdout);
      const pipeStderr = Boolean(options && options.stderr);
      const workCwd = (options && options.cwd) || processObj.cwd();
      const tempFiles = [];
      let evalArg = codeOrFile;
      if (isEval && codeOrFile.length > 16384) {
        const ext = isESModuleSource("", codeOrFile) ? ".mjs" : ".cjs";
        for (const baseDir of [workCwd, init.tmpdir]) {
          if (!baseDir) continue;
          try {
            const tf = activePath.join(baseDir, `.indirect-worker-eval-${processObj.pid}-${this.threadId}-${Date.now()}${ext}`);
            writeFileSync(tf, codeOrFile, "utf8");
            tempFiles.push(tf);
            evalArg = tf;
            break;
          } catch (_) {}
        }
      }
      const args = (isEval && evalArg === codeOrFile) ? ["--js", "-e", codeOrFile] : ["--js", evalArg];
      if (options && Array.isArray(options.argv)) {
        args.push(...options.argv.map(String));
      }
      const ctlPort = Number(hostCall("worker.listen", String(this.threadId)));
      const kShareEnv = Symbol.for("nodejs.worker_threads.SHARE_ENV");
      const envSource = (!options || options.env === undefined || options.env === kShareEnv) ? processObj.env : options.env;
      const childEnv = Object.assign({}, envSource, {
        __INDIRECT_WORKER_THREAD_ID: String(this.threadId),
        __INDIRECT_WT_CTL_PORT: String(ctlPort),
      });
      if (workerEnvData.size > 0) {
        try {
          childEnv.__INDIRECT_WORKER_ENV_DATA = v8Serialize(workerEnvData).toString("base64");
        } catch (_) {}
      }
      if (options && options.workerData !== undefined) {
        const b64 = v8Serialize(options.workerData).toString("base64");
        if (b64.length > 16384) {
          let wroteFile = false;
          for (const baseDir of [workCwd, init.tmpdir]) {
            if (!baseDir) continue;
            try {
              const df = activePath.join(baseDir, `.indirect-worker-data-${processObj.pid}-${this.threadId}-${Date.now()}.dat`);
              writeFileSync(df, b64, "utf8");
              tempFiles.push(df);
              childEnv.__INDIRECT_WORKER_DATA_FILE = df;
              wroteFile = true;
              break;
            } catch (_) {}
          }
          if (!wroteFile) childEnv.__INDIRECT_WORKER_DATA = b64;
        } else {
          childEnv.__INDIRECT_WORKER_DATA = b64;
        }
      }
      activeWorkers.set(this.threadId, this);
      this._cp = spawn(processObj.execPath, args, {
        cwd: workCwd,
        env: childEnv,
      });
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = this._cp.stdin;
      if (this._cp.stdout) {
        this._cp.stdout.on("data", (chunk) => {
          if (!pipeStdout) {
            processObj.stdout.write(chunk);
          }
          if (pipeStdout || this.stdout.listenerCount("data") > 0) {
            this.stdout.write(chunk);
          }
        });
        this._cp.stdout.on("end", () => {
          this.stdout.end();
        });
      }
      let errBuf = "";
      if (this._cp.stderr) {
        this._cp.stderr.on("data", (chunk) => {
          errBuf += chunk.toString("utf8");
          if (errBuf.length > 65536) {
            errBuf = errBuf.slice(-65536);
          }
          if (!pipeStderr) {
            processObj.stderr.write(chunk);
          }
          if (pipeStderr || this.stderr.listenerCount("data") > 0) {
            this.stderr.write(chunk);
          }
        });
        this._cp.stderr.on("end", () => {
          this.stderr.end();
        });
      }
      this._exited = false;
      this._terminated = false;
      this._exitCode = 0;
      const cleanupWorkerResources = (waitDrain = false) => {
        try {
          hostCall("worker.close", JSON.stringify({ id: this.threadId, wait: Boolean(waitDrain) }));
        } catch (_) {}
        for (const tf of tempFiles) {
          try { unlinkSync(tf); } catch (_) {}
        }
      };
      this._cp.on("spawn", () => this.emit("online"));
      this._cp.on("error", (err) => {
        cleanupWorkerResources(false);
        activeWorkers.delete(this.threadId);
        this.emit("error", err);
      });
      this._cp.on("exit", (code) => {
        cleanupWorkerResources(!this._terminated);
        this._exited = true;
        this._exitCode = this._terminated ? 1 : (code !== null && code !== undefined ? code : 0);
        setImmediate(() => {
          activeWorkers.delete(this.threadId);
          if (this._exitCode !== 0 && !this._terminated && !this._cleanExit) {
            const msg = errBuf.trim() || `Worker exited with code ${this._exitCode}`;
            const firstLine = msg.split(/\r?\n/)[0].replace(/^Uncaught\s+/i, "").replace(/^[A-Za-z]*Error:\s*/, "");
            this.emit("error", new Error(firstLine || msg));
          }
          this.emit("exit", this._exitCode);
        });
      });
    }
    postMessage(val, transferList) {
      let toSend = val;
      if (transferList !== undefined) {
        toSend = globalThis.structuredClone(val, { transfer: transferList });
      }
      if (!this._exited) {
        hostCall("worker.send", String(this.threadId), v8Serialize(toSend));
      }
    }
    terminate() {
      if (!this._cp || this._exited) {
        return Promise.resolve(this._exitCode);
      }
      this._terminated = true;
      return new Promise((resolve) => {
        this.once("exit", (code) => resolve(code));
        this._cp.kill();
      });
    }
    ref() { if (this._cp) this._cp.ref(); return this; }
    unref() { if (this._cp) this._cp.unref(); return this; }
  }
  const workerThreadIdEnv = init.env && init.env.__INDIRECT_WORKER_THREAD_ID;
  const isWorkerChild = Boolean(workerThreadIdEnv);
  let workerParentPort = null;
  let initialWorkerData = null;
  if (isWorkerChild) {
    if (init.env.__INDIRECT_WORKER_DATA_FILE) {
      try {
        const b64 = readFileSync(init.env.__INDIRECT_WORKER_DATA_FILE, "utf8");
        initialWorkerData = v8Deserialize(Buffer.from(b64, "base64"));
      } catch (_) {}
    } else if (init.env.__INDIRECT_WORKER_DATA) {
      try {
        initialWorkerData = v8Deserialize(Buffer.from(init.env.__INDIRECT_WORKER_DATA, "base64"));
      } catch (_) {}
    }
    workerParentPort = new MessagePort();
    let workerStdinStarted = false;
    let workerPortRefed = false;
    function startWorkerConn(wantRef) {
      if (!workerStdinStarted) {
        workerStdinStarted = true;
        hostCall("worker.start", "");
      }
      if (wantRef && !workerPortRefed) {
        workerPortRefed = true;
        incRef();
      }
    }
    ensureWorkerConnForBC = () => startWorkerConn(false);
    workerParentPort.postMessage = function (val, transferList) {
      let toSend = val;
      if (transferList !== undefined) {
        toSend = globalThis.structuredClone(val, { transfer: transferList });
      }
      startWorkerConn(false);
      hostCall("worker.send", "0", v8Serialize(toSend));
    };
    workerParentPort.start = () => startWorkerConn(true);
    workerParentPort.ref = function () {
      if (!workerPortRefed && workerStdinStarted) {
        workerPortRefed = true;
        incRef();
      }
      return workerParentPort;
    };
    workerParentPort.unref = function () {
      if (workerPortRefed) {
        workerPortRefed = false;
        decRef();
      }
      return workerParentPort;
    };
    workerParentPort.close = function () {
      if (workerPortRefed) {
        workerPortRefed = false;
        decRef();
      }
      try { hostCall("worker.close", "0"); } catch (_) {}
      workerParentPort.emit("close");
    };
    const origOn = workerParentPort.on.bind(workerParentPort);
    workerParentPort.on = function (ev, fn) {
      if (ev === "message") {
        startWorkerConn(true);
      }
      return origOn(ev, fn);
    };
    const origOnce = workerParentPort.once.bind(workerParentPort);
    workerParentPort.once = function (ev, fn) {
      if (ev === "message") {
        startWorkerConn(true);
      }
      return origOnce(ev, fn);
    };
  }
  const isForkChild = Boolean(init.env && init.env.__INDIRECT_FORK_IPC === "1" && init.env.__INDIRECT_WT_CTL_PORT);
  let forkIpcStarted = false;
  let forkIpcRefed = false;
  function startForkIpcConn(wantRef) {
    if (!forkIpcStarted) {
      forkIpcStarted = true;
      hostCall("worker.start", "");
    }
    if (wantRef && !forkIpcRefed && processObj.connected) {
      forkIpcRefed = true;
      incRef();
    }
  }
  if (isForkChild) {
    processObj.connected = true;
    processObj.channel = {
      ref() {
        startForkIpcConn(true);
        return this;
      },
      unref() {
        if (forkIpcRefed) {
          forkIpcRefed = false;
          decRef();
        }
        return this;
      },
    };
    processObj.send = function (message, sendHandle, opts, callback) {
      if (typeof sendHandle === "function") callback = sendHandle;
      else if (typeof opts === "function") callback = opts;
      if (!processObj.connected) {
        const err = makeNodeError("ERR_IPC_CHANNEL_CLOSED", "Channel closed", Error);
        if (typeof callback === "function") {
          queueMicrotask(() => callback(err));
          return false;
        }
        throw err;
      }
      startForkIpcConn(false);
      hostCall("worker.send", "0", v8Serialize(message));
      if (typeof callback === "function") queueMicrotask(() => callback(null));
      return true;
    };
    processObj.disconnect = function () {
      if (!processObj.connected) return;
      processObj.connected = false;
      if (forkIpcRefed) {
        forkIpcRefed = false;
        decRef();
      }
      try { hostCall("worker.close", "0"); } catch (_) {}
      queueMicrotask(() => processObj.emit("disconnect"));
    };
    const origProcOn = processObj.on.bind(processObj);
    processObj.on = function (ev, fn) {
      if (ev === "message" && processObj.connected) {
        startForkIpcConn(true);
      }
      return origProcOn(ev, fn);
    };
    const origProcOnce = processObj.once.bind(processObj);
    processObj.once = function (ev, fn) {
      if (ev === "message" && processObj.connected) {
        startForkIpcConn(true);
      }
      return origProcOnce(ev, fn);
    };
  }

  const workerEnvData = new Map();
  if (init.env && init.env.__INDIRECT_WORKER_ENV_DATA) {
    try {
      const restored = v8Deserialize(Buffer.from(init.env.__INDIRECT_WORKER_ENV_DATA, "base64"));
      if (restored instanceof Map) {
        for (const [k, v] of restored.entries()) workerEnvData.set(k, v);
      }
    } catch (_) {}
  }
  function receiveMessageOnPort(port) {
    if (!port || !(port instanceof MessagePort)) {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", "The 'port' argument must be a MessagePort", TypeError);
    }
    if (port._closed || port._msgQueue.length === 0) return undefined;
    return { message: port._msgQueue.shift() };
  }
  function markAsUntransferable(obj) {
    if (obj && (typeof obj === "object" || typeof obj === "function")) {
      untransferableObjects.add(obj);
    }
  }
  function markAsUncloneable(obj) {
    if (obj && (typeof obj === "object" || typeof obj === "function")) {
      uncloneableObjects.add(obj);
    }
  }
  async function postMessageToThread(threadId, value) {
    const w = activeWorkers.get(Number(threadId));
    if (w) w.postMessage(value);
  }
  function setEnvironmentData(key, value) {
    if (value === undefined) workerEnvData.delete(key);
    else workerEnvData.set(key, value);
  }
  function getEnvironmentData(key) {
    return workerEnvData.get(key);
  }
  function moveMessagePortToContext(port, _contextifiedSandbox) {
    return port;
  }

  builtins["worker_threads"] = {
    isMainThread: !isWorkerChild,
    parentPort: workerParentPort,
    workerData: initialWorkerData,
    threadId: isWorkerChild ? Number(workerThreadIdEnv) || 1 : 0,
    SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
    resourceLimits: {},
    MessagePort,
    MessageChannel,
    BroadcastChannel,
    Worker,
    receiveMessageOnPort,
    markAsUntransferable,
    markAsUncloneable,
    postMessageToThread,
    setEnvironmentData,
    getEnvironmentData,
    moveMessagePortToContext,
  };
  globalThis.MessageChannel = MessageChannel;
  globalThis.MessagePort = MessagePort;
  globalThis.BroadcastChannel = BroadcastChannel;

  builtins["v8"] = {
    serialize: v8Serialize,
    deserialize: v8Deserialize,
    getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 256 * 1024 * 1024 }),
    getHeapSpaceStatistics: () => [],
  };

  let nextVmCtxId = 0;
  const vmContexts = new WeakMap();
  const vmDeadlineStack = [];
  function validateVmTimeout(t) {
    if (t === undefined) return 0;
    if (typeof t !== "number") {
      throw makeNodeError("ERR_INVALID_ARG_TYPE", `The "options.timeout" property must be of type number. Received ${t === null ? "null" : typeof t}`, TypeError);
    }
    if (!Number.isInteger(t) || t <= 0 || t > 2147483647) {
      throw makeNodeError("ERR_OUT_OF_RANGE", `The value of "options.timeout" is out of range. It must be an integer > 0 && <= 2147483647. Received ${t}`, RangeError);
    }
    return t;
  }
  class Script {
    constructor(code, options = {}) {
      this._code = String(code);
      this._filename = (typeof options === "string" ? options : options && options.filename) || "evalmachine.<anonymous>";
      this._timeout = options && typeof options === "object" ? validateVmTimeout(options.timeout) : 0;
    }
    _runWithTimeout(options, fn) {
      const timeout = (options && typeof options === "object" && options.timeout !== undefined)
        ? validateVmTimeout(options.timeout)
        : this._timeout;
      const now = Date.now();
      const myDeadline = timeout > 0 ? now + Math.ceil(timeout) : Infinity;
      const prevEffective = vmDeadlineStack.length > 0 ? vmDeadlineStack[vmDeadlineStack.length - 1] : Infinity;
      const effectiveDeadline = Math.min(myDeadline, prevEffective);
      vmDeadlineStack.push(effectiveDeadline);
      if (Number.isFinite(effectiveDeadline)) {
        const rem = Math.max(1, effectiveDeadline - now);
        hostCall("vm.setDeadline", JSON.stringify({ ms: rem }));
      }
      try {
        return fn();
      } catch (err) {
        if (Number.isFinite(effectiveDeadline) && err && String(err.message || err).includes("__qjs_vm_timeout__")) {
          const reportedTimeout = timeout > 0 ? timeout : Math.max(1, Math.ceil(prevEffective - now));
          const te = new Error(`Script execution timed out after ${reportedTimeout}ms`);
          te.code = "ERR_SCRIPT_EXECUTION_TIMEOUT";
          throw te;
        }
        throw err;
      } finally {
        vmDeadlineStack.pop();
        const nextEffective = vmDeadlineStack.length > 0 ? vmDeadlineStack[vmDeadlineStack.length - 1] : Infinity;
        if (Number.isFinite(nextEffective)) {
          const rem = Math.max(1, nextEffective - Date.now());
          try { hostCall("vm.setDeadline", JSON.stringify({ ms: rem })); } catch (_) {}
        } else {
          try { hostCall("vm.setDeadline", JSON.stringify({ ms: 0 })); } catch (_) {}
        }
      }
    }
    runInThisContext(options) {
      return this._runWithTimeout(options, () => evalScript(this._code, this._filename));
    }
    runInContext(ctxObj, options) {
      const box = ctxObj && typeof ctxObj === "object" ? ctxObj : {};
      let ctxId = vmContexts.get(box) || 0;
      if (!ctxId) {
        ctxId = ++nextVmCtxId;
        vmContexts.set(box, ctxId);
      }
      return this._runWithTimeout(options, () => evalInContext(this._code, box, this._filename, ctxId));
    }
    runInNewContext(ctxObj, options) {
      const hasObj = ctxObj !== undefined && ctxObj !== null && typeof ctxObj === "object";
      let ctxId = 0;
      if (hasObj) {
        ctxId = vmContexts.get(ctxObj) || 0;
        if (!ctxId) {
          ctxId = ++nextVmCtxId;
          vmContexts.set(ctxObj, ctxId);
        }
      }
      return this._runWithTimeout(options, () => evalInContext(this._code, hasObj ? ctxObj : undefined, this._filename, ctxId));
    }
  }
  builtins["vm"] = {
    Script,
    constants: {
      USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_use_main_context_default_loader"),
      DONT_CONTEXTIFY: Symbol("vm_dont_contextify"),
    },
    createContext(sandbox = {}) {
      if (sandbox && typeof sandbox === "object" && !vmContexts.has(sandbox)) {
        vmContexts.set(sandbox, ++nextVmCtxId);
      }
      return sandbox;
    },
    isContext: (sandbox) => Boolean(sandbox && typeof sandbox === "object" && vmContexts.has(sandbox)),
    runInThisContext: (code, opts) => new Script(code, opts).runInThisContext(opts),
    runInContext: (code, ctx, opts) => new Script(code, opts).runInContext(ctx, opts),
    runInNewContext: (code, ctx, opts) => new Script(code, opts).runInNewContext(ctx, opts),
    compileFunction: (code, params = []) => new Function(...params, code),
    measureMemory: () => Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
  };

  function createTestContext(name) {
    const subtests = [];
    const afterHooks = [];
    const beforeEachHooks = [];
    const afterEachHooks = [];
    const ctx = {
      name: String(name || ""),
      diagnostic() {},
      plan() {},
      skip() {},
      todo() {},
      before(fn) { if (typeof fn === "function") fn(); },
      after(fn) { if (typeof fn === "function") afterHooks.push(fn); },
      beforeEach(fn) { if (typeof fn === "function") beforeEachHooks.push(fn); },
      afterEach(fn) { if (typeof fn === "function") afterEachHooks.push(fn); },
      test: (subName, optsOrFn, maybeFn) => {
        const p = runNodeTest(subName, optsOrFn, maybeFn, beforeEachHooks, afterEachHooks);
        subtests.push(p);
        return p;
      },
      _WaitSubtests: async () => {
        for (const p of subtests) await p;
        for (const fn of afterHooks) await fn();
      },
    };
    return ctx;
  }
  async function runNodeTest(name, optsOrFn, maybeFn, beforeEachHooks = [], afterEachHooks = []) {
    const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
    const opts = typeof optsOrFn === "object" && optsOrFn !== null ? optsOrFn : {};
    if (opts.skip || opts.todo || typeof fn !== "function") return;
    const ctx = createTestContext(name);
    for (const h of beforeEachHooks) await h(ctx);
    try {
      if (fn.length >= 2) {
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
          };
          Promise.resolve(fn(ctx, done)).then(() => {
            if (fn.length < 2 && !settled) resolve();
          }, reject);
        });
      } else {
        await fn(ctx);
      }
      await ctx._WaitSubtests();
    } finally {
      for (const h of afterEachHooks) await h(ctx);
    }
  }
  const nodeTestFn = Object.assign(
    (name, optsOrFn, maybeFn) => runNodeTest(name, optsOrFn, maybeFn),
    {
      test: (name, optsOrFn, maybeFn) => runNodeTest(name, optsOrFn, maybeFn),
      describe: (name, optsOrFn, maybeFn) => runNodeTest(name, optsOrFn, maybeFn),
      suite: (name, optsOrFn, maybeFn) => runNodeTest(name, optsOrFn, maybeFn),
      it: (name, optsOrFn, maybeFn) => runNodeTest(name, optsOrFn, maybeFn),
      before: (fn) => (typeof fn === "function" ? Promise.resolve(fn()) : Promise.resolve()),
      after: (fn) => (typeof fn === "function" ? Promise.resolve(fn()) : Promise.resolve()),
      beforeEach: () => {},
      afterEach: () => {},
      skip: () => Promise.resolve(),
      todo: () => Promise.resolve(),
      only: (name, optsOrFn, maybeFn) => runNodeTest(name, optsOrFn, maybeFn),
      mock: {
        fn: (impl = () => {}) => {
          const calls = [];
          const wrapped = function (...args) {
            let result;
            let error;
            try {
              result = impl.apply(this, args);
              return result;
            } catch (err) {
              error = err;
              throw err;
            } finally {
              calls.push({ arguments: args, result, error, this: this });
            }
          };
          wrapped.mock = {
            calls,
            callCount: () => calls.length,
            resetCalls: () => { calls.length = 0; },
            restore: () => {},
          };
          return wrapped;
        },
        method: (obj, methodName, impl) => {
          const orig = obj[methodName];
          const mocked = nodeTestFn.mock.fn(impl || orig);
          mocked.mock.restore = () => { obj[methodName] = orig; };
          obj[methodName] = mocked;
          return mocked;
        },
        reset: () => {},
        restoreAll: () => {},
      },
    }
  );
  builtins["test"] = nodeTestFn;

  builtins["inspector"] = {
    open() {},
    close() {},
    url: () => undefined,
    waitForDebugger() {},
    Session: EventEmitter,
  };

  class ReadlineInterface extends EventEmitter {
    constructor(inputOrOpts, output, completer, terminal) {
      super();
      const opts =
        inputOrOpts && typeof inputOrOpts === "object" && !("readable" in inputOrOpts) && typeof inputOrOpts.on !== "function"
          ? inputOrOpts
          : { input: inputOrOpts, output, completer, terminal };
      this.input = opts.input || null;
      this.output = opts.output || null;
      this.terminal = Boolean(opts.terminal);
      this._prompt = opts.prompt !== undefined ? String(opts.prompt) : "> ";
      this._closed = false;
      this._paused = false;
      this._buf = "";
      this._lineQueue = [];
      this._lineWaiters = [];
      if (this.input && typeof this.input.on === "function") {
        this._onData = (chunk) => {
          if (this._closed) return;
          this._buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          let nlIdx;
          while ((nlIdx = this._buf.indexOf("\n")) !== -1) {
            let line = this._buf.slice(0, nlIdx);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            this._buf = this._buf.slice(nlIdx + 1);
            this._emitLine(line);
          }
        };
        this._onEnd = () => {
          if (this._closed) return;
          if (this._buf.length > 0) {
            let line = this._buf;
            if (line.endsWith("\r")) line = line.slice(0, -1);
            this._buf = "";
            this._emitLine(line);
          }
          this.close();
        };
        this.input.on("data", this._onData);
        this.input.once("end", this._onEnd);
        this.input.once("close", this._onEnd);
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          queueMicrotask(() => this.close());
        } else if (typeof opts.signal.addEventListener === "function") {
          opts.signal.addEventListener("abort", () => this.close(), { once: true });
        }
      }
    }
    _emitLine(line) {
      if (this._lineWaiters.length > 0) {
        this._lineWaiters.shift().resolve({ value: line, done: false });
      } else {
        this._lineQueue.push(line);
      }
      this.emit("line", line);
    }
    setPrompt(prompt) { this._prompt = String(prompt); }
    getPrompt() { return this._prompt; }
    prompt() {
      if (this.output && typeof this.output.write === "function") {
        this.output.write(this._prompt);
      }
    }
    question(query, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = {};
      }
      options = options || {};
      if (options.signal && options.signal.aborted) {
        return;
      }
      if (this.output && typeof this.output.write === "function" && query) {
        this.output.write(String(query));
      }
      const onLine = (answer) => {
        if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
        if (typeof cb === "function") cb(answer);
      };
      let onAbort = null;
      if (options.signal && typeof options.signal.addEventListener === "function") {
        onAbort = () => {
          this.off("line", onLine);
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.once("line", onLine);
    }
    pause() {
      this._paused = true;
      if (this.input && typeof this.input.pause === "function") this.input.pause();
      this.emit("pause");
      return this;
    }
    resume() {
      this._paused = false;
      if (this.input && typeof this.input.resume === "function") this.input.resume();
      this.emit("resume");
      return this;
    }
    write(data) {
      if (this._closed || data === null || data === undefined) return;
      if (this._onData) this._onData(String(data));
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      if (this.input && typeof this.input.off === "function" && this._onData) {
        this.input.off("data", this._onData);
        this.input.off("end", this._onEnd);
        this.input.off("close", this._onEnd);
      }
      while (this._lineWaiters.length > 0) {
        this._lineWaiters.shift().resolve({ value: undefined, done: true });
      }
      this.emit("close");
    }
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (this._lineQueue.length > 0) {
            yield this._lineQueue.shift();
            continue;
          }
          if (this._closed) break;
          const step = await new Promise((resolve, reject) => {
            this._lineWaiters.push({ resolve, reject });
          });
          if (step.done) break;
          yield step.value;
        }
      } finally {
        if (!this._closed) this.close();
      }
    }
  }

  class ReadlinePromisesInterface extends ReadlineInterface {
    question(query, options = {}) {
      return new Promise((resolve, reject) => {
        if (this._closed) {
          return reject(makeNodeError("ERR_USE_AFTER_CLOSE", "readline was closed", Error));
        }
        if (options && options.signal) {
          if (options.signal.aborted) {
            return reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: options.signal.reason }));
          }
          options.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: options.signal.reason }));
          }, { once: true });
        }
        super.question(query, options, (ans) => resolve(ans));
      });
    }
  }

  class ReadlineCommit {
    constructor(stream) {
      this._stream = stream;
    }
    clearLine() { return this; }
    clearScreenDown() { return this; }
    cursorTo() { return this; }
    moveCursor() { return this; }
    commit() { return Promise.resolve(); }
    rollback() { return this; }
  }
  const readlinePromisesMod = {
    Interface: ReadlinePromisesInterface,
    Readline: ReadlineCommit,
    createInterface: (...args) => new ReadlinePromisesInterface(...args),
  };
  builtins["readline"] = {
    Interface: ReadlineInterface,
    createInterface: (...args) => new ReadlineInterface(...args),
    clearLine: (_stream, _dir, cb) => { if (typeof cb === "function") queueMicrotask(cb); return true; },
    clearScreenDown: (_stream, cb) => { if (typeof cb === "function") queueMicrotask(cb); return true; },
    cursorTo: (_stream, _x, _y, cb) => { if (typeof cb === "function") queueMicrotask(cb); return true; },
    moveCursor: (_stream, _dx, _dy, cb) => { if (typeof cb === "function") queueMicrotask(cb); return true; },
    emitKeypressEvents: () => {},
    promises: readlinePromisesMod,
  };
  builtins["readline/promises"] = readlinePromisesMod;

  class TLSSocket extends NetSocket {
    constructor(socket, options = {}) {
      const opts = (socket && typeof socket === "object" && !(socket instanceof NetSocket)) ? socket : (options || {});
      super(opts);
      this._isTLS = true;
      this._tlsOptions = opts;
      this.encrypted = true;
      this.authorized = false;
      this.authorizationError = null;
      this.alpnProtocol = false;
      this._tlsVersion = "TLSv1.3";
      this._cipher = { name: "TLS_AES_128_GCM_SHA256", standardName: "TLS_AES_128_GCM_SHA256", version: "TLSv1.3" };
      this._peerCert = {};
    }
    getPeerCertificate() { return this._peerCert || {}; }
    getProtocol() { return this._tlsVersion || "TLSv1.3"; }
    getCipher() { return this._cipher || { name: "TLS_AES_128_GCM_SHA256", standardName: "TLS_AES_128_GCM_SHA256", version: "TLSv1.3" }; }
  }
  builtins["tls"] = {
    TLSSocket,
    Server: NetServer,
    createServer: (opts, listener) => {
      if (typeof opts === "function") {
        listener = opts;
        opts = {};
      }
      return new NetServer(Object.assign({}, opts, { _isTLS: true }), listener);
    },
    connect: (...args) => {
      const opts = typeof args[0] === "object" && args[0] !== null ? args[0] : (typeof args[1] === "object" && args[1] !== null ? args[1] : {});
      const sock = new TLSSocket(null, opts);
      return sock.connect(...args);
    },
    createSecureContext: (opts) => Object.assign({}, opts),
    createSecurePair: () => ({ cleartext: new Duplex(), encrypted: new Duplex() }),
    checkServerIdentity: () => undefined,
    getCiphers: () => ["tls_aes_128_gcm_sha256", "tls_aes_256_gcm_sha384", "tls_chacha20_poly1305_sha256"],
    CLIENT_RENEG_LIMIT: 3,
    CLIENT_RENEG_WINDOW: 600,
    DEFAULT_CIPHERS: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256",
    DEFAULT_ECDH_CURVE: "auto",
    DEFAULT_MIN_VERSION: "TLSv1.2",
    DEFAULT_MAX_VERSION: "TLSv1.3",
    rootCertificates: [],
  };
  const http2SensitiveHeaders = Symbol("nodejs.http2.sensitiveHeaders");
  builtins["http2"] = {
    Http2ServerRequest: IncomingMessage,
    Http2ServerResponse: ServerResponse,
    sensitiveHeaders: http2SensitiveHeaders,
    getDefaultSettings: () => ({
      headerTableSize: 4096,
      enablePush: true,
      initialWindowSize: 65535,
      maxFrameSize: 16384,
      maxConcurrentStreams: 4294967295,
      maxHeaderListSize: 65535,
      enableConnectProtocol: false,
    }),
    getPackedSettings: () => Buffer.alloc(0),
    getUnpackedSettings: () => ({}),
    performServerHandshake: () => new EventEmitter(),
    constants: {
      HTTP2_HEADER_PATH: ":path",
      HTTP2_HEADER_METHOD: ":method",
      HTTP2_HEADER_STATUS: ":status",
      HTTP2_HEADER_AUTHORITY: ":authority",
      HTTP2_HEADER_SCHEME: ":scheme",
    },
    createServer: (opts, listener) => builtins["http"].createServer(opts, listener),
    createSecureServer: (opts, listener) => builtins["https"].createServer(opts, listener),
    connect: (authority) => {
      const u = new URL(String(authority));
      const ee = new EventEmitter();
      ee.request = (headers = {}) => {
        const method = headers[":method"] || "GET";
        const path = headers[":path"] || "/";
        const outHdrs = {};
        for (const [k, v] of Object.entries(headers)) {
          if (!k.startsWith(":")) outHdrs[k] = v;
        }
        const stream = new Duplex();
        const chunks = [];
        stream._write = (c, enc, cb) => { chunks.push(toBytesInput(c, enc)); cb(); };
        stream._final = (cb) => {
          cb();
          fetch(new URL(path, u).href, {
            method,
            headers: outHdrs,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          }).then(async (res) => {
            const respHdrs = { ":status": res.status };
            for (const [k, v] of res.headers.entries()) respHdrs[k] = v;
            stream.emit("response", respHdrs, 0);
            const b = await res.bytes();
            if (b.byteLength > 0) stream.push(Buffer.from(b));
            stream.push(null);
          }, (err) => stream.destroy(err));
        };
        return stream;
      };
      ee.close = (cb) => { if (typeof cb === "function") queueMicrotask(cb); };
      ee.destroy = () => {};
      queueMicrotask(() => ee.emit("connect", ee));
      return ee;
    },
  };
  class ClusterWorker extends EventEmitter {
    constructor() {
      super();
      this.id = 1;
      this.process = processObj;
    }
    isDead() { return false; }
    isConnected() { return true; }
    disconnect() { this.emit("disconnect"); }
    kill() { this.emit("exit", 0, null); }
    send() { return true; }
  }
  builtins["cluster"] = Object.assign(new EventEmitter(), {
    SCHED_NONE: 1,
    SCHED_RR: 2,
    schedulingPolicy: 2,
    Worker: ClusterWorker,
    isMaster: true,
    isPrimary: true,
    isWorker: false,
    worker: null,
    workers: {},
    settings: {},
    setupPrimary() {},
    setupMaster() {},
    fork() { return new ClusterWorker(); },
    disconnect(cb) { if (typeof cb === "function") queueMicrotask(cb); },
  });

  const activeDgramSockets = new Map();
  class DgramSocket extends EventEmitter {
    constructor(type, listener) {
      super();
      this.type = typeof type === "object" && type ? (type.type || "udp4") : (type || "udp4");
      if (typeof listener === "function") this.on("message", listener);
      this._id = nextAsyncId++;
      this._bound = false;
      this._closed = false;
      this._wantRef = true;
      this._refed = false;
      this._port = 0;
      this._address = this.type === "udp6" ? "::1" : "127.0.0.1";
      this._family = this.type === "udp6" ? "IPv6" : "IPv4";
    }
    bind(port, address, cb) {
      if (typeof port === "function") { cb = port; port = 0; address = undefined; }
      else if (typeof address === "function") { cb = address; address = undefined; }
      else if (port && typeof port === "object") {
        cb = address;
        address = port.address;
        port = port.port;
      }
      if (this._closed) {
        throw makeNodeError("ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running", Error);
      }
      if (this._bound || this._binding) {
        const err = makeNodeError("ERR_SOCKET_ALREADY_BOUND", "Socket is already bound", Error);
        queueMicrotask(() => this.emit("error", err));
        return this;
      }
      this._binding = true;
      if (typeof cb === "function") this.once("listening", cb);
      try {
        const info = JSON.parse(
          hostCall(
            "dgram.bind",
            JSON.stringify({
              id: this._id,
              type: this.type,
              port: Number(port) || 0,
              address: address ? String(address) : "",
            })
          )
        );
        this._port = info.port;
        this._address = info.address;
        this._family = info.family || (this.type === "udp6" ? "IPv6" : "IPv4");
        this._bound = true;
        this._binding = false;
        activeDgramSockets.set(this._id, this);
        if (this._wantRef && !this._refed) {
          this._refed = true;
          incRef();
        }
        queueMicrotask(() => {
          if (!this._closed) this.emit("listening");
        });
      } catch (err) {
        this._binding = false;
        queueMicrotask(() => this.emit("error", err));
      }
      return this;
    }
    send(msg, offset, length, port, address, cb) {
      if (this._closed) {
        throw makeNodeError("ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running", Error);
      }
      let bytes;
      let targetPort;
      let targetAddr;
      let doneCb;
      if (Array.isArray(msg)) {
        bytes = Buffer.concat(msg.map((m) => toBytesInput(m)));
        targetPort = offset;
        targetAddr = typeof length === "string" ? length : undefined;
        doneCb = typeof length === "function" ? length : typeof port === "function" ? port : undefined;
      } else {
        const full = toBytesInput(msg);
        if (typeof offset === "number" && typeof length === "number" && port !== undefined && typeof port !== "function") {
          bytes = full.subarray(offset, offset + length);
          targetPort = port;
          targetAddr = typeof address === "string" ? address : undefined;
          doneCb = typeof address === "function" ? address : typeof cb === "function" ? cb : undefined;
        } else {
          bytes = full;
          targetPort = offset;
          targetAddr = typeof length === "string" ? length : undefined;
          doneCb = typeof length === "function" ? length : typeof port === "function" ? port : undefined;
        }
      }
      const ensureBoundAndSend = () => {
        try {
          if (!this._bound) {
            const info = JSON.parse(
              hostCall(
                "dgram.bind",
                JSON.stringify({
                  id: this._id,
                  type: this.type,
                  port: 0,
                  address: "",
                })
              )
            );
            this._port = info.port;
            this._address = info.address;
            this._family = info.family || (this.type === "udp6" ? "IPv6" : "IPv4");
            this._bound = true;
            activeDgramSockets.set(this._id, this);
            if (this._wantRef && !this._refed) {
              this._refed = true;
              incRef();
            }
          }
          hostCall(
            "dgram.send",
            JSON.stringify({
              id: this._id,
              type: this.type,
              port: Number(targetPort) || 0,
              address: targetAddr ? String(targetAddr) : "",
            }),
            bytes
          );
          if (typeof doneCb === "function") queueMicrotask(() => doneCb(null, bytes.byteLength));
        } catch (err) {
          if (typeof doneCb === "function") queueMicrotask(() => doneCb(err));
          else queueMicrotask(() => this.emit("error", err));
        }
      };
      ensureBoundAndSend();
    }
    address() {
      if (!this._bound) {
        throw makeNodeError("EBADF", "getsockname EBADF", Error);
      }
      return { address: this._address, family: this._family, port: this._port };
    }
    close(cb) {
      if (typeof cb === "function") this.once("close", cb);
      if (this._closed) return this;
      this._closed = true;
      this._bound = false;
      activeDgramSockets.delete(this._id);
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      try { hostCall("dgram.close", String(this._id)); } catch (_) {}
      queueMicrotask(() => this.emit("close"));
      return this;
    }
    ref() {
      this._wantRef = true;
      if (this._bound && !this._closed && !this._refed) {
        this._refed = true;
        incRef();
      }
      return this;
    }
    unref() {
      this._wantRef = false;
      if (this._refed) {
        this._refed = false;
        decRef();
      }
      return this;
    }
  }
  builtins["dgram"] = {
    Socket: DgramSocket,
    createSocket: (type, listener) => new DgramSocket(type, listener),
  };

  const diagChannels = new Map();
  class DiagChannel {
    constructor(name) {
      this.name = String(name);
      this._subs = new Set();
    }
    get hasSubscribers() { return this._subs.size > 0; }
    subscribe(fn) { if (typeof fn === "function") this._subs.add(fn); }
    unsubscribe(fn) { return this._subs.delete(fn); }
    publish(message) {
      for (const fn of this._subs) {
        try { fn(message, this.name); } catch (_) {}
      }
    }
  }
  function getDiagChannel(name) {
    const k = String(name);
    let ch = diagChannels.get(k);
    if (!ch) {
      ch = new DiagChannel(k);
      diagChannels.set(k, ch);
    }
    return ch;
  }
  builtins["diagnostics_channel"] = {
    Channel: DiagChannel,
    channel: getDiagChannel,
    hasSubscribers: (name) => {
      const ch = diagChannels.get(String(name));
      return Boolean(ch && ch.hasSubscribers);
    },
    subscribe: (name, fn) => getDiagChannel(name).subscribe(fn),
    unsubscribe: (name, fn) => getDiagChannel(name).unsubscribe(fn),
    tracingChannel: (nameOrChannels) => {
      const prefix = typeof nameOrChannels === "string" ? nameOrChannels : "trace";
      return {
        start: getDiagChannel(`${prefix}:start`),
        end: getDiagChannel(`${prefix}:end`),
        asyncStart: getDiagChannel(`${prefix}:asyncStart`),
        asyncEnd: getDiagChannel(`${prefix}:asyncEnd`),
        error: getDiagChannel(`${prefix}:error`),
        subscribe() {},
        unsubscribe() {},
        traceSync(fn, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
        tracePromise(fn, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
        traceCallback(fn, _pos, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
      };
    },
  };

  builtins["punycode"] = {
    version: "2.3.1",
    ucs2: {
      decode: (str) => Array.from(String(str), (ch) => ch.codePointAt(0)),
      encode: (arr) => String.fromCodePoint(...arr),
    },
    encode: (input) => {
      const res = punycodeEncodeLabel(String(input));
      return res.startsWith("xn--") ? res.slice(4) : res;
    },
    decode: (input) => punycodeDecodeLabel("xn--" + String(input)),
    toASCII: domainToASCII,
    toUnicode: domainToUnicode,
  };

  const finalBuiltinNames = Object.keys(builtins);
  Module.builtinModules = finalBuiltinNames;
  builtins["module"].builtinModules = finalBuiltinNames;

  // =========================================================================
  // 17. Runtime Event Loop Hooks Called from C/Go
  // =========================================================================

  let nextTickHead = 0;
  function afterMicrotasks(jobsPending) {
    mainModuleObj.loaded = true;
    if (nextTickHead >= nextTickQueue.length) {
      nextTickQueue.length = 0;
      nextTickHead = 0;
      if (!jobsPending && alsRestoreMap.size > 0) {
        for (const [als, old] of alsRestoreMap) {
          als._store = old;
        }
        alsRestoreMap.clear();
      }
      return false;
    }
    while (nextTickHead < nextTickQueue.length) {
      const fn = nextTickQueue[nextTickHead];
      nextTickQueue[nextTickHead] = undefined;
      nextTickHead++;
      if (nextTickHead >= 1024 && nextTickHead * 2 >= nextTickQueue.length) {
        nextTickQueue.splice(0, nextTickHead);
        nextTickHead = 0;
      }
      fn();
    }
    nextTickQueue.length = 0;
    nextTickHead = 0;
    return true;
  }
  globalThis.__qjs_after_microtasks = afterMicrotasks;

  const emittedUnhandledRejections = new WeakSet();
  globalThis.__qjs_unhandled_rejection = function (reason, promise, isHandled) {
    if (isHandled) {
      if (promise && typeof promise === "object" && emittedUnhandledRejections.has(promise)) {
        emittedUnhandledRejections.delete(promise);
        processObj.nextTick(() => {
          processObj.emit("rejectionHandled", promise);
        });
        return true;
      }
      return false;
    }
    if (processObj.listenerCount("unhandledRejection") > 0) {
      if (promise && typeof promise === "object") {
        emittedUnhandledRejections.add(promise);
      }
      processObj.emit("unhandledRejection", reason, promise);
      return true;
    }
    return false;
  };

  function handleUncaughtException(err) {
    if (typeof uncaughtExceptionCaptureCb === "function") {
      uncaughtExceptionCaptureCb(err);
      return true;
    }
    if (processObj.listenerCount("uncaughtException") > 0) {
      processObj.emit("uncaughtException", err, "uncaughtException");
      return true;
    }
    return false;
  }
  globalThis.__qjs_uncaught_exception = handleUncaughtException;

  function flushDueTimers(triggered) {
    const now = Date.now();
    const due = [];
    for (const tm of timersMap.values()) {
      if (!tm._cleared && (tm === triggered || tm._deadline <= now)) {
        due.push(tm);
      }
    }
    if (due.length === 0) return;
    due.sort((a, b) => (a._isImmediate !== b._isImmediate ? (a._isImmediate ? -1 : 1) : 0) || (a._deadline - b._deadline) || (a._seq - b._seq));
    let fired = false;
    for (let i = 0; i < due.length; i++) {
      const t = due[i];
      if (t._cleared || !timersMap.has(t._id)) continue;
      if (!fired) {
        fired = true;
        if (t._isInterval) {
          t.refresh();
          t._fn(...t._args);
        } else {
          t._clear();
          t._fn(...t._args);
        }
      } else {
        try {
          hostCall("timer.start", JSON.stringify({ id: t._id, delayMs: 0 }));
        } catch (_) {}
        break;
      }
    }
  }

  globalThis.__qjs_dispatch = function (id, kind, jsonStr, binData) {
    switch (kind) {
      case 1: { // rtEventTimer
        const triggered = timersMap.get(id);
        if (!triggered || triggered._cleared) return;
        flushDueTimers(triggered);
        break;
      }
      case 2: { // rtEventFetch
        const entry = pendingFetches.get(id);
        if (!entry) return;
        const meta = jsonStr ? JSON.parse(jsonStr) : {};
        if (meta.phase === "write_drain") {
          if (typeof entry.onWriteDrain === "function") {
            entry.onWriteDrain();
          }
          break;
        }
        if (meta.phase === "headers") {
          entry.releaseHeaderRef();
          const isNullBody = !entry.rawHttp && (entry.method === "HEAD" || meta.status === 204 || meta.status === 205 || meta.status === 304);
          const resp = new Response(null, {
            _fromFetch: true,
            _rawHeaders: meta.rawHeaders,
            _streaming: !isNullBody,
            _onCancel: entry.cancelFetch,
            _onPull: () => {
              try {
                hostCall("http.pullFetch", String(id));
              } catch (_) {}
            },
            _onWaitStart: () => incRef(),
            _onWaitEnd: () => decRef(),
            status: meta.status,
            statusText: meta.statusText,
            headers: meta.headers,
            url: meta.url,
            redirected: meta.redirected,
          });
          resp._httpVersion = meta.httpVersion || "1.1";
          resp._httpVersionMajor = meta.httpVersionMajor !== undefined ? meta.httpVersionMajor : 1;
          resp._httpVersionMinor = meta.httpVersionMinor !== undefined ? meta.httpVersionMinor : 1;
          resp._remoteAddress = meta.remoteAddress || "";
          resp._remotePort = meta.remotePort || 0;
          resp._remoteFamily = meta.remoteFamily || "";
          resp._localAddress = meta.localAddress || "";
          resp._localPort = meta.localPort || 0;
          entry.resp = resp;
          entry.headersResolved = true;
          entry.resolve(resp);
          break;
        }
        if (meta.phase === "chunk") {
          if (entry.resp && entry.resp._streamCtrl && binData && binData.byteLength > 0) {
            entry.resp._streamCtrl.enqueue(new Uint8Array(binData.buffer, binData.byteOffset, binData.byteLength));
          }
          break;
        }
        if (meta.phase === "end") {
          pendingFetches.delete(id);
          if (entry.cleanup) entry.cleanup();
          entry.releaseHeaderRef();
          if (entry.resp) {
            if (meta.trailers && typeof meta.trailers === "object") {
              entry.resp._trailers = meta.trailers;
            }
            if (Array.isArray(meta.rawTrailers)) {
              entry.resp._rawTrailers = meta.rawTrailers;
            }
            if (entry.resp._streamCtrl) {
              entry.resp._streamCtrl.close();
            }
          }
          break;
        }
        // error or legacy single-shot
        pendingFetches.delete(id);
        if (entry.cleanup) entry.cleanup();
        entry.releaseHeaderRef();
        if (meta.error) {
          const err = new TypeError("fetch failed");
          err.cause = classifyNetworkError(meta.error);
          if (entry.headersResolved && entry.resp && entry.resp._streamCtrl) {
            entry.resp._streamCtrl.error(err);
          } else {
            entry.reject(err);
          }
        } else {
          const resp = new Response(binData || new Uint8Array(0), {
            _fromFetch: true,
            _rawHeaders: meta.rawHeaders,
            status: meta.status,
            statusText: meta.statusText,
            headers: meta.headers,
            url: meta.url,
            redirected: meta.redirected,
          });
          resp._httpVersion = meta.httpVersion || "1.1";
          resp._httpVersionMajor = meta.httpVersionMajor !== undefined ? meta.httpVersionMajor : 1;
          resp._httpVersionMinor = meta.httpVersionMinor !== undefined ? meta.httpVersionMinor : 1;
          entry.resolve(resp);
        }
        break;
      }
      case 3: { // rtEventChildStdout
        const cp = activeChildren.get(id);
        if (cp && cp.stdout && binData) {
          const chunk = new Buffer(binData.buffer, binData.byteOffset, binData.byteLength);
          const unconsumed = !cp.stdout._isFlowing() && cp.stdout.listenerCount("readable") === 0 && !cp.stdout._pausedExplicitly;
          if (unconsumed && cp.stdout.readableLength >= 1024 * 1024) {
            if (typeof cp.stdout._onPull === "function") cp.stdout._onPull(1);
          } else {
            cp.stdout.push(chunk);
            if (unconsumed && typeof cp.stdout._onPull === "function") {
              cp.stdout._onPull(1);
            }
          }
        }
        break;
      }
      case 4: { // rtEventChildStderr
        const cp = activeChildren.get(id);
        if (cp && cp.stderr && binData) {
          const chunk = new Buffer(binData.buffer, binData.byteOffset, binData.byteLength);
          const unconsumed = !cp.stderr._isFlowing() && cp.stderr.listenerCount("readable") === 0 && !cp.stderr._pausedExplicitly;
          if (unconsumed && cp.stderr.readableLength >= 1024 * 1024) {
            if (typeof cp.stderr._onPull === "function") cp.stderr._onPull(1);
          } else {
            cp.stderr.push(chunk);
            if (unconsumed && typeof cp.stderr._onPull === "function") {
              cp.stderr._onPull(1);
            }
          }
        }
        break;
      }
      case 5: { // rtEventChildExit
        const cp = activeChildren.get(id);
        if (!cp) return;
        activeChildren.delete(id);
        cp._closed = true;
        cp.unref();
        const meta = jsonStr ? JSON.parse(jsonStr) : { code: 0, signal: null };
        cp.exitCode = meta.code;
        cp.signalCode = meta.signal || null;
        if (cp.signalCode) cp.killed = true;
        cp.emit("exit", cp.exitCode, cp.signalCode);
        if (cp.stdout) cp.stdout.push(null);
        if (cp.stderr) cp.stderr.push(null);
        queueMicrotask(() => {
          cp.emit("close", cp.exitCode, cp.signalCode);
        });
        break;
      }
      case 6: { // rtEventHTTPRequest
        const meta = JSON.parse(jsonStr);
        if (meta.aborted) {
          const entry = activeServerReqs.get(meta.reqId);
          if (entry) {
            activeServerReqs.delete(meta.reqId);
            entry.res._respondedDone = true;
            entry.res.destroyed = true;
            entry.req.destroyed = true;
            if (entry.req.socket) entry.req.socket.destroyed = true;
            entry.res._releaseReq();
            entry.req.aborted = true;
            entry.req.emit("aborted");
            entry.req.emit("close");
            if (!entry.res._closeEmitted) {
              entry.res._closeEmitted = true;
              entry.res.emit("close");
            }
          }
          break;
        }
        if (meta.phase === "body") {
          const entry = activeServerReqs.get(meta.reqId);
          if (entry && entry.req && !entry.req.destroyed && binData && binData.byteLength > 0) {
            entry.req.push(new Buffer(binData.buffer, binData.byteOffset, binData.byteLength));
          }
          break;
        }
        if (meta.phase === "end") {
          const entry = activeServerReqs.get(meta.reqId);
          if (entry && entry.req && !entry.req.destroyed) {
            if (meta.trailers && typeof meta.trailers === "object") {
              Object.assign(entry.req.trailers, meta.trailers);
            }
            if (Array.isArray(meta.rawTrailers) && meta.rawTrailers.length > 0) {
              entry.req.rawTrailers.push(...meta.rawTrailers);
            }
            entry.req.push(null);
          }
          break;
        }
        if (meta.phase === "drain") {
          const entry = activeServerReqs.get(meta.reqId);
          if (entry && entry.res && entry.res._backpressured && !entry.res.destroyed && !entry.res.writableEnded) {
            entry.res._backpressured = false;
            entry.res._needDrain = false;
            entry.res.emit("drain");
          }
          break;
        }
        const srv = activeServers.get(id);
        if (!srv) return;
        const req = new IncomingMessage(meta, binData, !meta.bodyComplete);
        if (!meta.bodyComplete) {
          req._onPull = (n) => {
            if (!req.destroyed && !req.complete) {
              try {
                hostCall("http.pullRequest", JSON.stringify({ serverId: id, reqId: meta.reqId, n: n || 1 }));
              } catch (_) {}
            }
          };
        }
        const res = new ServerResponse(id, meta.reqId, srv);
        res.socket = req.socket;
        res.connection = req.socket;
        req._serverRes = res;
        activeServerReqs.set(meta.reqId, { req, res });
        srv.emit("request", req, res);
        break;
      }
      case 7: { // rtEventNetConnect
        const meta = jsonStr ? JSON.parse(jsonStr) : {};
        if (meta.connId) {
          // Server accepted incoming connection
          const srv = activeNetListeners.get(id);
          if (!srv) {
            try { hostCall("net.closeConn", JSON.stringify({ id: meta.connId, destroy: true })); } catch (_) {}
            return;
          }
          const sockOpts = {
            _id: meta.connId,
            remoteAddress: meta.remoteAddress,
            remotePort: meta.remotePort,
            localAddress: meta.localAddress,
            localPort: meta.localPort,
            allowHalfOpen: Boolean(srv._options && srv._options.allowHalfOpen),
          };
          const sock = meta.tls ? new TLSSocket(null, sockOpts) : new NetSocket(sockOpts);
          if (meta.tls) {
            sock.authorized = Boolean(meta.authorized);
            sock.authorizationError = meta.authorizationError || null;
            sock.alpnProtocol = meta.alpnProtocol || false;
            if (meta.tlsVersion) sock._tlsVersion = meta.tlsVersion;
            if (meta.cipher) sock._cipher = meta.cipher;
            if (meta.peerCert) sock._peerCert = meta.peerCert;
          }
          sock._refed = true;
          incRef();
          activeNetSockets.set(meta.connId, sock);
          srv._connections.add(sock);
          sock.once("close", () => {
            srv._connections.delete(sock);
            if (srv._closing && srv._connections.size === 0) {
              srv._finishClose();
            }
          });
          srv.emit("connection", sock);
          if (meta.tls) {
            srv.emit("secureConnection", sock);
          }
        } else {
          // Client socket connected
          const sock = activeNetSockets.get(id);
          if (!sock) {
            if (!meta.error) {
              try { hostCall("net.closeConn", JSON.stringify({ id, destroy: true })); } catch (_) {}
            }
            return;
          }
          sock.connecting = false;
          if (meta.error) {
            sock._clearTimeout();
            const pendingQ = sock._pendingConnectQueue ? sock._pendingConnectQueue.splice(0) : [];
            activeNetSockets.delete(id);
            if (sock._refed) {
              sock._refed = false;
              decRef();
            }
            const connErr = classifyNetworkError(meta.error, "ECONNREFUSED");
            if (!connErr.syscall) connErr.syscall = "connect";
            sock.destroyed = true;
            for (const fn of pendingQ) {
              try { fn(connErr); } catch (_) {}
            }
            sock.emit("error", connErr);
            sock._closeEmitted = true;
            sock.emit("close", true);
          } else {
            sock._resetTimeout();
            sock.remoteAddress = meta.remoteAddress;
            sock.remotePort = meta.remotePort;
            sock.remoteFamily = meta.remoteAddress && meta.remoteAddress.includes(":") ? "IPv6" : "IPv4";
            sock.localAddress = meta.localAddress;
            sock.localPort = meta.localPort;
            if (sock._isTLS) {
              sock.authorized = Boolean(meta.authorized);
              sock.authorizationError = meta.authorizationError || null;
              sock.alpnProtocol = meta.alpnProtocol || false;
              if (meta.tlsVersion) sock._tlsVersion = meta.tlsVersion;
              if (meta.cipher) {
                sock._cipher = meta.cipher;
              } else if (meta.cipherName) {
                sock._cipher = {
                  name: meta.cipherName,
                  standardName: meta.cipherName,
                  version: meta.tlsVersion || "TLSv1.3",
                };
              }
              if (meta.peerCert) sock._peerCert = meta.peerCert;
            }
            sock.emit("connect");
            if (sock._isTLS) sock.emit("secureConnect");
            sock.emit("ready");
            if (sock._pendingConnectQueue && sock._pendingConnectQueue.length > 0) {
              const q = sock._pendingConnectQueue.splice(0);
              for (const fn of q) fn(null);
            }
          }
        }
        break;
      }
      case 8: { // rtEventNetData
        const sock = activeNetSockets.get(id);
        if (sock && binData) {
          sock._resetTimeout();
          sock.bytesRead += binData.byteLength;
          sock.push(new Buffer(binData.buffer, binData.byteOffset, binData.byteLength));
        }
        break;
      }
      case 9: { // rtEventNetClose
        const sock = activeNetSockets.get(id);
        if (!sock) return;
        sock._clearTimeout();
        const meta = jsonStr ? JSON.parse(jsonStr) : {};
        if (meta.eof && !sock.destroyed) {
          sock._remoteEOF = true;
          if (sock.writableEnded) {
            activeNetSockets.delete(id);
            if (sock._refed) {
              sock._refed = false;
              decRef();
            }
            try {
              hostCall("net.closeConn", JSON.stringify({ id, halfClose: false }));
            } catch (_) {}
          }
          sock.push(null);
          if (!sock.allowHalfOpen && sock.listenerCount("data") === 0 && sock.listenerCount("readable") === 0) {
            sock.resume();
          }
          queueMicrotask(() => {
            if (!sock.allowHalfOpen && !sock.writableEnded && !sock.destroyed) {
              sock.end();
            } else if (sock.writableFinished && !sock._closeEmitted) {
              sock._closeEmitted = true;
              sock.emit("close", false);
            }
          });
          break;
        }
        activeNetSockets.delete(id);
        if (sock._refed) {
          sock._refed = false;
          decRef();
        }
        sock.writableEnded = true;
        sock.writableFinished = true;
        sock.push(null);
        const netErr = meta.error && !sock.destroyed ? classifyNetworkError(meta.error, "ECONNRESET") : null;
        if (netErr) {
          sock.destroyed = true;
          if (!netErr.syscall) netErr.syscall = "read";
          sock.emit("error", netErr);
        }
        queueMicrotask(() => {
          if (!sock._closeEmitted) {
            sock._closeEmitted = true;
            sock.emit("close", Boolean(meta.error));
          }
        });
        break;
      }
      case 10: { // rtEventWorkerMessage
        if (id > 0) {
          const w = activeWorkers.get(id) || activeForks.get(id);
          if (!w) break;
          if (jsonStr === "eof") {
            if (activeForks.has(id) && w.connected) {
              w.connected = false;
              w.emit("disconnect");
            }
            break;
          }
          if (!binData || binData.byteLength === 0) break;
          try {
            const msg = v8Deserialize(new Buffer(binData.buffer, binData.byteOffset, binData.byteLength));
            if (msg && typeof msg === "object" && msg.__indirectWorkerCleanExit === true && activeWorkers.has(id)) {
              w._cleanExit = true;
              break;
            }
            if (msg && typeof msg === "object" && typeof msg.__indirectBC === "string" && activeWorkers.has(id)) {
              deliverBroadcastChannelLocal(msg.__indirectBC, msg.data, null);
              const wire = new Buffer(binData.buffer, binData.byteOffset, binData.byteLength);
              for (const [otherId, ow] of activeWorkers.entries()) {
                if (otherId !== id && !ow._exited) {
                  try { hostCall("worker.send", String(otherId), wire); } catch (_) {}
                }
              }
              break;
            }
            w.emit("message", msg);
          } catch (_) {}
          break;
        }
        if (isForkChild) {
          if (jsonStr === "eof") {
            if (forkIpcRefed) {
              forkIpcRefed = false;
              decRef();
            }
            if (processObj.connected) {
              processObj.connected = false;
              processObj.emit("disconnect");
            }
            break;
          }
          if (binData && binData.byteLength > 0) {
            try {
              const msg = v8Deserialize(new Buffer(binData.buffer, binData.byteOffset, binData.byteLength));
              processObj.emit("message", msg);
            } catch (_) {}
          }
          break;
        }
        if (!workerParentPort) break;
        if (jsonStr === "eof") {
          workerParentPort.unref();
          break;
        }
        if (binData && binData.byteLength > 0) {
          try {
            const msg = v8Deserialize(new Buffer(binData.buffer, binData.byteOffset, binData.byteLength));
            if (msg && typeof msg === "object" && typeof msg.__indirectBC === "string") {
              deliverBroadcastChannelLocal(msg.__indirectBC, msg.data, null);
              break;
            }
            workerParentPort.emit("message", msg);
          } catch (_) {}
        }
        break;
      }
      case 11: { // rtEventStdinData
        if (binData && binData.byteLength > 0 && processObj.stdin && typeof processObj.stdin._onAsyncChunk === "function") {
          const buf = new Buffer(binData.buffer, binData.byteOffset, binData.byteLength);
          processObj.stdin._onAsyncChunk(buf);
        }
        break;
      }
      case 12: { // rtEventStdinEnd
        if (processObj.stdin && typeof processObj.stdin._onAsyncEnd === "function") {
          processObj.stdin._onAsyncEnd();
        }
        break;
      }
      case 13: { // rtEventChildDrain
        const cp = activeChildren.get(id);
        if (cp && cp.stdin && cp.stdin._backpressured) {
          cp.stdin._backpressured = false;
          cp.stdin._needDrain = false;
          cp.stdin.emit("drain");
        }
        break;
      }
      case 14: { // rtEventNetDrain
        const sock = activeNetSockets.get(id);
        if (sock && sock._backpressured) {
          sock._backpressured = false;
          sock._needDrain = false;
          sock.emit("drain");
        }
        break;
      }
      case 15: { // rtEventDgramMessage
        const sock = activeDgramSockets.get(id);
        if (!sock || sock._closed) break;
        const rinfo = jsonStr ? JSON.parse(jsonStr) : { address: "127.0.0.1", family: "IPv4", port: 0, size: 0 };
        const buf = binData ? new Buffer(binData.buffer, binData.byteOffset, binData.byteLength) : Buffer.alloc(0);
        sock.emit("message", buf, rinfo);
        break;
      }
      case 16: { // rtEventAsyncOp
        flushDueTimers(null);
        const entry = pendingAsyncOps.get(id);
        if (!entry) break;
        pendingAsyncOps.delete(id);
        if (entry.cleanup) entry.cleanup();
        decRef();
        const meta = jsonStr ? JSON.parse(jsonStr) : {};
        if (meta.errMsg || meta.errCode) {
          const msg = meta.errMsg || meta.errCode;
          let err;
          if (meta.errCode === "ERR_INVALID_ARG_TYPE" || meta.errCode === "ERR_INVALID_ARG_VALUE" || meta.errCode === "ERR_INVALID_IP_ADDRESS") {
            err = new TypeError(msg);
          } else if (meta.errCode === "ERR_OUT_OF_RANGE") {
            err = new RangeError(msg);
          } else {
            err = new Error(msg);
          }
          if (meta.errCode) err.code = meta.errCode;
          enrichHostError(err);
          entry.reject(err);
        } else if (meta.isBin) {
          entry.resolve(binData || new Uint8Array(0));
        } else {
          entry.resolve(meta.str !== undefined ? meta.str : "");
        }
        break;
      }
    }
  };

  globalThis.__qjs_check_loop = function (phase, unsettled) {
    if (phase === 0) {
      return activeRefs > 0 || nextTickQueue.length > 0 ? 1 : 0;
    }
    if (phase === 1) {
      processObj.emit("beforeExit", procExitCode !== undefined ? (procExitCode | 0) : 0);
      afterMicrotasks();
      return activeRefs > 0 || nextTickQueue.length > 0 ? 1 : 0;
    }
    if (phase === 2) {
      if (unsettled && procExitCode === undefined) {
        procExitCode = 13;
        try {
          processObj.stderr.write("Warning: Detected unsettled top-level await\n");
        } catch (_) {}
      }
      const code = procExitCode !== undefined ? (procExitCode | 0) : 0;
      if (!inProcessExit) {
        inProcessExit = true;
        try {
          processObj.emit("exit", code);
        } catch (err) {
          procExitCode = 1;
          try {
            processObj.stderr.write(((err && err.stack) || String(err)) + "\n");
          } catch (_) {}
        }
      }
      const finalCode = procExitCode !== undefined ? (procExitCode | 0) : 0;
      if (finalCode !== 0 && !unsettled && init.env && init.env.__INDIRECT_WORKER_THREAD_ID) {
        try {
          hostCall("worker.send", "0", v8Serialize({ __indirectWorkerCleanExit: true }));
          hostCall("worker.close", "0");
        } catch (_) {}
      }
      return finalCode;
    }
    return 0;
  };
})();
