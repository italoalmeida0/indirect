import { expect, test } from "bun:test";
import { projectModelPrices, projectUsageRows } from "../server/financial-policy";

test("restricted usage projection omits new unknown monetary fields without relying on their names", () => {
  const row = { date: "2026-10-30", reqs: 10, in_tok: 20, cache_tok: 30, out_tok: 40, cost: 5, averageRequestCharge: 0.5, accountCredit: 100, unexpected: { balance: 50 } };
  const projected = projectUsageRows([row], { showModelPrices: false, budgetPresentation: "hidden", inherited: true });
  expect(projected).toEqual([{ date: "2026-10-30", reqs: 10, in_tok: 20, cache_tok: 30, out_tok: 40 }]);
  expect(row.accountCredit).toBe(100); // Never mutate the shared reader/cache result.
});

test("restricted passthrough catalogs expose only non-financial metadata at every model level", () => {
  const catalog = { object: "list", has_more: false, data: [{ id: "example/model", object: "model", created: 1, pricing: { prompt: "0.1" }, averageRequestCharge: 5,
    top_provider: { context_length: 128000, is_moderated: true, surcharge: 8 }, architecture: { input_modalities: ["text", "image"], accountCredit: 10 } }], accountCredit: 20 };
  expect(projectModelPrices(catalog, false)).toEqual({ object: "list", has_more: false, data: [{ id: "example/model", object: "model", created: 1,
    top_provider: { context_length: 128000, is_moderated: true }, architecture: { input_modalities: ["text", "image"] } }] });
  expect(projectModelPrices(catalog, true)).toBe(catalog);
});
