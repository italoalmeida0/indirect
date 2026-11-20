/** Multilingual Parakeet SentencePiece decoder, tech-term post-processor,
 * and selection-aware transcript insertion helper.
 * Pure TypeScript (zero DOM dependencies).
 */

const DEFAULT_BLANK_ID = 1024;
const BLANK_TOKEN = "<blk>";

/** Unicode-safe boundary check: avoids JS ASCII-only `\b` matching inside
 * accented words (e.g. "domínio" must never become "DOMínio").
 */
const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";

const CLOSING_PUNCT_SPACE_RE = /(?:\s+)(?=[,.;:?!)}\]…])/g;

type ReplacementFn = (match: string, ...args: string[]) => string;
type TechRule = readonly [RegExp, string | ReplacementFn];

const TECH_RULES: readonly TechRule[] = [
  [new RegExp(`${L}type\\s*script${R}`, "giu"), "TypeScript"],
  [new RegExp(`${L}java\\s*script${R}`, "giu"), "JavaScript"],
  [new RegExp(`${L}next\\s*\\.?\\s*js${R}`, "giu"), "Next.js"],
  [new RegExp(`${L}node\\s*\\.?\\s*js${R}`, "giu"), "Node.js"],
  [new RegExp(`${L}solid\\s*\\.?\\s*js${R}`, "giu"), "SolidJS"],
  [new RegExp(`${L}web\\s*gpu${R}`, "giu"), "WebGPU"],
  [new RegExp(`${L}web\\s*assembly${R}`, "giu"), "WebAssembly"],
  [new RegExp(`${L}web\\s*worker(s)?${R}`, "giu"), (_, plural) => (plural ? "Web Workers" : "Web Worker")],
  [new RegExp(`${L}git\\s*hub${R}`, "giu"), "GitHub"],
  [new RegExp(`${L}git\\s*lab${R}`, "giu"), "GitLab"],
  [new RegExp(`${L}open\\s*ai${R}`, "giu"), "OpenAI"],
  [new RegExp(`${L}chat\\s*gpt${R}`, "giu"), "ChatGPT"],
  [new RegExp(`${L}end\\s*point(s)?${R}`, "giu"), (_, plural) => (plural ? "endpoints" : "endpoint")],
  [new RegExp(`${L}front[\\s-]+end${R}`, "giu"), "frontend"],
  [new RegExp(`${L}back[\\s-]+end${R}`, "giu"), "backend"],
  [new RegExp(`${L}full[\\s-]+stack${R}`, "giu"), "fullstack"],
  [new RegExp(`${L}postgre\\s*sql${R}`, "giu"), "PostgreSQL"],
  [new RegExp(`${L}my\\s*sql${R}`, "giu"), "MySQL"],
  [new RegExp(`${L}graph\\s*ql${R}`, "giu"), "GraphQL"],
  [new RegExp(`${L}vs\\s*code${R}`, "giu"), "VS Code"],
  [new RegExp(`${L}tail\\s*wind(?:\\s+css)?${R}`, "giu"), (m) => (/css$/i.test(m) ? "Tailwind CSS" : "Tailwind")],
  [new RegExp(`${L}docker${R}`, "giu"), "Docker"],
  [new RegExp(`${L}kubernetes${R}`, "giu"), "Kubernetes"],
  [new RegExp(`${L}o-?auth${R}`, "giu"), "OAuth"],
  [new RegExp(`${L}ci\\s*\\/\\s*cd${R}`, "giu"), "CI/CD"],
  // Context-gated "REST" so plain English "take a rest" / "the rest of" stays lowercase.
  [new RegExp(`${L}rest\\s+api(s)?${R}`, "giu"), (_, plural) => (plural ? "REST APIs" : "REST API")],
  [new RegExp(`${L}restful${R}`, "giu"), "RESTful"],
  // Context-gated "UI" so Portuguese interjection "ui, que susto!" stays untouched.
  [new RegExp(`${L}ui\\s*\\/\\s*ux${R}`, "giu"), "UI/UX"],
  [new RegExp(`${L}ux\\s*\\/\\s*ui${R}`, "giu"), "UX/UI"],
  [
    new RegExp(
      `${L}ui(?=\\s+(?:component|components|design|designer|kit|layer|layout|state|thread|bug|bugs|test|tests|library|framework|element|elements|panel|modal|view|screen|flow|polish|update|changes|work|code|system|spec|token|tokens|overlay|button|toolbar|composer)${R})`,
      "giu",
    ),
    "UI",
  ],
  [
    new RegExp(
      `${L}(generative|web|mobile|desktop|admin|dashboard|chat|voice|react|solid|frontend|custom|new|old|the)\\s+ui${R}`,
      "giu",
    ),
    (_, prefix) => `${prefix} UI`,
  ],
  // Unambiguous uppercase acronyms (Unicode word boundaries prevent breaking accented words).
  [
    new RegExp(
      `${L}(api|jwt|json|yaml|sql|html|css|sdk|cli|llm|stt|tts|wasm|onnx|url|http|https|cors|ux|cpu|gpu|vram|mcp|ssh|tls|dns|ram|dom|ssr|csr)${R}`,
      "giu",
    ),
    (m) => m.toUpperCase(),
  ],
  [
    new RegExp(`${L}(apis|llms|urls|sdks|clis|cpus|gpus)${R}`, "giu"),
    (m) => m.slice(0, -1).toUpperCase() + "s",
  ],
];

