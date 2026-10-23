import { normalizePricing, pricingColumns, type PricingValues } from "./pricing";

export interface OpenRouterModel {
  id: string;
  canonical_slug?: string;
  name?: string;
  description?: string;
  context_length?: number | null;
  max_output_length?: number | null;
  input_modalities?: string[];
  output_modalities?: string[];
  sampling_params?: string[];
  features?: string[];
  reasoning_efforts?: string[] | null;
  pricing?: PricingValues | null;
  pricing_input?: number | null;
  pricing_input_cache?: number | null;
  pricing_input_cache_write?: number | null;
  pricing_output?: number | null;
}

let catalogCache: OpenRouterModel[] | null = null;
let catalogFetchedAt = 0;
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
let inflightFetch: Promise<OpenRouterModel[] | null> | null = null;

/**
 * Fetch the public OpenRouter models list for metadata and pricing enrichment.
 * Memoized in-memory for 1 hour. Fails gracefully to null without throwing.
 */
export async function fetchOpenRouterCatalog(forceRefresh = false): Promise<OpenRouterModel[] | null> {
  const now = Date.now();
  if (!forceRefresh && catalogCache && now - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        console.warn(`[openrouter] GET /api/v1/models failed: HTTP ${res.status}`);
        return catalogCache;
      }
      const json = (await res.json()) as { data?: unknown[] };
      if (!json || !Array.isArray(json.data)) return catalogCache;

      const out: OpenRouterModel[] = [];
      for (const raw of json.data) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as Record<string, unknown>;
        const id = typeof m.id === "string" ? m.id : "";
        if (!id) continue;

        const topProvider = (m.top_provider ?? null) as Record<string, unknown> | null;
        const arch = (m.architecture ?? null) as Record<string, unknown> | null;
        const pricing = normalizePricing(m.pricing);
        const cols = pricingColumns(pricing);

        let inputModalities = Array.isArray(m.input_modalities)
          ? (m.input_modalities as string[])
          : Array.isArray(arch?.input_modalities)
            ? (arch.input_modalities as string[])
            : undefined;
        let outputModalities = Array.isArray(m.output_modalities)
          ? (m.output_modalities as string[])
          : Array.isArray(arch?.output_modalities)
            ? (arch.output_modalities as string[])
            : undefined;

        if ((!inputModalities || !outputModalities) && typeof arch?.modality === "string") {
          const [i, o] = arch.modality.split("->");
          if (!inputModalities && i) inputModalities = i.split("+").map((s) => s.trim()).filter(Boolean);
          if (!outputModalities && o) outputModalities = o.split("+").map((s) => s.trim()).filter(Boolean);
        }

        const maxOut =
          typeof m.max_output_length === "number" && m.max_output_length > 0
            ? m.max_output_length
            : typeof m.max_completion_tokens === "number" && m.max_completion_tokens > 0
              ? m.max_completion_tokens
              : typeof topProvider?.max_completion_tokens === "number" && topProvider.max_completion_tokens > 0
                ? topProvider.max_completion_tokens
                : null;

        const ctxLen =
          typeof m.context_length === "number" && m.context_length > 0
            ? m.context_length
            : typeof topProvider?.context_length === "number" && topProvider.context_length > 0
              ? topProvider.context_length
              : null;

        out.push({
          id,
          canonical_slug: typeof m.canonical_slug === "string" ? m.canonical_slug : undefined,
          name: typeof m.name === "string" ? m.name : id,
          description: typeof m.description === "string" ? m.description.slice(0, 2000) : "",
          context_length: ctxLen,
          max_output_length: maxOut,
          input_modalities: inputModalities ?? ["text"],
          output_modalities: outputModalities ?? ["text"],
          sampling_params: Array.isArray(m.supported_parameters)
            ? (m.supported_parameters as string[])
            : [],
          features: Array.isArray(m.supported_features) ? (m.supported_features as string[]) : [],
          reasoning_efforts: Array.isArray((m.reasoning_parameters as any)?.efforts)
            ? ((m.reasoning_parameters as any).efforts as string[])
            : null,
          pricing,
          pricing_input: cols.input,
          pricing_input_cache: cols.inputCache,
          pricing_input_cache_write: cols.inputCacheWrite,
          pricing_output: cols.output,
        });
      }
      catalogCache = out;
      catalogFetchedAt = Date.now();
      return catalogCache;
    } catch (e) {
      console.warn(`[openrouter] catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return catalogCache;
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

function cleanId(s: string): string {
  return s
    .toLowerCase()
    .replace(/^~/, "")
    .replace(/^models\//, "")
    .replace(/:[a-z0-9_-]+$/, "") // strip :free, :batch, :beta, etc.
    .replace(/[-_.]/g, "");
}

/**
 * Match a candidate model id or name against the OpenRouter catalog.
 * Supports exact id/slug, stripped organization prefix, and fuzzy punctuation matches.
 */
export function matchOpenRouterModel(query: string, catalog: OpenRouterModel[]): OpenRouterModel | null {
  if (!query) return null;
  const qClean = cleanId(query);
  const qCore = cleanId(query.includes("/") ? query.split("/")[1]! : query);

  // 1. Exact full id or slug
  let hit = catalog.find((m) => cleanId(m.id) === qClean || (m.canonical_slug && cleanId(m.canonical_slug) === qClean));
  if (hit) return hit;

  // 2. Exact core (without org prefix)
  hit = catalog.find((m) => {
    const mCore = cleanId(m.id.includes("/") ? m.id.split("/")[1]! : m.id);
    const slugCore = m.canonical_slug
      ? cleanId(m.canonical_slug.includes("/") ? m.canonical_slug.split("/")[1]! : m.canonical_slug)
      : "";
    return mCore === qCore || (slugCore && slugCore === qCore);
  });
  if (hit) return hit;

  // 3. Name match
  hit = catalog.find((m) => m.name && cleanId(m.name) === qCore);
  if (hit) return hit;

  // 4. Substring / contains candidate (prefer non-batch, non-free variants)
  const candidates = catalog.filter((m) => {
    const mCore = cleanId(m.id.includes("/") ? m.id.split("/")[1]! : m.id);
    return mCore.includes(qCore) || qCore.includes(mCore);
  });
  if (candidates.length > 0) {
    const best = candidates.find((c) => !c.id.includes(":batch") && !c.id.includes(":free")) ?? candidates[0]!;
    return best;
  }

  return null;
}
