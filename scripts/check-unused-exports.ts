import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";

// Entry points / public module boundaries where exports are expected to be available
const IGNORED_EXPORT_FILES = new Set([
  "server/index.ts",
  "web/src/index.tsx",
  "web/src/boot.tsx",
]);

function getAllFiles(dir: string, ext = [".ts", ".tsx"]): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry).replaceAll("\\", "/");
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "data" ||
      entry === ".git" ||
      entry === "indirect-code-daemon" ||
      entry === "tmp"
    ) {
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...getAllFiles(full, ext));
    } else if (ext.some((e) => full.endsWith(e))) {
      files.push(full);
    }
  }
  return files;
}

const prodFiles = [...getAllFiles("server"), ...getAllFiles("web/src")];
const testFiles = getAllFiles("test");
const allScriptFiles = getAllFiles("scripts");
// Operator/build/bench scripts legitimately invoke production helpers;
// `scripts/test-*.ts` are browser/e2e test suites and count as test-only callers.
const testScriptFiles = allScriptFiles.filter((f) => /(?:^|\/)test-[^/]+$/.test(f));
const prodScriptFiles = allScriptFiles.filter((f) => !/(?:^|\/)test-[^/]+$/.test(f));

interface ExportItem {
  file: string;
  name: string;
  kind: string;
  line: number;
  isTestHook: boolean;
}

// Regex to capture top-level named exports:
// export (async) function foo / export const foo / export let foo / export type foo / export interface foo / export class foo
const exportRegex = /^export\s+(?:async\s+)?(function|const|let|var|type|interface|class)\s+([A-Za-z0-9_$]+)/gm;

const allExports: ExportItem[] = [];

for (const file of prodFiles) {
  if (IGNORED_EXPORT_FILES.has(file) || file.endsWith(".d.ts")) continue;
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  let match;
  exportRegex.lastIndex = 0;
  while ((match = exportRegex.exec(content)) !== null) {
    const kind = match[1]!;
    const name = match[2]!;
    const line = content.slice(0, match.index).split("\n").length;
    // Allow explicit `@test-hook` annotation in the preceding docblock/comment
    // (within 6 lines above the export) for intentional test observability/reset hooks.
    const leadingContext = lines.slice(Math.max(0, line - 7), line).join("\n");
    const isTestHook = /@test-hook\b/.test(leadingContext);
    allExports.push({ file, name, kind, line, isTestHook });
  }
}

// Pre-read all file contents into memory once for speed
const prodContents = prodFiles.map((file) => ({ file, content: readFileSync(file, "utf8") }));
const prodScriptContents = prodScriptFiles.map((file) => ({ file, content: readFileSync(file, "utf8") }));
const testContents = [...testFiles, ...testScriptFiles].map((file) => ({ file, content: readFileSync(file, "utf8") }));

const deadExports: ExportItem[] = [];
const testOnlyDeadExports: ExportItem[] = [];

for (const exp of allExports) {
  const wordRegex = new RegExp(`\\b${exp.name}\\b`, "g");
  let prodUses = 0;

  for (const { file, content } of prodContents) {
    const count = (content.match(wordRegex) || []).length;
    if (file === exp.file) {
      // 1 occurrence is the declaration itself. Any additional occurrence is a local prod use.
      if (count > 1) prodUses += count - 1;
    } else {
      prodUses += count;
    }
    if (prodUses > 0) break;
  }

  if (prodUses === 0) {
    for (const { content } of prodScriptContents) {
      if (wordRegex.test(content)) {
        prodUses++;
        break;
      }
    }
  }

  if (prodUses > 0) continue;

  let testUses = 0;
  for (const { content } of testContents) {
    wordRegex.lastIndex = 0;
    if (wordRegex.test(content)) {
      testUses++;
      break;
    }
  }

  if (testUses === 0) {
    deadExports.push(exp);
  } else if (!exp.isTestHook) {
    testOnlyDeadExports.push(exp);
  }
}

let failed = false;
if (deadExports.length > 0) {
  failed = true;
  console.error(`\n❌ Found ${deadExports.length} dead export(s) with zero usages in the repository:`);
  for (const d of deadExports) {
    console.error(`  - ${d.file}:${d.line} (${d.kind} ${d.name})`);
  }
}

if (testOnlyDeadExports.length > 0) {
  failed = true;
  console.error(
    `\n❌ Found ${testOnlyDeadExports.length} test-only dead export(s) (referenced only by tests, never by production code):`,
  );
  for (const d of testOnlyDeadExports) {
    console.error(`  - ${d.file}:${d.line} (${d.kind} ${d.name})`);
  }
  console.error("  Remove dead production code (migrate tests to the live code), or tag intentional hooks with @test-hook.");
}

if (failed) {
  console.error("\nPlease clean up dead exports before committing.\n");
  process.exit(1);
} else {
  console.log(`✓ No dead or unmarked test-only exports found across ${allExports.length} production exports.`);
}