export interface ParsedParakeetVocab {
  idToPiece: string[];
  blankId: number;
}

export interface TranscriptInsertionResult {
  merged: string;
  caret: number;
  prefix: string;
  inserted: string;
  suffix: string;
  words: string[];
}

export function parseParakeetVocab(vocabText: string): ParsedParakeetVocab {
  const idToPiece: string[] = [];
  let blankId = -1;

  for (const rawLine of vocabText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let piece: string;
    let idStr: string;
    const sep = line.lastIndexOf(" ");
    if (sep !== -1) {
      piece = line.slice(0, sep).trim();
      idStr = line.slice(sep + 1).trim();
    } else {
      const m = line.match(/^(\S+)\s+(\d+)$/);
      if (!m) continue;
      piece = m[1]!;
      idStr = m[2]!;
    }

    const id = Number.parseInt(idStr, 10);
    if (!Number.isNaN(id) && id >= 0 && piece.length > 0) {
      idToPiece[id] = piece;
      if (piece === BLANK_TOKEN) blankId = id;
    }
  }

  if (blankId === -1) blankId = DEFAULT_BLANK_ID;
  return { idToPiece, blankId };
}

/** Decode SentencePiece token IDs into Unicode-clean text.
 * Strips whitespace only before closing punctuation so accented words in
 * Portuguese/European languages never lose their leading spaces.
 */
export function decodeParakeetTokens(
  tokenIds: readonly number[],
  idToPiece: readonly string[],
  blankId: number,
): string {
  const pieces: string[] = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const id = tokenIds[i]!;
    if (id === blankId) continue;
    const raw = idToPiece[id];
    if (raw === undefined || raw === "" || raw === BLANK_TOKEN) continue;
    pieces.push(raw.replace(/\u2581/g, " "));
  }

  let text = pieces.join("");
  text = text.replace(/^\s+/, "");
  text = text.replace(CLOSING_PUNCT_SPACE_RE, "");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

export function postProcessTranscript(
  raw: string,
  opts?: { isSentenceStart?: boolean },
): string {
  let text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  for (let i = 0; i < TECH_RULES.length; i++) {
    const [regex, replacement] = TECH_RULES[i]!;
    if (typeof replacement === "string") {
      text = text.replace(regex, replacement);
    } else {
      text = text.replace(regex, replacement);
    }
  }

  text = text.replace(CLOSING_PUNCT_SPACE_RE, "").replace(/\s+/g, " ").trim();

  if (opts?.isSentenceStart !== false && text.length > 0) {
    text = text[0]!.toUpperCase() + text.slice(1);
  }

  return text;
}

export function isAtSentenceStart(prefix: string): boolean {
  const trimmed = prefix.replace(/[ \t]+$/, "");
  if (trimmed.length === 0) return true;
  if (/[\r\n]$/.test(trimmed)) return true;
  return /[.!?…]["')\]»”’]*$/.test(trimmed);
}

export function insertTranscriptAtSelection(
  current: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): TranscriptInsertionResult {
  const len = current.length;
  const start = Math.max(0, Math.min(len, Math.trunc(selectionStart)));
  const end = Math.max(start, Math.min(len, Math.trunc(selectionEnd)));

  const before = current.slice(0, start);
  const after = current.slice(end);
  const clean = transcript.replace(/\s+/g, " ").trim();

  if (!clean) {
    return {
      merged: current,
      caret: start,
      prefix: before,
      inserted: "",
      suffix: after,
      words: [],
    };
  }

  const needLead =
    before.length > 0 && !/\s$/.test(before) && !/^[,.;:?!)}\]…]/.test(clean);
  const needTrail =
    after.length > 0 && !/^\s/.test(after) && !/^[,.;:?!)}\]…]/.test(after);

  const lead = needLead ? " " : "";
  const trail = needTrail ? " " : "";
  const inserted = lead + clean + trail;
  const merged = before + inserted + after;
  const caret = before.length + inserted.length;
  const words = clean.split(" ").filter(Boolean);

  return {
    merged,
    caret,
    prefix: before + lead,
    inserted,
    suffix: trail + after,
    words,
  };
}
