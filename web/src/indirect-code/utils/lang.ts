/**
 * Lightweight token highlighter on top of highlight.js (already a runtime
 * dep — no new libs). `languageForPath` maps a file path/basename/extension
 * to an hljs language id; `highlightCode` returns HTML for <CodeBlock> and
 * `highlightCodeLines` highlights contiguous multi-line streams for diffs
 * without ever falling back to random single-line `highlightAuto` guesses.
 * Theme-agnostic: keep classes structural (`tok-…`) and map them to CSS vars
 * in the stylesheet so light/dark/high-contrast flip for free.
 */
export function languageForPath(name?: string): string | undefined {
  if (!name) return undefined;
  const base = String(name).replace(/\\/g, "/").split("/").pop() || "";
  if (!base) return undefined;
  const lower = base.toLowerCase();

  // Exact basenames and well-known dotfile families.
  if (
    lower === "dockerfile" ||
    lower === "containerfile" ||
    lower.startsWith("dockerfile.") ||
    lower.startsWith("containerfile.")
  ) {
    return "dockerfile";
  }
  if (
    lower === "makefile" ||
    lower === "gnumakefile" ||
    lower === "bsdmakefile" ||
    lower === "justfile"
  ) {
    return "makefile";
  }
  if (lower === "cmakelists.txt") return "cmake";
  if (lower === "go.mod" || lower === "go.work") return "go";
  if (lower === "go.sum" || lower === "go.work.sum") return "plaintext";
  if (lower === "cargo.lock" || lower === "pipfile" || lower === "poetry.lock") {
    return "ini";
  }
  if (
    lower === "gemfile" ||
    lower === "rakefile" ||
    lower === "podfile" ||
    lower === "fastfile" ||
    lower === "brewfile" ||
    lower === "vagrantfile"
  ) {
    return "ruby";
  }
  if (
    lower === "bun.lock" ||
    lower === "flake.lock" ||
    lower === "composer.lock" ||
    lower === ".eslintrc" ||
    lower === ".prettierrc" ||
    lower === ".babelrc" ||
    lower === ".swcrc"
  ) {
    return "json";
  }
  if (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".gitignore" ||
    lower === ".dockerignore" ||
    lower === ".npmignore" ||
    lower === ".eslintignore" ||
    lower === ".prettierignore" ||
    lower === ".hgignore" ||
    lower === ".ignore" ||
    lower === ".npmrc" ||
    lower === ".yarnrc" ||
    lower === ".editorconfig" ||
    lower === ".gitconfig" ||
    lower === ".gitmodules" ||
    lower === ".gitattributes"
  ) {
    return "ini";
  }
  if (
    lower === ".bashrc" ||
    lower === ".bash_profile" ||
    lower === ".bash_aliases" ||
    lower === ".bash_logout" ||
    lower === ".zshrc" ||
    lower === ".zshenv" ||
    lower === ".zprofile" ||
    lower === ".profile" ||
    lower === ".shrc"
  ) {
    return "bash";
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
    case "jsonl":
      return "json";
    case "py":
    case "pyi":
    case "pyw":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "c":
    case "h":
      return "c";
    case "cc":
    case "cpp":
    case "hpp":
    case "cxx":
    case "hxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
    case "xhtml":
    case "vue":
    case "svelte":
    case "xml":
    case "svg":
    case "plist":
      return "xml";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
    case "ini":
    case "cfg":
    case "conf":
    case "env":
      return "ini";
    case "properties":
      return "properties";
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
      return "bash";
    case "sql":
      return "sql";
    case "diff":
    case "patch":
      return "diff";
    case "dockerfile":
    case "containerfile":
      return "dockerfile";
    case "mk":
    case "mak":
    case "makefile":
      return "makefile";
    case "cmake":
      return "cmake";
    case "graphql":
    case "gql":
      return "graphql";
    case "lua":
      return "lua";
    case "r":
      return "r";
    case "scala":
    case "sc":
      return "scala";
    case "dart":
      return "dart";
    case "ex":
    case "exs":
      return "elixir";
    case "hs":
      return "haskell";
    case "pl":
    case "pm":
      return "perl";
    case "m":
    case "mm":
      return "objectivec";
    case "wat":
    case "wast":
      return "wasm";
    default:
      return undefined;
  }
}

