/**
 * Lint-side widget compilation: sucrase + source map (server + tests only).
 *
 * The API publish path (gen-ui.ts) keeps Bun.Transpiler; the lint compiles
 * with sucrase because it is LINE-PRESERVING (types blank out in place, JSX
 * reflows within its own lines) and ships a source map — so every lint
 * finding and every runtime stack line maps back to the MODEL's original
 * source, and the lint report can carry a code frame pointing at the exact
 * region to fix.
 */
import { transform } from "sucrase";
import remapping from "@jridgewell/remapping";
import { sanitizeModelModule, type AuditFinding } from "./model-code";
import { appendGlobalImports, globalImportsFor } from "./jsx-compile";

/** Original-source position (1-indexed line, 0-indexed column). */
export type SourcePosition = { line: number; column: number };

/**
 * Compiled → original position index (VLQ source map). Positions are the
 * model's own coordinates: code frames are built from the model source.
 */
export class SourceMapIndex {
  /** Per generated line: sorted [genCol, srcLine, srcCol] segments. */
  private readonly segs: number[][][] = [];

  /** Accepts VLQ strings or already-decoded segment arrays (absolute). */
  constructor(mappings: string | number[][][]) {
    if (Array.isArray(mappings)) {
      for (const line of mappings) {
        this.segs.push(line.map((seg) => [seg[0], seg[2] ?? -1, seg[3] ?? -1]));
      }
      return;
    }
    let srcLine = 0;
    let srcCol = 0;
    for (const group of mappings.split(";")) {
      const line: number[][] = [];
      let genCol = 0;
      for (const seg of group.split(",")) {
        if (!seg) continue;
        const fields = decodeVLQ(seg);
        if (!fields.length) continue;
        genCol += fields[0];
        if (fields.length >= 4) {
          // Segment fields: [genCol, sourceIndex, srcLine, srcCol].
          srcLine += fields[2] ?? 0;
          srcCol += fields[3] ?? 0;
          line.push([genCol, srcLine, srcCol]);
        } else {
          line.push([genCol, -1, -1]);
        }
      }
      this.segs.push(line);
    }
  }

  /** Nearest mapped position at or before (genLine, genCol) — 1-indexed line. */
  originalPositionFor(genLine: number, genCol: number): SourcePosition | null {
    const line = this.segs[genLine - 1];
    if (!line || !line.length) return null;
    let best: number[] | null = null;
    for (const seg of line) {
      if (seg[0] <= genCol) best = seg;
      else break;
    }
    if (!best) best = line[0];
    if (best[1] < 0) return null;
    return { line: best[1] + 1, column: best[2] };
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVLQ(seg: string): number[] {
  const out: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of seg) {
    const digit = B64.indexOf(ch);
    if (digit < 0) return out;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  return out;
}

export type LintCompileResult =
  | { ok: true; code: string; map: SourceMapIndex; findings: AuditFinding[] }
  | { ok: false; error: string; pos?: SourcePosition };

/**
 * Compile one widget (or test) source for the lint — two stages, both
 * LINE-PRESERVING, with the maps chained (@jridgewell/remapping) so every
 * position in the FINAL module traces back to the model's source:
 *
 *   1. sucrase (typescript+jsx) + source map — types blank out in place,
 *      JSX reflows within its own lines;
 *   2. model-code sanitize (magic-string) — forbidden ranges are replaced
 *      in place, replacements carry the newlines the removed text spanned,
 *      so no line ever moves.
 *
 * The lib-global prelude (three/d3/…) is APPENDED at the end (static
 * imports hoist) and lives outside every mapping — nothing to shift.
 */
export function compileWidgetForLint(src: string, file = "widget.tsx"): LintCompileResult {
  let code: string;
  let transpileMap: object;
  try {
    const out = transform(src, {
      transforms: ["typescript", "jsx"],
      jsxPragma: "React.createElement",
      jsxFragmentPragma: "React.Fragment",
      production: true,
      filePath: file,
      sourceMapOptions: { compiledFilename: file.replace(/\.tsx?$/, ".js") },
    });
    code = out.code;
    transpileMap = out.sourceMap as unknown as object;
  } catch (err) {
    // sucrase throws SyntaxError with e.loc {line, column} in ORIGINAL
    // source coordinates (column 0-indexed).
    const loc = (err as { loc?: { line?: number; column?: number } }).loc;
    const message = err instanceof Error ? err.message.replace(/^Error transforming [^:]+: /, "") : String(err);
    return {
      ok: false,
      error: message,
      pos: typeof loc?.line === "number" ? { line: loc.line, column: loc.column ?? 0 } : undefined,
    };
  }

  // Sanitize (audit + map-safe edits) — the served module is this output.
  const sanitized = sanitizeModelModule(code);
  if (!sanitized.ok) {
    const pos = sanitized.errorLoc?.line
      ? { line: sanitized.errorLoc.line, column: sanitized.errorLoc.column ?? 0 }
      : undefined;
    return { ok: false, error: sanitized.error, pos };
  }

  // Lib globals the code reads but never imports (three/d3/…): append the
  // side-effect imports at the END — static imports hoist, so behavior is
  // identical and no source line moves.
  code = appendGlobalImports(sanitized.code, globalImportsFor(src));

  // Chain: served (post-sanitize) -> sucrase output -> model source.
  const chained = remapping(
    [sanitized.map as never, transpileMap as never],
    () => null,
  );
  const map = new SourceMapIndex(chained.mappings as string | number[][][]);

  // Findings already carry model positions? No: the sanitize walks the
  // SUCRASE output, so its locs are transform-space — map them back.
  const findings = sanitized.stripped.map((f) => {
    const orig = f.line ? map.originalPositionFor(f.line, f.column ?? 0) : null;
    return orig ? { ...f, line: orig.line, column: orig.column } : f;
  });
  return { ok: true, code, map, findings };
}
