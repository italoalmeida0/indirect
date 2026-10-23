export type PricingValues = Record<string, number>;

/** Keep numeric pricing from provider payloads while accepting currency labels. */
export function normalizePricingValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  // Full numeric parse first: scientific notation ("4.5e-7") must survive —
  // digit-stripping alone turns it into "4.57" and silently corrupts the price.
  const cleaned = value.replace(/[\s,$€£]/g, "");
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) {
    const number = Number(cleaned);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  const digits = cleaned.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizePricing(value: unknown): PricingValues | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: PricingValues = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 16 || key.length > 48) continue;
    const number = normalizePricingValue(raw);
    if (number !== null) out[key] = number;
  }
  return Object.keys(out).length ? out : null;
}

function first(pricing: PricingValues | null, keys: string[]): number | null {
  if (!pricing) return null;
  for (const key of keys) {
    if (pricing[key] !== undefined) return pricing[key]!;
  }
  return null;
}

export function pricingColumns(pricing: PricingValues | null): {
  input: number | null;
  inputCache: number | null;
  inputCacheWrite: number | null;
  output: number | null;
} {
  return {
    input: first(pricing, ["prompt", "input", "input_price"]),
    inputCache: first(pricing, ["input_cache_reads", "input_cache_read", "input_cache", "cache_read", "cache"]),
    inputCacheWrite: first(pricing, ["input_cache_writes", "input_cache_write", "cache_write"]),
    output: first(pricing, ["completion", "output", "output_price"]),
  };
}

/**
 * Dynamic LEFT JOINs to resolve model pricing from registry `models`.
 * Matches on requested model ID, upstream model ID, or upstream model name.
 * Uses GROUP BY on the upstream subquery to guarantee 1-to-1 matching (no row duplication).
 */
export function modelPricingJoins(prefix = "m"): string {
  const mdUp = `${prefix}_md_up`;
  const md = `${prefix}_md`;
  const mdId = `${prefix}_md_id`;
  return `
    LEFT JOIN models ${md} ON ${md}.id = ${prefix}.model
    LEFT JOIN models ${mdId} ON ${mdId}.id = ${prefix}.upstream_model
    LEFT JOIN (
      SELECT upstream_model, pricing_input, pricing_input_cache, pricing_output
      FROM models WHERE upstream_model != ''
      GROUP BY upstream_model
    ) ${mdUp} ON ${mdUp}.upstream_model = ${prefix}.upstream_model
  `;
}

/** Single-row input cost expression in USD. */
export function costInExprSql(prefix = "e"): string {
  const mdUp = `${prefix}_md_up`;
  const md = `${prefix}_md`;
  const mdId = `${prefix}_md_id`;
  return `(${prefix}.in_tok * COALESCE(${md}.pricing_input, ${mdId}.pricing_input, ${mdUp}.pricing_input, 0))`;
}

/** Single-row cache input cost expression in USD. */
export function costCacheExprSql(prefix = "e"): string {
  const mdUp = `${prefix}_md_up`;
  const md = `${prefix}_md`;
  const mdId = `${prefix}_md_id`;
  return `(${prefix}.cache_tok * COALESCE(${md}.pricing_input_cache, ${mdId}.pricing_input_cache, ${mdUp}.pricing_input_cache, ${md}.pricing_input, ${mdId}.pricing_input, ${mdUp}.pricing_input, 0))`;
}

/** Single-row output cost expression in USD. */
export function costOutExprSql(prefix = "e"): string {
  const mdUp = `${prefix}_md_up`;
  const md = `${prefix}_md`;
  const mdId = `${prefix}_md_id`;
  return `(${prefix}.out_tok * COALESCE(${md}.pricing_output, ${mdId}.pricing_output, ${mdUp}.pricing_output, 0))`;
}

/** Single-row total cost expression in USD. */
export function costExprSql(prefix = "e"): string {
  return `(${costInExprSql(prefix)} + ${costCacheExprSql(prefix)} + ${costOutExprSql(prefix)})`;
}

/** Single-row cost fields with column aliases `cost_in`, `cost_cache`, `cost_out`, `cost`. */
export function costRowFieldsSql(prefix = "e"): string {
  return `
    COALESCE(${costInExprSql(prefix)}, 0) AS cost_in,
    COALESCE(${costCacheExprSql(prefix)}, 0) AS cost_cache,
    COALESCE(${costOutExprSql(prefix)}, 0) AS cost_out,
    COALESCE(${costExprSql(prefix)}, 0) AS cost
  `;
}

/** Aggregated cost fields with column aliases `cost_in`, `cost_cache`, `cost_out`, `cost`. */
export function costAggFieldsSql(prefix = "m"): string {
  return `
    COALESCE(SUM(${costInExprSql(prefix)}), 0) AS cost_in,
    COALESCE(SUM(${costCacheExprSql(prefix)}), 0) AS cost_cache,
    COALESCE(SUM(${costOutExprSql(prefix)}), 0) AS cost_out,
    COALESCE(SUM(${costExprSql(prefix)}), 0) AS cost
  `;
}

/** Single-row cost with column alias `AS cost`. */
export function costRowSql(prefix = "e"): string {
  return `COALESCE(${costExprSql(prefix)}, 0) AS cost`;
}

/** Aggregated cost expression: SUM(...) in USD with column alias `AS cost`. */
export function costAggSql(prefix = "m"): string {
  return `COALESCE(SUM(${costExprSql(prefix)}), 0) AS cost`;
}