/** Single-token hljs scope → structural `.tok-*` class. */
const HLJS_SINGLE_CLASS_MAP: Record<string, string> = {
  "hljs": "tok",
  "hljs-keyword": "tok-kw",
  "hljs-built_in": "tok-builtin",
  "hljs-builtin-name": "tok-builtin",
  "hljs-type": "tok-type",
  "hljs-literal": "tok-lit",
  "hljs-number": "tok-num",
  "hljs-string": "tok-str",
  "hljs-regexp": "tok-regex",
  "hljs-link": "tok-regex",
  "hljs-char": "tok-regex",
  "hljs-comment": "tok-com",
  "hljs-quote": "tok-com",
  "hljs-doctag": "tok-doc",
  "hljs-title": "tok-title",
  "hljs-section": "tok-title",
  "hljs-params": "tok-params",
  "hljs-variable": "tok-var",
  "hljs-template-variable": "tok-var",
  "hljs-subst": "tok-var",
  "hljs-name": "tok-name",
  "hljs-tag": "tok-name",
  "hljs-attr": "tok-attr",
  "hljs-attribute": "tok-attr",
  "hljs-property": "tok-attr",
  "hljs-operator": "tok-op",
  "hljs-symbol": "tok-op",
  "hljs-bullet": "tok-op",
  "hljs-punctuation": "tok-punct",
  "hljs-meta": "tok-meta",
  "hljs-addition": "tok-add",
  "hljs-deletion": "tok-del",
};

function mapOneClassAttr(cls: string): string {
  const tokens = cls.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const c = tokens[i]!;
    // Tiered scope modifiers emitted by hljs v11 (`function_`, `class_`,
    // `inherited__`, `invoke__`, `language_`, `constant_`, `escape_`) follow
    // an `hljs-*` base token and are folded into that base token's mapping.
    if (/^[a-zA-Z0-9-]+_+$/.test(c)) {
      continue;
    }
    if (c === "hljs-title") {
      if (tokens.includes("function_")) {
        out.push("tok-fn");
      } else if (tokens.includes("class_")) {
        out.push("tok-class");
      } else {
        out.push("tok-title");
      }
      continue;
    }
    if (c.startsWith("hljs-selector-")) {
      out.push("tok-sel");
      continue;
    }
    if (c.startsWith("hljs-meta")) {
      out.push("tok-meta");
      continue;
    }
    const mapped = HLJS_SINGLE_CLASS_MAP[c];
    out.push(mapped ?? c);
  }
  return out.join(" ");
}

export function mapHljsClasses(html: string): string {
  return html.replace(/class="([^"]*)"/g, (_m, cls: string) => {
    return `class="${mapOneClassAttr(cls)}"`;
  });
}

let hljsSyncCache: any | null = null;
let hljsPromise: Promise<any> | null = null;

async function getHljs(): Promise<any> {
  if (hljsSyncCache) return hljsSyncCache;
  hljsPromise ??= Promise.all([
    import("highlight.js/lib/common"),
    import("highlight.js/lib/languages/dockerfile"),
    import("highlight.js/lib/languages/cmake"),
    import("highlight.js/lib/languages/properties"),
    import("highlight.js/lib/languages/scala"),
    import("highlight.js/lib/languages/dart"),
    import("highlight.js/lib/languages/elixir"),
    import("highlight.js/lib/languages/haskell"),
  ]).then(([common, dockerfile, cmake, properties, scala, dart, elixir, haskell]) => {
    const hljs = common.default;
    hljs.registerLanguage("dockerfile", dockerfile.default);
    hljs.registerLanguage("cmake", cmake.default);
    hljs.registerLanguage("properties", properties.default);
    hljs.registerLanguage("scala", scala.default);
    hljs.registerLanguage("dart", dart.default);
    hljs.registerLanguage("elixir", elixir.default);
    hljs.registerLanguage("haskell", haskell.default);
    hljsSyncCache = hljs;
    return hljs;
  });
  return hljsPromise;
}

