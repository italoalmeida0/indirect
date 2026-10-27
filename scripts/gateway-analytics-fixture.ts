import type { AnalyticsEntity, AnalyticsReport, DailyPoint, ModelTimeline } from "../web/src/api.ts";

type Selection = Record<string, { include?: string[]; exclude?: string[] }>;
const metricFields = ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"] as const;

export function analyticsFixture(series: DailyPoint[], url: URL, admin = false, granularity: AnalyticsReport["granularity"] = "day"): AnalyticsReport {
  const selection = JSON.parse(url.searchParams.get("selection") ?? "{}") as Selection;
  const factor = Object.keys(selection).length ? .43 : 1;
  const points = series.map((point) => ({ ...point, ...Object.fromEntries(metricFields.map((field) => [field, ["in_tok", "cache_tok", "out_tok", "reqs"].includes(field) ? Math.round((point[field] ?? 0) * factor) : (point[field] ?? 0) * factor])) })) as DailyPoint[];
  const total = Object.fromEntries(metricFields.map((field) => [field, points.reduce((sum, point) => sum + (point[field] ?? 0), 0)])) as Record<typeof metricFields[number], number>;
  const modelDomain = ["Claude Sonnet 4.5", "GPT-5", "Gemini 2.5 Pro", "Kimi K2", "DeepSeek V3.2"].map((label, index) => ({ id: `model/${index}`, label }));
  const visible = <T extends { id: string }>(rows: T[], field: string) => rows.filter((row) => (!selection[field]?.include?.length || selection[field]!.include!.includes(row.id)) && !selection[field]?.exclude?.includes(row.id));
  const models = visible(modelDomain, "model");
  const weights = [.36, .25, .17, .1, .08];
  const bucketSize = Math.max(1, Math.ceil(points.length / 48));
  const timeline = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const chunk = points.slice(index, index + bucketSize);
    timeline.push({ ...chunk[0]!, lastDate: chunk.at(-1)!.date, reqs: chunk.reduce((sum, point) => sum + point.reqs, 0), cost: chunk.reduce((sum, point) => sum + (point.cost ?? 0), 0) });
  }
  const modelChart = (metric: "cost" | "reqs"): ModelTimeline => {
    const ranked = metric === "reqs" && models.length > 1 ? [models[1]!, models[0]!, ...models.slice(2)] : models;
    const groups: ModelTimeline["groups"] = total.reqs ? [...ranked, ...(models.length === 5 ? [{ id: null, label: "Other" }] : [])] : [];
    return { groups, points: timeline.map((point) => {
      let left = point[metric] ?? 0;
      const values = groups.map((_, index) => {
        const value = index === groups.length - 1 ? left : metric === "reqs" ? Math.floor(point.reqs * (groups.length < 6 ? 1 / groups.length : weights[index]!)) : (point.cost ?? 0) * (groups.length < 6 ? 1 / groups.length : weights[index]!);
        left -= value;
        return value;
      });
      return { date: point.date, lastDate: point.lastDate, label: point.label ?? point.date.slice(5), values };
    }) };
  };
  const entities = (domain: { id: string; label: string; detail?: string }[], field: string): AnalyticsEntity[] => {
    const list = visible(domain, field);
    if (!total.reqs) return [];
    const remaining = { ...total };
    return list.map((row, index) => {
      const result = { ...row, detail: row.detail ?? "", members: 1 } as AnalyticsEntity;
      const weight = list.length === 1 ? 1 : [0.52, 0.31, 0.17][index] ?? 1 / list.length;
      for (const field of metricFields) {
        const value = index === list.length - 1 ? remaining[field] : ["in_tok", "cache_tok", "out_tok", "reqs"].includes(field) ? Math.round(total[field] * weight) : total[field] * weight;
        result[field] = value;
        remaining[field] -= value;
      }
      return result;
    });
  };
  const users = admin ? entities([
    { id: "user", label: "Alex Morgan", detail: "alex@example.com" },
    { id: "jamie", label: "Jamie Chen", detail: "jamie@example.com" },
    { id: "sam", label: "Sam Rivera", detail: "sam@example.com" },
  ], "user_id") : [];
  return { series: points, previous: points.map((point) => ({ ...point, ...Object.fromEntries(metricFields.map((field) => [field, (point[field] ?? 0) * .8])) })),
    granularity, scope: { from: url.searchParams.get("from") === "all" ? null : Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")) },
    modelSpend: modelChart("cost"), modelRequests: modelChart("reqs"), users,
    keys: entities([{ id: "production", label: "Production", detail: admin ? "alex@example.com" : "production" }, { id: "development", label: "Development", detail: admin ? "jamie@example.com" : "development" }, { id: "staging", label: "Staging", detail: admin ? "sam@example.com" : "staging" }], "key_id"),
    outcomes: timeline.map((point, index) => { const errors = Math.floor(point.reqs * ((index % 5 + 1) / 100)); return { date: point.date, label: point.label ?? point.date.slice(5), lastDate: point.lastDate, success: point.reqs - errors, errors, unknown: 0 }; }),
    providers: entities([{ id: "primary", label: "Primary" }, { id: "backup", label: "Backup" }], "provider_id"),
    protocols: entities([{ id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic" }], "proto"), activeUsers: users.length };
}
