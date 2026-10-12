import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

// Regression: `html.mobile` (web/index.html) is the SINGLE source of truth for
// "is this a phone/tablet" — sidebar layout (IndirectCodePage), hover
// affordances (ui.tsx) and tooltips (presentation.tsx) all read the same flag.
// The detection is UA-based (Chrome's pointer flags became unreliable):
//   - iOS incl. modern iPad (reports a "Macintosh" UA since iPadOS 13 —
//     caught by maxTouchPoints > 1) and Android;
//   - touch present;
//   - window.innerWidth <= 768 (documented semantics: landscape phones and
//     landscape iPads exceed 768 and get the desktop layout).
// The UA gate is what protects touch laptops: the flag can never be true on
// Windows/macOS hardware regardless of width, touch or pointer reporting.
//
// This test EXECUTES the real inline script from web/index.html against
// device fingerprints — the code under test is the shipped script itself.

const html = readFileSync(path.join(import.meta.dir, "../web/index.html"), "utf-8");
const scriptMatch = html.match(/<script>\s*\/\/ Touch-device flag[\s\S]*?<\/script>/);
if (!scriptMatch) throw new Error("web/index.html: pre-paint touch flag script not found");
const scriptSource = scriptMatch[0].replace(/^<script>/, "").replace(/<\/script>$/, "");

type Device = {
  name: string;
  ua: string;
  touch: boolean;
  innerWidth: number;
  expectMobile: boolean;
  note?: string;
};

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"; // modern iPad
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEVICES: Device[] = [
  { name: "iPhone portrait", ua: IPHONE_UA, touch: true, innerWidth: 390, expectMobile: true },
  { name: "iPhone landscape", ua: IPHONE_UA, touch: true, innerWidth: 844, expectMobile: false, note: "innerWidth semantics: landscape = desktop layout" },
  { name: "Android phone portrait", ua: ANDROID_UA, touch: true, innerWidth: 412, expectMobile: true },
  { name: "Android phone landscape", ua: ANDROID_UA, touch: true, innerWidth: 915, expectMobile: false, note: "innerWidth semantics: landscape = desktop layout" },
  { name: "iPad modern portrait (Macintosh UA, maxTouchPoints 5)", ua: IPAD_UA, touch: true, innerWidth: 768, expectMobile: true },
  { name: "iPad landscape", ua: IPAD_UA, touch: true, innerWidth: 1024, expectMobile: false, note: "innerWidth semantics" },
  { name: "Windows touch laptop 1366x768", ua: WIN_UA, touch: true, innerWidth: 1366, expectMobile: false, note: "the regression" },
  { name: "Windows touch laptop narrow window (700px)", ua: WIN_UA, touch: true, innerWidth: 700, expectMobile: false, note: "UA gate: never mobile on Windows hardware" },
  { name: "macOS desktop", ua: MAC_UA, touch: false, innerWidth: 1920, expectMobile: false },
  { name: "desktop small window", ua: MAC_UA, touch: false, innerWidth: 700, expectMobile: false },
];

// Persistent stub: the script writes the class, consumers read it.
const classes = new Set<string>();
let device: Device = DEVICES[0];

beforeAll(() => {
  const root = globalThis as Record<string, unknown>;
  const matchMedia = () => ({ matches: false }); // pointer flags are not used anymore
  root.window = {
    get innerWidth() { return device.innerWidth; },
    matchMedia,
    addEventListener: () => {},
  };
  root.navigator = {
    get userAgent() { return device.ua; },
    get maxTouchPoints() { return device.touch ? (device.ua.includes("Macintosh") ? 5 : 1) : 0; },
  };
  root.matchMedia = matchMedia;
  root.document = {
    documentElement: {
      classList: {
        contains: (c: string) => classes.has(c),
        toggle: (c: string, v: boolean) => {
          if (v) classes.add(c);
          else classes.delete(c);
        },
      },
    },
  };
});

function runFlag(d: Device): boolean {
  device = d;
  classes.clear();
  eval(scriptSource);
  return classes.has("mobile");
}

describe("html.mobile — real script from web/index.html (UA + touch + width)", () => {
  for (const d of DEVICES) {
    test(`${d.name} -> ${d.expectMobile ? "mobile" : "desktop"}${d.note ? ` (${d.note})` : ""}`, () => {
      expect(runFlag(d)).toBe(d.expectMobile);
    });
  }

  test("flag is the single source: layout predicate reads the same class", () => {
    // IndirectCodePage's isMobile, ui.tsx and presentation.tsx all read
    // documentElement.classList.contains("mobile") — never window width.
    runFlag(DEVICES[6]); // Windows touch laptop: desktop
    expect(classes.has("mobile")).toBe(false);
    runFlag(DEVICES[0]); // iPhone: mobile
    expect(classes.has("mobile")).toBe(true);
  });
});