export function isCodeHighlightReady(): boolean {
  return hljsSyncCache !== null;
}

export async function preloadCodeHighlight(): Promise<void> {
  await getHljs();
}

/**
 * Split multi-line highlighted HTML across `\n` boundaries while keeping every
 * per-line HTML string strictly balanced: any `<span ...>` open at a newline
 * is closed with `</span>` at the end of the line and re-opened in stack order
 * at the start of the next line.
 */
export function splitHighlightedLines(html: string): string[] {
  const normalized = (html || "").replace(/\r\n/g, "\n");
  const openStack: string[] = [];
  const lines: string[] = [];
  let buf = "";

  const tokenRe = /<span\b[^>]*>|<\/span>|\n/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(normalized)) !== null) {
    if (m.index > lastIdx) {
      buf += normalized.slice(lastIdx, m.index);
    }
    const tok = m[0];
    if (tok === "\n") {
      for (let i = openStack.length - 1; i >= 0; i--) {
        buf += "</span>";
      }
      lines.push(stripEmptySpans(buf));
      buf = openStack.join("");
    } else if (tok === "</span>") {
      if (openStack.length > 0) {
        openStack.pop();
        buf += "</span>";
      }
    } else {
      openStack.push(tok);
      buf += tok;
    }
    lastIdx = m.index + tok.length;
  }

  if (lastIdx < normalized.length) {
    buf += normalized.slice(lastIdx);
  }
  for (let i = openStack.length - 1; i >= 0; i--) {
    buf += "</span>";
  }
  lines.push(stripEmptySpans(buf));
  return lines;
}

function stripEmptySpans(lineHtml: string): string {
  let cur = lineHtml;
  let prev = "";
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/<span\b[^>]*><\/span>/g, "");
  }
  return cur;
}

const C_BLOCK_COMMENT_LANGS = new Set([
  "typescript",
  "javascript",
  "css",
  "scss",
  "less",
  "c",
  "cpp",
  "csharp",
  "java",
  "kotlin",
  "go",
  "rust",
  "swift",
  "php",
  "scala",
  "dart",
  "sql",
  "objectivec",
]);

/**
 * Detect when a diff hunk begins in the middle of an already-open C-style
 * block comment (e.g. only the tail of a long JSDoc/license header falls inside
 * the 3-line unified diff context window). Outside strings and single-line
 * comments, a closing star-slash with no prior opening slash-star and no `/`
 * earlier on the same line (so JS regex literals never match) unambiguously
 * closes a block comment opened before the hunk.
 */
function hasLeadingUnmatchedBlockClose(src: string, language: string): boolean {
  if (!C_BLOCK_COMMENT_LANGS.has(language)) return false;
  const allowSlashLineComment = language !== "css" && language !== "sql";
  const allowDashLineComment = language === "sql";
  let quote: string | null = null;
  let sawSlashOnCurrentLine = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1] || "";

    if (ch === "\n") {
      sawSlashOnCurrentLine = false;
      if (quote === "'" || quote === '"') quote = null;
      continue;
    }

    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (allowSlashLineComment && ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) return false;
      i = nl - 1;
      continue;
    }

    if (allowDashLineComment && ch === "-" && next === "-") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) return false;
      i = nl - 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      return false;
    }

    if (ch === "*" && next === "/") {
      return !sawSlashOnCurrentLine;
    }

    if (ch === "/") {
      sawSlashOnCurrentLine = true;
    }
  }

  return false;
}

