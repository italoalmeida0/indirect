import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";

function getAllFiles(dir: string, ext = [".ts", ".tsx", ".css"]): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry).replace(/\\/g, "/");
    if (entry === "node_modules" || entry === "dist") continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...getAllFiles(full, ext));
    } else if (ext.some((e) => full.endsWith(e))) {
      files.push(full);
    }
  }
  return files;
}

const files = [
  ...getAllFiles("web/src"),
  "web/style.tailwindcss.css",
];

// Files where raw color definitions or font declarations or markdown parity live by design
const HEX_ALLOWLIST = new Set([
  "web/src/ds/tokens.css",
  "web/src/fonts.css",
  "web/style.tailwindcss.css",
  "web/src/ui.tsx", // <meta name="theme-color"> browser chrome hex values
]);

const PARITY_ALLOWLIST = new Set([
  "web/src/indirect-code/components/TarnavMarkdown.tsx", // streaming-markdown DOM/CSS parity
]);

// Specific lines preserved for existing unit test source-string assertions
const TEST_CONTRACT_SUBSTRINGS = [
  "html[data-theme=\"high-contrast\"]",
  "--color-surface: #000000",
  "--color-card: #0a0a0a",
  "--color-elev: #141414",
  "--color-line: #404040",
  "--color-ink-50: #ffffff",
  "--color-ink-100: #ffffff",
  "--color-ink-200: #f5f5f5",
  "--color-ink-300: #e5e5e5",
  "--color-ink-400: #d4d4d4",
  "--color-ink-500: #a3a3a3",
  "text-[10px] text-ink-500 transition-opacity",
];

const RAW_PALETTE_RE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:emerald|rose|amber|sky|blue|purple|teal|indigo|pink|violet|green|orange|red|yellow|cyan|fuchsia|lime|slate|gray|zinc|stone)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

const HEAVY_FONT_RE = /\bfont-(?:semibold|bold|extrabold|black)\b/g;
const UPPERCASE_CLASS_RE = /\buppercase\b/g;
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;

interface Violation {
  file: string;
  line: number;
  rule: string;
  match: string;
  snippet: string;
}

const violations: Violation[] = [];

// Collect all defined CSS custom properties (--name:) or inline style assignments ("--name":)
const definedCssVars = new Set<string>(["--ag-secondary-foreground-color", "--ag-grid-size"]);
for (const file of files) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  for (const m of content.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
    definedCssVars.add(m[1]!);
  }
  for (const m of content.matchAll(/["'](--[a-zA-Z0-9_-]+)["']\s*:/g)) {
    definedCssVars.add(m[1]!);
  }
  for (const m of content.matchAll(/setProperty\(\s*["'](--[a-zA-Z0-9_-]+)["']/g)) {
    definedCssVars.add(m[1]!);
  }
}

for (const file of files) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    const trimmed = lineText.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }
    if (TEST_CONTRACT_SUBSTRINGS.some((sub) => lineText.includes(sub))) {
      continue;
    }

    // 1. Raw Tailwind palette classes
    for (const m of lineText.matchAll(RAW_PALETTE_RE)) {
      violations.push({
        file,
        line: i + 1,
        rule: "raw-tailwind-palette",
        match: m[0],
        snippet: trimmed.slice(0, 100),
      });
    }

    // 2. Heavy font weights (only in TS/TSX)
    if ((file.endsWith(".ts") || file.endsWith(".tsx")) && !PARITY_ALLOWLIST.has(file)) {
      for (const m of lineText.matchAll(HEAVY_FONT_RE)) {
        violations.push({
          file,
          line: i + 1,
          rule: "heavy-font-weight",
          match: m[0],
          snippet: trimmed.slice(0, 100),
        });
      }

      // 3. Uppercase class in JSX class attributes
      if (lineText.includes("class=") || lineText.includes("class:`") || lineText.includes("class: `")) {
        for (const m of lineText.matchAll(UPPERCASE_CLASS_RE)) {
          violations.push({
            file,
            line: i + 1,
            rule: "uppercase-utility",
            match: m[0],
            snippet: trimmed.slice(0, 100),
          });
        }
      }
    }

    // 4. Hardcoded hex colors outside token files
    if (!HEX_ALLOWLIST.has(file)) {
      for (const m of lineText.matchAll(HEX_COLOR_RE)) {
        // Ignore URL anchors like #/keys or #section or HTML character entity refs (&#123;)
        const idx = m.index ?? 0;
        const prevChar = idx > 0 ? lineText[idx - 1] : "";
        if (prevChar === "/" || prevChar === "&" || (prevChar === "\"" && lineText.slice(idx).startsWith("#/"))) continue;
        violations.push({
          file,
          line: i + 1,
          rule: "hardcoded-hex",
          match: m[0],
          snippet: trimmed.slice(0, 100),
        });
      }
    }

    // 5. Undefined CSS custom properties: var(--foo) without fallback or declaration
    for (const m of lineText.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g)) {
      const varName = m[1]!;
      const sep = m[2]!;
      if (sep === ")" && !definedCssVars.has(varName)) {
        violations.push({
          file,
          line: i + 1,
          rule: "undefined-css-var",
          match: `var(${varName})`,
          snippet: trimmed.slice(0, 100),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`\n❌ Found ${violations.length} design-system hygiene violation(s):`);
  for (const v of violations.slice(0, 120)) {
    console.error(`  - ${v.file}:${v.line} [${v.rule}] "${v.match}" -> ${v.snippet}`);
  }
  if (violations.length > 120) {
    console.error(`  ... and ${violations.length - 120} more.`);
  }
  process.exit(1);
} else {
  console.log(`✓ Design token & typography hygiene check passed (${files.length} files scanned).`);
}
