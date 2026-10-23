import { describe, expect, test } from "bun:test";
import { matchOpenRouterModel, type OpenRouterModel } from "../server/openrouter";
import { enrichParsedModel, type ParsedModel } from "../server/models";
import { modelPricingJoins, costExprSql, costRowSql, costAggSql, normalizePricing, pricingColumns } from "../server/pricing";

describe("OpenRouter model matching", () => {
  const catalog: OpenRouterModel[] = [
    {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      description: "Omni model from OpenAI",
      context_length: 128000,
      max_output_length: 4096,
      pricing: {
        prompt: 0.0000025,
        completion: 0.00001,
        input_cache_reads: 0.00000125,
      },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    {
      id: "anthropic/claude-3.5-sonnet",
      name: "Claude 3.5 Sonnet",
      description: "Anthropic flagship model",
      context_length: 200000,
      max_output_length: 8192,
      pricing: {
        prompt: 0.000003,
        completion: 0.000015,
        input_cache_reads: 0.0000003,
      },
    },
    {
      id: "meta-llama/llama-3.1-70b-instruct",
      name: "Llama 3.1 70B",
      context_length: 131072,
      pricing: {
        prompt: 0.00000035,
        completion: 0.0000004,
      },
    },
  ];

  test("matches exact ID", () => {
    const match = matchOpenRouterModel("openai/gpt-4o", catalog);
    expect(match).not.toBeNull();
    expect(match?.id).toBe("openai/gpt-4o");
  });

  test("matches model ID without org prefix", () => {
    const match = matchOpenRouterModel("gpt-4o", catalog);
    expect(match).not.toBeNull();
    expect(match?.id).toBe("openai/gpt-4o");
  });

  test("matches normalized slug (dots/dashes)", () => {
    const match = matchOpenRouterModel("claude-3-5-sonnet", catalog);
    expect(match).not.toBeNull();
    expect(match?.id).toBe("anthropic/claude-3.5-sonnet");
  });

  test("matches case-insensitively", () => {
    const match = matchOpenRouterModel("Llama-3.1-70B-Instruct", catalog);
    expect(match).not.toBeNull();
    expect(match?.id).toBe("meta-llama/llama-3.1-70b-instruct");
  });

  test("returns null for non-matching query", () => {
    const match = matchOpenRouterModel("non-existent-unknown-model-xyz", catalog);
    expect(match).toBeNull();
  });
});

describe("Model enrichment logic", () => {
  const catalog: OpenRouterModel[] = [
    {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      description: "Omni model from OpenAI",
      context_length: 128000,
      max_output_length: 4096,
      pricing: {
        prompt: 0.0000025,
        completion: 0.00001,
        input_cache_reads: 0.00000125,
      },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
  ];

  test("enriches missing pricing and metadata on model without pricing", () => {
    const parsed: ParsedModel = {
      id: "gpt-4o",
      name: "gpt-4o",
      description: "",
      context_length: null,
      max_output_length: null,
      input_modalities: ["text"],
      output_modalities: ["text"],
      sampling_params: [],
      features: [],
      reasoning_efforts: null,
      pricing: null,
    };

    const enriched = enrichParsedModel(parsed, catalog);
    expect(enriched).toBe(true);
    expect(parsed.pricing).toEqual({
      prompt: 0.0000025,
      completion: 0.00001,
      input_cache_reads: 0.00000125,
    });
    expect(parsed.context_length).toBe(128000);
    expect(parsed.max_output_length).toBe(4096);
    expect(parsed.description).toBe("Omni model from OpenAI");
    expect(parsed.input_modalities).toEqual(["text", "image"]);
  });

  test("preserves existing pricing and does not overwrite", () => {
    const customPricing = { prompt: 0.000005, completion: 0.00002 };
    const parsed: ParsedModel = {
      id: "gpt-4o",
      name: "gpt-4o",
      description: "My custom description",
      context_length: 64000,
      max_output_length: 2048,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      sampling_params: ["temperature"],
      features: ["streaming"],
      reasoning_efforts: null,
      pricing: customPricing,
    };

    const enriched = enrichParsedModel(parsed, catalog);
    expect(enriched).toBe(false);
    expect(parsed.pricing).toBe(customPricing);
    expect(parsed.description).toBe("My custom description");
    expect(parsed.context_length).toBe(64000);
    expect(parsed.max_output_length).toBe(2048);
  });
});

describe("SQL pricing and cost helpers", () => {
  test("generates scoped joins without collisions", () => {
    const joinsM = modelPricingJoins("m");
    expect(joinsM).toContain("LEFT JOIN models m_md ON m_md.id = m.model");
    expect(joinsM).toContain("LEFT JOIN models m_md_id ON m_md_id.id = m.upstream_model");
    expect(joinsM).toContain("m_md_up.upstream_model = m.upstream_model");

    const joinsE = modelPricingJoins("e");
    expect(joinsE).toContain("LEFT JOIN models e_md ON e_md.id = e.model");
    expect(joinsE).toContain("LEFT JOIN models e_md_id ON e_md_id.id = e.upstream_model");
  });

  test("generates row and agg cost expressions", () => {
    const expr = costExprSql("e");
    expect(expr).toContain("e.in_tok");
    expect(expr).toContain("e.cache_tok");
    expect(expr).toContain("e.out_tok");

    const rowCost = costRowSql("e");
    expect(rowCost).toContain("e.in_tok");
    expect(rowCost).toContain("e.cache_tok");
    expect(rowCost).toContain("e.out_tok");
    expect(rowCost).toContain("AS cost");

    const aggCost = costAggSql("m");
    expect(aggCost).toContain("COALESCE(SUM(");
    expect(aggCost).toContain("m.in_tok");
    expect(aggCost).toContain("AS cost");
  });

  test("pricingColumns normalizes prompt, cache, and completion rates", () => {
    const pricing = normalizePricing({
      prompt: "0.0000025",
      completion: "0.00001",
      input_cache_reads: "0.00000125",
    });
    const cols = pricingColumns(pricing);
    expect(cols.input).toBe(0.0000025);
    expect(cols.output).toBe(0.00001);
    expect(cols.inputCache).toBe(0.00000125);
  });
});