function hasLeadingUnmatchedXmlCommentClose(src: string, language: string): boolean {
  if (language !== "xml" && language !== "markdown") return false;
  const openIdx = src.indexOf("<!--");
  const closeIdx = src.indexOf("-->");
  if (closeIdx === -1) return false;
  return openIdx === -1 || closeIdx < openIdx;
}

function highlightKnownStream(hljs: any, lines: string[], language?: string): string[] {
  if (lines.length === 0) return [];
  if (
    !language ||
    typeof hljs?.getLanguage !== "function" ||
    !hljs.getLanguage(language)
  ) {
    return lines.map(escapeHtml);
  }

  const rawStream = lines.join("\n");
  let syntheticPrefix: string | null = null;
  if (hasLeadingUnmatchedBlockClose(rawStream, language)) {
    syntheticPrefix = "/*";
  } else if (hasLeadingUnmatchedXmlCommentClose(rawStream, language)) {
    syntheticPrefix = "<!--";
  }

  const fullStream = syntheticPrefix !== null ? `${syntheticPrefix}\n${rawStream}` : rawStream;
  const highlighted = mapHljsClasses(
    hljs.highlight(fullStream, { language, ignoreIllegals: true }).value,
  );
  const split = splitHighlightedLines(highlighted);
  const result = syntheticPrefix !== null ? split.slice(1) : split;

  // Guarantee exact 1:1 correspondence with `lines`.
  if (result.length === lines.length) return result;
  return lines.map((line, i) => result[i] ?? escapeHtml(line));
}

/**
 * Synchronous multi-line stream highlighter for diffs: NEVER runs
 * `highlightAuto` when `language` is unknown. Returns `null` only while `hljs`
 * is still loading for a known language.
 */
export function highlightCodeLinesSync(lines: string[], language?: string): string[] | null {
  if (lines.length === 0) return [];
  if (!language) return lines.map(escapeHtml);
  if (!hljsSyncCache) return null;
  return highlightKnownStream(hljsSyncCache, lines, language);
}

/**
 * Async multi-line stream highlighter for diffs: NEVER runs `highlightAuto`
 * when `language` is unknown (returns escaped plain lines immediately).
 */
export async function highlightCodeLines(lines: string[], language?: string): Promise<string[]> {
  if (lines.length === 0) return [];
  if (!language) return lines.map(escapeHtml);
  const hljs = await getHljs();
  return highlightKnownStream(hljs, lines, language);
}

/**
 * Synchronous live block highlighting with preloaded hljs. Returns null
 * until loading finishes; callers retain source text and retry on readiness.
 */
export function highlightCodeSync(text: string, language?: string): string | null {
  const hljs = hljsSyncCache;
  if (!hljs) return null;
  const src = text || "";
  let html: string;
  if (language && typeof hljs.getLanguage === "function" && hljs.getLanguage(language)) {
    html = hljs.highlight(src, { language, ignoreIllegals: true }).value;
  } else if (typeof hljs.highlightAuto === "function") {
    html = hljs.highlightAuto(src).value;
  } else {
    return null;
  }
  return mapHljsClasses(html);
}

export async function highlightCode(text: string, language?: string): Promise<string> {
  const src = text || "";
  const hljs = await getHljs();
  let html: string;
  if (language && typeof hljs.getLanguage === "function" && hljs.getLanguage(language)) {
    html = hljs.highlight(src, { language, ignoreIllegals: true }).value;
  } else if (typeof hljs.highlightAuto === "function") {
    html = hljs.highlightAuto(src).value;
  } else {
    html = escapeHtml(src);
  }
  return mapHljsClasses(html);
}

/**
 * Escapes raw text to HTML. Used as a stopgap identity "highlight" so raw
 * tool/file output renders identically until the async highlighter resolves.
 */
export function escapeHtml(src: string): string {
  return (src || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
