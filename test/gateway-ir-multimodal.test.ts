import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-mm-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET, LIMITS } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");
const {
  decodeToIR,
  encodeIR,
  imageSourceToDataUrl,
  imageToDataUrl,
  extractToolResultPayload,
  dataUrlToAnthropicSource,
  demoteUnsignedToolCalls,
} = await import("../server/proxy/gateway-ir");
import type {
  GatewayRequest,
  IRImageBlock,
  IRTextBlock,
  IRToolResultBlock,
} from "../server/proxy/gateway-ir";

function makeBase64Payload(byteCount: number, seedChar = "Q"): string {
  // Deterministic valid-alphabet base64 payload (multiple of 4 chars).
  const quadCount = Math.ceil(byteCount / 3);
  const block = `${seedChar}WJj`;
  return block.repeat(quadCount);
}

describe("Gateway IR top-level image decoding & source normalization", () => {
  test("imageSourceToDataUrl handles Anthropic base64, URL, direct strings, and OpenAI shapes", async () => {
    // Anthropic base64 with explicit media_type
    expect(
      imageSourceToDataUrl({
        type: "base64",
        media_type: "image/webp",
        data: "UklGRg==",
      }),
    ).toBe("data:image/webp;base64,UklGRg==");

    // Anthropic base64 missing media_type defaults to image/png and strips whitespace/newlines
    expect(
      imageSourceToDataUrl({
        type: "base64",
        data: "  iVBORw0K\nGgoAAAAN\r\nSUhEUg==  ",
      }),
    ).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");

    // Anthropic URL source
    expect(
      imageSourceToDataUrl({
        type: "url",
        url: "https://cdn.example.com/diagram.png",
      }),
    ).toBe("https://cdn.example.com/diagram.png");

    // Direct strings & OpenAI shapes
    expect(imageSourceToDataUrl("https://cdn.example.com/direct.jpg")).toBe(
      "https://cdn.example.com/direct.jpg",
    );
    expect(imageSourceToDataUrl("data:image/jpeg;base64,/9j/4AAQ==")).toBe(
      "data:image/jpeg;base64,/9j/4AAQ==",
    );
    expect(
      imageSourceToDataUrl({ image_url: { url: "https://cdn.example.com/oai.png" } }),
    ).toBe("https://cdn.example.com/oai.png");
    expect(
      imageSourceToDataUrl({ url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }),
    ).toBe("data:image/gif;base64,R0lGODlhAQABAAAAACw=");

    // Async imageToDataUrl: data: passthrough + reachable HTTP fetch to data: URL
    expect(await imageToDataUrl("data:image/png;base64,AQID")).toBe("data:image/png;base64,AQID");
    const imgSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/ok.png") {
          return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      expect(await imageToDataUrl(`http://127.0.0.1:${imgSrv.port}/ok.png`)).toBe("data:image/png;base64,AQID");
      expect(await imageToDataUrl(`http://127.0.0.1:${imgSrv.port}/missing.png`)).toBeNull();
    } finally {
      imgSrv.stop(true);
    }

    // Malformed / empty sources return null
    expect(imageSourceToDataUrl({ type: "base64", media_type: "image/png", data: "  \n " })).toBeNull();
    expect(imageSourceToDataUrl({ type: "url", url: "" })).toBeNull();
    expect(imageSourceToDataUrl("data:image/png;base64,   ")).toBeNull();
    expect(imageSourceToDataUrl(null)).toBeNull();
  });

  test("decodeAnthropicToIR preserves top-level user base64 and URL images with mediaType", async () => {
    const b64 = makeBase64Payload(120, "A");
    const ir = await decodeToIR("anthropic", {
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare these two screenshots:" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: b64 },
            },
            {
              type: "image",
              source: { type: "url", url: "https://example.com/reference.png" },
            },
          ],
        },
      ],
    });

    expect(ir.warnings).toEqual([]);
    expect(ir.messages).toHaveLength(1);
    const blocks = ir.messages[0]!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "Compare these two screenshots:" });
    expect(blocks[1]).toEqual({
      type: "image",
      url: `data:image/jpeg;base64,${b64}`,
      mediaType: "image/jpeg",
    } satisfies IRImageBlock);
    expect(blocks[2]).toEqual({
      type: "image",
      url: "https://example.com/reference.png",
    } satisfies IRImageBlock);

    // Translating to Chat keeps both user images as image_url parts
    const chat = encodeIR("openai", ir, "gpt-4.1") as any;
    expect(chat.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these two screenshots:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: "image_url", image_url: { url: "https://example.com/reference.png" } },
        ],
      },
    ]);
  });
});

describe("Gateway IR multimodal tool_result translation", () => {
  test("Anthropic -> Chat Completions with 8 sequential tool_result images: zero base64 in role:tool, hoisted role:user intact", async () => {
    const messages: any[] = [{ role: "user", content: "Inspect all 8 screens one by one." }];
    const expectedUrls: string[] = [];

    for (let i = 1; i <= 8; i++) {
      const b64 = makeBase64Payload(18_000, String.fromCharCode(64 + i));
      expectedUrls.push(`data:image/png;base64,${b64}`);
      messages.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `call_seq_${i}`, name: "read", input: { path: `screen_${i}.png` } },
        ],
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `call_seq_${i}`,
            content: [
              { type: "text", text: `Read image file [image/png] screen_${i}.png` },
              { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
            ],
          },
        ],
      });
    }

    const ir = await decodeToIR("anthropic", {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages,
    });
    const chat = encodeIR("openai", ir, "gpt-4.1") as any;
    const outMsgs: any[] = chat.messages;

    // 1 initial user + 8 * (assistant + tool + synthetic user) = 25 messages
    expect(outMsgs).toHaveLength(25);
    expect(outMsgs[0]).toEqual({ role: "user", content: "Inspect all 8 screens one by one." });

    let totalTextChars = String(outMsgs[0].content).length;
    for (let i = 1; i <= 8; i++) {
      const base = 1 + (i - 1) * 3;
      const asst = outMsgs[base];
      const toolMsg = outMsgs[base + 1];
      const hoistedUser = outMsgs[base + 2];

      expect(asst.role).toBe("assistant");
      expect(asst.tool_calls).toHaveLength(1);
      expect(asst.tool_calls[0].id).toBe(`call_seq_${i}`);

      // Zero base64 in role:"tool"
      expect(toolMsg).toEqual({
        role: "tool",
        tool_call_id: `call_seq_${i}`,
        content: `Read image file [image/png] screen_${i}.png`,
      });
      expect(toolMsg.content).not.toContain("base64");
      expect(toolMsg.content.length).toBeLessThan(80);
      totalTextChars += toolMsg.content.length;

      // Synthetic hoisted user message immediately follows the tool message
      expect(hoistedUser.role).toBe("user");
      expect(hoistedUser.content).toEqual([
        { type: "text", text: `[Attached image(s) from tool call call_seq_${i}]` },
        { type: "image_url", image_url: { url: expectedUrls[i - 1] } },
      ]);
      totalTextChars += hoistedUser.content[0].text.length;
    }

    // Total text across the entire 8-image conversation is tiny (< 1,500 chars), never MBs of base64!
    expect(totalTextChars).toBeLessThan(1500);
  });

  test("Anthropic -> Chat Completions with 8 parallel tool_result images preserves contiguous role:tool batch before single hoisted user message", async () => {
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const expectedUrls: string[] = [];

    for (let i = 1; i <= 8; i++) {
      const b64 = makeBase64Payload(12_000, String.fromCharCode(72 + i));
      expectedUrls.push(`data:image/jpeg;base64,${b64}`);
      toolUses.push({
        type: "tool_use",
        id: `call_par_${i}`,
        name: "read",
        input: { path: `shot_${i}.jpg` },
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: `call_par_${i}`,
        content:
          i === 4
            ? [
                // Empty text block case: image-only tool_result
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
              ]
            : [
                { type: "text", text: `Loaded shot_${i}.jpg` },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
              ],
      });
    }

    const ir = await decodeToIR("anthropic", {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Read all 8 shots in parallel." },
        { role: "assistant", content: toolUses },
        {
          role: "user",
          content: [
            ...toolResults,
            { type: "text", text: "Now summarize the layout differences." },
          ],
        },
      ],
    });

    const chat = encodeIR("openai", ir, "deepseek-chat") as any;
    const outMsgs: any[] = chat.messages;

    // Exact required wire order:
    // [0] user ("Read all 8 shots in parallel.")
    // [1] assistant (tool_calls: call_par_1..call_par_8)
    // [2..9] role:"tool" (call_par_1..call_par_8, strictly contiguous!)
    // [10] synthetic role:"user" ([Attached image(s) ... + image_url] for 1..8)
    // [11] human role:"user" ("Now summarize the layout differences.")
    expect(outMsgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "user",
      "user",
    ]);

    expect(outMsgs[1].tool_calls.map((tc: any) => tc.id)).toEqual(
      Array.from({ length: 8 }, (_, idx) => `call_par_${idx + 1}`),
    );

    let totalToolTextLen = 0;
    for (let i = 1; i <= 8; i++) {
      const tm = outMsgs[1 + i];
      expect(tm.role).toBe("tool");
      expect(tm.tool_call_id).toBe(`call_par_${i}`);
      expect(tm.content).toBe(
        i === 4 ? "[Image attached in following user message]" : `Loaded shot_${i}.jpg`,
      );
      totalToolTextLen += tm.content.length;
    }
    expect(totalToolTextLen).toBeLessThan(300);

    // Single synthetic hoisted user message containing all 8 images in order
    const hoisted = outMsgs[10];
    expect(hoisted.role).toBe("user");
    expect(Array.isArray(hoisted.content)).toBe(true);
    expect(hoisted.content).toHaveLength(16); // 8 label text parts + 8 image_url parts
    for (let i = 0; i < 8; i++) {
      expect(hoisted.content[i * 2]).toEqual({
        type: "text",
        text: `[Attached image(s) from tool call call_par_${i + 1}]`,
      });
      expect(hoisted.content[i * 2 + 1]).toEqual({
        type: "image_url",
        image_url: { url: expectedUrls[i] },
      });
    }

    expect(outMsgs[11]).toEqual({
      role: "user",
      content: "Now summarize the layout differences.",
    });
  });

  test("Anthropic -> Responses -> IR -> Anthropic round-trip preserves tool_result images, URLs, and backward-compatible text tool_results", async () => {
    const userB64 = makeBase64Payload(300, "U");
    const toolB64 = makeBase64Payload(450, "T");

    expect(dataUrlToAnthropicSource(`data:image/png;base64,${toolB64}`)).toEqual({
      type: "base64",
      media_type: "image/png",
      data: toolB64,
    });
    expect(dataUrlToAnthropicSource("https://assets.example.com/mock.webp")).toEqual({
      type: "url",
      url: "https://assets.example.com/mock.webp",
    });

    const imgSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    const specUrl = `http://127.0.0.1:${imgSrv.port}/spec.png`;
    const fetchedSpecB64 = Buffer.from([137, 80, 78, 71]).toString("base64");

    try {
      const originalAnthropic = {
        model: "claude-sonnet-4-5",
        max_tokens: 2048,
        system: "Visual QA assistant",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Verify against the spec:" },
              { type: "image", source: { type: "base64", media_type: "image/webp", data: userB64 } },
              { type: "image", source: { type: "url", url: specUrl } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_img", name: "screenshot", input: { target: "header" } },
              { type: "tool_use", id: "call_txt", name: "bash", input: { cmd: "echo ok" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_img",
                content: [
                  { type: "text", text: "Captured header" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: toolB64 } },
                  { type: "image", source: { type: "url", url: "https://assets.example.com/overlay.png" } },
                ],
              },
              {
                type: "tool_result",
                tool_use_id: "call_txt",
                content: "ok",
              },
            ],
          },
        ],
      };

      const ir1 = await decodeToIR("anthropic", originalAnthropic);
      // Direct Anthropic -> IR -> Anthropic preserves URL source directly without fetching
      const directAnthropic = encodeIR("anthropic", ir1, "claude-sonnet-4-5") as any;
      expect(directAnthropic.messages[0].content[2]).toEqual({
        type: "image",
        source: { type: "url", url: specUrl },
      });

      const responsesBody = encodeIR("responses", ir1, "gpt-4.1") as any;

      // Verify Responses wire representation
      expect(responsesBody.instructions).toBe("Visual QA assistant");
      expect(responsesBody.input).toHaveLength(5);
      expect(responsesBody.input[0]).toEqual({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Verify against the spec:" },
          { type: "input_image", image_url: `data:image/webp;base64,${userB64}` },
          { type: "input_image", image_url: specUrl },
        ],
      });
      expect(responsesBody.input[3]).toEqual({
        type: "function_call_output",
        call_id: "call_img",
        output: [
          { type: "input_text", text: "Captured header" },
          { type: "input_image", image_url: `data:image/png;base64,${toolB64}` },
          { type: "input_image", image_url: "https://assets.example.com/overlay.png" },
        ],
      });
      // Text-only tool_result stays a plain string in Responses
      expect(responsesBody.input[4]).toEqual({
        type: "function_call_output",
        call_id: "call_txt",
        output: "ok",
      });

      // Round-trip back: Responses -> IR -> Anthropic (Responses user input_image HTTP URL resolves to base64; tool_result URL & base64 round-trip intact)
      const ir2 = await decodeToIR("responses", responsesBody);
      const roundTrippedAnthropic = encodeIR("anthropic", ir2, "claude-sonnet-4-5") as any;

      expect(roundTrippedAnthropic.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Verify against the spec:" },
            { type: "image", source: { type: "base64", media_type: "image/webp", data: userB64 } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: fetchedSpecB64 } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_img", name: "screenshot", input: { target: "header" } },
            { type: "tool_use", id: "call_txt", name: "bash", input: { cmd: "echo ok" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_img",
              content: [
                { type: "text", text: "Captured header" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: toolB64 } },
                { type: "image", source: { type: "url", url: "https://assets.example.com/overlay.png" } },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "call_txt",
              // Plain string preserved when images is empty/undefined!
              content: "ok",
            },
          ],
        },
      ]);
    } finally {
      imgSrv.stop(true);
    }
  });

  test("Gemini demoteUnsignedToolCalls preserves tool_result images as IRImageBlocks right after [tool result <id>] IRTextBlock", async () => {
    const b64A = makeBase64Payload(240, "G");
    const b64B = makeBase64Payload(240, "H");
    const signedB64 = makeBase64Payload(240, "S");

    const ir = await decodeToIR("anthropic", {
      model: "gemini-2.5-pro",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Check header and footer" },
        // Turn 1: UNSIGNED tool calls -> must be demoted
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading images." },
            { type: "tool_use", id: "u_1", name: "read", input: { path: "header.png" } },
            { type: "tool_use", id: "u_2", name: "read", input: { path: "footer.webp" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "u_1",
              content: [
                { type: "text", text: "header meta" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: b64A } },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "u_2",
              content: [
                { type: "text", text: "footer meta" },
                { type: "image", source: { type: "base64", media_type: "image/webp", data: b64B } },
              ],
            },
          ],
        },
        // Turn 2: SIGNED Gemini tool call -> must remain native tool_use + tool_result
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "s_1", name: "read", input: { path: "signed.png" } },
            { type: "redacted_thinking", data: "google_sig_token_abc" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "s_1",
              content: [
                { type: "text", text: "signed meta" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: signedB64 } },
              ],
            },
          ],
        },
      ],
    });

    const demoted = demoteUnsignedToolCalls(ir);

    // Original IR must not be mutated (safe across failover candidates)
    expect((ir.messages[2]!.blocks[0] as IRToolResultBlock).type).toBe("tool_result");

    // Unsigned assistant turn demoted to text recap
    expect(demoted.messages[1]!.blocks).toEqual([
      { type: "text", text: "Reading images." },
      { type: "text", text: '[tool call read: {"path":"header.png"}]' },
      { type: "text", text: '[tool call read: {"path":"footer.webp"}]' },
    ]);

    // Demoted user turn preserves IRImageBlocks immediately after each [tool result <id>] IRTextBlock
    const demotedUserBlocks = demoted.messages[2]!.blocks;
    expect(demotedUserBlocks).toEqual([
      { type: "text", text: "[tool result u_1]: header meta" } satisfies IRTextBlock,
      {
        type: "image",
        url: `data:image/png;base64,${b64A}`,
        mediaType: "image/png",
      } satisfies IRImageBlock,
      { type: "text", text: "[tool result u_2]: footer meta" } satisfies IRTextBlock,
      {
        type: "image",
        url: `data:image/webp;base64,${b64B}`,
        mediaType: "image/webp",
      } satisfies IRImageBlock,
    ]);

    // Signed turn keeps native tool_use + tool_result
    expect(demoted.messages[3]!.blocks[0]!.type).toBe("tool_use");
    expect(demoted.messages[4]!.blocks[0]!.type).toBe("tool_result");

    // Full encodeIR("openai", ir, "gemini-2.5-pro") preserves image_url parts in user content
    const geminiChat = encodeIR("openai", ir, "gemini-2.5-pro") as any;
    expect(geminiChat.messages[1].tool_calls).toBeUndefined();
    expect(geminiChat.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[tool result u_1]: header meta" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64A}` } },
        { type: "text", text: "[tool result u_2]: footer meta" },
        { type: "image_url", image_url: { url: `data:image/webp;base64,${b64B}` } },
      ],
    });
    // Signed turn stays native tool_calls + role:tool + hoisted user image
    expect(geminiChat.messages[3].tool_calls).toHaveLength(1);
    expect(geminiChat.messages[4]).toEqual({
      role: "tool",
      tool_call_id: "s_1",
      content: "signed meta",
    });
    expect(geminiChat.messages[5]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Attached image(s) from tool call s_1]" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${signedB64}` } },
      ],
    });
  });

  test("demoteUnsignedToolCalls never mutates cached IR in place when merging a demoted tool_result into a preceding user message", () => {
    const b64 = makeBase64Payload(120, "M");
    const imgUrl = `data:image/png;base64,${b64}`;
    const ir: GatewayRequest = {
      model: "claude-sonnet-4-5",
      system: "",
      tools: [],
      toolChoice: { mode: "auto" },
      params: {},
      warnings: [],
      messages: [
        { role: "user", blocks: [{ type: "text", text: "hi" }] },
        {
          role: "user",
          blocks: [
            {
              type: "tool_result",
              toolUseId: "u1",
              content: "ok",
              images: [{ url: imgUrl, mediaType: "image/png" }],
            },
          ],
        },
      ],
    };
    const snapshot = structuredClone(ir);

    const demoted = demoteUnsignedToolCalls(ir);
    expect(demoted.messages).toHaveLength(1);
    expect(demoted.messages[0]!.blocks).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "[tool result u1]: ok" },
      { type: "image", url: imgUrl, mediaType: "image/png" },
    ]);

    // Cached caller IR must stay 100% untouched for secondary Anthropic/OpenAI failover targets
    expect(ir).toEqual(snapshot);
    expect(ir.messages[0]!.blocks).toEqual([{ type: "text", text: "hi" }]);

    // Also verify full encodeIR("openai", ir, "gemini-2.5-pro") -> failover encodeIR("anthropic", ir, ...)
    // Before the fix, demoteUnsignedToolCalls polluted ir.messages[0].blocks with `[tool result u1]: ok` + duplicate image!
    encodeIR("openai", ir, "gemini-2.5-pro");
    expect(ir).toEqual(snapshot);
    const failoverAnthropic = encodeIR("anthropic", ir, "claude-sonnet-4-5") as any;
    expect(failoverAnthropic.messages).toHaveLength(1);
    expect(failoverAnthropic.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "u1",
          content: [
            { type: "text", text: "ok" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: b64 },
            },
          ],
        },
        { type: "text", text: "hi" },
      ],
    });
  });

  test("encodeIR('openai') emits all role:'tool' messages contiguously before hoisted images and user text on mixed user turns", () => {
    const b64A = makeBase64Payload(90, "X");
    const b64B = makeBase64Payload(90, "Y");
    const b64User = makeBase64Payload(90, "Z");
    const urlA = `data:image/png;base64,${b64A}`;
    const urlB = `data:image/jpeg;base64,${b64B}`;
    const urlUser = `data:image/webp;base64,${b64User}`;

    // Case 1: [tool_result(c1, img1), text("compare"), tool_result(c2, img2)]
    const mixedInterleaved: GatewayRequest = {
      model: "gpt-4o",
      system: "",
      tools: [],
      toolChoice: { mode: "auto" },
      params: {},
      warnings: [],
      messages: [
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", id: "c1", name: "read", input: { path: "a.png" } },
            { type: "tool_use", id: "c2", name: "read", input: { path: "b.jpg" } },
          ],
        },
        {
          role: "user",
          blocks: [
            {
              type: "tool_result",
              toolUseId: "c1",
              content: "Read image a",
              images: [{ url: urlA, mediaType: "image/png" }],
            },
            { type: "text", text: "compare" },
            {
              type: "tool_result",
              toolUseId: "c2",
              content: "Read image b",
              images: [{ url: urlB, mediaType: "image/jpeg" }],
            },
          ],
        },
      ],
    };

    const chat1 = encodeIR("openai", mixedInterleaved, "gpt-4o") as any;
    expect(chat1.messages.map((m: any) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
      "user",
    ]);
    expect(chat1.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "Read image a",
    });
    expect(chat1.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "c2",
      content: "Read image b",
    });
    expect(chat1.messages[3]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Attached image(s) from tool call c1]" },
        { type: "image_url", image_url: { url: urlA } },
        { type: "text", text: "[Attached image(s) from tool call c2]" },
        { type: "image_url", image_url: { url: urlB } },
      ],
    });
    expect(chat1.messages[4]).toEqual({
      role: "user",
      content: "compare",
    });

    // Case 2: [text("note"), image(userImg), tool_result(c1, img1)]
    const mixedLeadingText: GatewayRequest = {
      model: "gpt-4o",
      system: "",
      tools: [],
      toolChoice: { mode: "auto" },
      params: {},
      warnings: [],
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "tool_use", id: "c1", name: "read", input: { path: "a.png" } }],
        },
        {
          role: "user",
          blocks: [
            { type: "text", text: "note" },
            { type: "image", url: urlUser, mediaType: "image/webp" },
            {
              type: "tool_result",
              toolUseId: "c1",
              content: "Read image a",
              images: [{ url: urlA, mediaType: "image/png" }],
            },
          ],
        },
      ],
    };

    const chat2 = encodeIR("openai", mixedLeadingText, "gpt-4o") as any;
    expect(chat2.messages.map((m: any) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "user",
    ]);
    expect(chat2.messages[1].tool_call_id).toBe("c1");
    expect(chat2.messages[2].content[1]).toEqual({
      type: "image_url",
      image_url: { url: urlA },
    });
    expect(chat2.messages[3]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "note" },
        { type: "image_url", image_url: { url: urlUser } },
      ],
    });
  });

  test("Malformed image blocks and unknown huge-data objects never JSON.stringify base64 into text", async () => {
    const hugeBlobA = "A".repeat(60_000);
    const hugeBlobB = "B".repeat(60_000);
    const hugeBlobC = "C".repeat(60_000);

    const extracted = extractToolResultPayload([
      { type: "text", text: "Tool header" },
      // Empty Anthropic base64 source
      { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
      // Malformed Anthropic image source with 60KB payload under unknown source type
      { type: "image", source: { type: "corrupt_encoding", data: hugeBlobA } },
      // Malformed input_image with invalid scheme + 60KB payload
      { type: "input_image", image_url: { url: `invalid-scheme://${hugeBlobB}` } },
      // Arbitrary unknown object containing huge >1024-char data string
      { type: "custom_binary_part", label: "artifact", data: hugeBlobC },
    ]);

    expect(extracted.images).toEqual([]);
    expect(extracted.text).toContain("Tool header");
    expect(extracted.text).toContain("[omitted malformed image]");
    expect(extracted.text).not.toContain("AAAAAAAAAA");
    expect(extracted.text).not.toContain("BBBBBBBBBB");
    expect(extracted.text).not.toContain("CCCCCCCCCC");
    expect(extracted.text.length).toBeLessThan(300);

    // End-to-end through decodeToIR + encodeIR
    const ir = await decodeToIR("anthropic", {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c_bad", name: "read", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c_bad",
              content: [
                { type: "image", source: { type: "unknown", data: hugeBlobA } },
                { type: "unknown_wrapper", nested: { data: hugeBlobC } },
              ],
            },
          ],
        },
      ],
    });
    const chatWire = JSON.stringify(encodeIR("openai", ir, "gpt-4.1"));
    expect(chatWire.length).toBeLessThan(800);
    expect(chatWire).not.toContain("AAAAAAAAAA");
    expect(chatWire).not.toContain("CCCCCCCCCC");
  });

  test("decodeChatToIR extracts image_url / input_image inside role:tool messages via extractToolResultPayload", async () => {
    const toolB64 = makeBase64Payload(180, "Z");
    const ir = await decodeToIR("openai", {
      model: "gpt-4.1",
      messages: [
        { role: "user", content: "Take screenshot" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_chat_1",
              type: "function",
              function: { name: "screenshot", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_chat_1",
          content: [
            { type: "text", text: "Screenshot captured" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${toolB64}` } },
          ],
        },
      ],
    });

    const tr = ir.messages[2]!.blocks[0] as IRToolResultBlock;
    expect(tr).toEqual({
      type: "tool_result",
      toolUseId: "call_chat_1",
      content: "Screenshot captured",
      images: [{ url: `data:image/png;base64,${toolB64}`, mediaType: "image/png" }],
    });

    const anth = encodeIR("anthropic", ir, "claude-sonnet-4-5") as any;
    expect(anth.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_chat_1",
          content: [
            { type: "text", text: "Screenshot captured" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: toolB64 } },
          ],
        },
      ],
    });
  });
});

describe("Gateway proxy 32 MiB body limit, >5 MiB multimodal HTTP relay, and passthrough byte-fidelity", () => {
  const RUN = randomToken(6);
  const UID = `u-mm-${RUN}`;
  const P_OPENAI = `p-mm-oai-${RUN}`;
  const P_ANTH = `p-mm-anth-${RUN}`;
  const K_OPENAI = `k-mm-oai-${RUN}`;
  const K_ANTH = `k-mm-anth-${RUN}`;
  const KEYID = `key-mm-${RUN}`;
  const GW_KEY = `gw_${RUN}${"m".repeat(48 - RUN.length)}`;
  const UP_KEY = "sk-mm-upstream-test";

  let httpServer: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  let seenUpstream: Array<{ url: string; rawBody: string }> = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const enc = await encryptSecret(UP_KEY, GATEWAY_SECRET);
    const now = Date.now();
    db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, ?, 'active', ?)").run(
      UID,
      `${UID}@example.com`,
      now,
    );
    db.prepare(
      "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'mm-oai', 'http://up-mm.test/openai/v1', NULL, ?, 1, 10, ?)",
    ).run(P_OPENAI, enc, now);
    db.prepare(
      "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'mm-anth', NULL, 'http://up-anth-mm.test/anthropic/v1', ?, 0, 20, ?)",
    ).run(P_ANTH, enc, now);
    db.prepare(
      "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
    ).run(K_OPENAI, P_OPENAI, enc, now, now);
    db.prepare(
      "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
    ).run(K_ANTH, P_ANTH, enc, now, now);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 'mm-key', ?, ?, 'active', ?)",
    ).run(KEYID, UID, GW_KEY.slice(0, 8), sha256Hex(GW_KEY), now);
    invalidateModelCache();

    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith("http://up-mm.test/") && !url.startsWith("http://up-anth-mm.test/")) {
        return realFetch(input, init);
      }
      const rawBody = typeof init?.body === "string" ? init.body : "";
      seenUpstream.push({ url, rawBody });
      if (url.startsWith("http://up-anth-mm.test/")) {
        return Response.json({
          id: "msg_mm_stub",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Native Anthropic OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 120, output_tokens: 6 },
        });
      }
      return Response.json({
        id: "chatcmpl_mm_stub",
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Translated Multimodal OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 6 },
      });
    }) as typeof fetch;

    httpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: LIMITS.proxyBodyBytes + 1024 * 1024,
      fetch(req, srv) {
        return handleProxy(req, new URL(req.url), srv);
      },
    });
    baseUrl = `http://127.0.0.1:${httpServer.port}`;
  });

  afterAll(() => {
    httpServer?.stop(true);
    globalThis.fetch = realFetch;
    flushUsage();
    db.transaction(() => {
      db.prepare("DELETE FROM usage_daily WHERE key_id = ?").run(KEYID);
      db.prepare("DELETE FROM usage_events WHERE key_id = ?").run(KEYID);
      db.prepare("DELETE FROM providers WHERE id IN (?, ?)").run(P_OPENAI, P_ANTH);
      db.prepare("DELETE FROM users WHERE id = ?").run(UID);
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'",
      ).run();
    })();
    invalidateModelCache();
  });

  function selectProvider(id: string): void {
    db.prepare(
      "UPDATE providers SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE id IN (?, ?)",
    ).run(id, P_OPENAI, P_ANTH);
    invalidateModelCache();
  }

  test("LIMITS.proxyBodyBytes is 32 MiB while dashboard/auth limits remain unchanged", () => {
    expect(LIMITS.proxyBodyBytes).toBe(32 * 1024 * 1024);
    expect(LIMITS.apiBodyBytes).toBe(256 * 1024);
    expect(LIMITS.authBodyBytes).toBe(16 * 1024);
  });

  test("HTTP proxy accepts >5 MiB translated multimodal payload and hoists images cleanly", async () => {
    selectProvider(P_OPENAI);
    seenUpstream = [];

    // 6 images * ~1 MiB base64 each => ~6 MiB request (> 5 MiB, well above old 4 MiB wall)
    const perImageB64 = "iVBORw0K".repeat(132_000); // 1,056,000 chars each
    const toolUses = Array.from({ length: 6 }, (_, i) => ({
      type: "tool_use",
      id: `big_${i + 1}`,
      name: "read",
      input: { path: `shot_${i + 1}.png` },
    }));
    const toolResults = Array.from({ length: 6 }, (_, i) => ({
      type: "tool_result",
      tool_use_id: `big_${i + 1}`,
      content: [
        { type: "text", text: `Read shot_${i + 1}.png` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: perImageB64 } },
      ],
    }));

    const payload = JSON.stringify({
      model: "gpt-4.1",
      max_tokens: 256,
      messages: [
        { role: "user", content: "Inspect these 6 high-res screenshots." },
        { role: "assistant", content: toolUses },
        { role: "user", content: toolResults },
      ],
    });
    expect(payload.length).toBeGreaterThan(6 * 1024 * 1024);

    const res = await realFetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": GW_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const resJson = (await res.json()) as any;
    expect(resJson.content[0].text).toBe("Translated Multimodal OK");

    expect(seenUpstream).toHaveLength(1);
    expect(seenUpstream[0]!.url).toBe("http://up-mm.test/openai/v1/chat/completions");
    const upBody = JSON.parse(seenUpstream[0]!.rawBody);
    const roles = upBody.messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "tool", "tool", "tool", "tool", "user"]);
    for (let i = 0; i < 6; i++) {
      expect(upBody.messages[2 + i].content).toBe(`Read shot_${i + 1}.png`);
    }
    const hoistedImages = upBody.messages[8].content.filter((p: any) => p.type === "image_url");
    expect(hoistedImages).toHaveLength(6);
  });

  test("HTTP proxy rejects >32 MiB payload with 413 envelope", async () => {
    selectProvider(P_OPENAI);
    seenUpstream = [];

    const overLimitBody =
      `{"model":"gpt-4.1","max_tokens":32,"messages":[{"role":"user","content":"` +
      "x".repeat(32 * 1024 * 1024 + 128 * 1024) +
      `"}]}`;
    expect(overLimitBody.length).toBeGreaterThan(LIMITS.proxyBodyBytes);

    const res = await realFetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": GW_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: overLimitBody,
    });
    expect(res.status).toBe(413);
    const errBody = (await res.json()) as any;
    expect(errBody).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "payload too large",
      },
    });
    expect(seenUpstream).toHaveLength(0);
  });

  test("same-protocol passthrough leaves >5 MiB multimodal request bytes untouched", async () => {
    selectProvider(P_ANTH);
    seenUpstream = [];

    const bigB64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(160_000); // ~5.76 MB
    // Custom formatting + custom metadata key to prove exact byte-for-byte fidelity
    const rawRequestBytes =
      `{\n  "model": "claude-sonnet-4-5",\n  "max_tokens": 512,\n  "metadata": { "user_id": "byte-fidelity-check" },\n` +
      `  "messages": [\n    {\n      "role": "user",\n      "content": [\n` +
      `        { "type": "text", "text": "Passthrough check" },\n` +
      `        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "${bigB64}" } }\n` +
      `      ]\n    }\n  ]\n}`;
    expect(rawRequestBytes.length).toBeGreaterThan(5 * 1024 * 1024);

    const res = await realFetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": GW_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: rawRequestBytes,
    });
    expect(res.status).toBe(200);
    expect(seenUpstream).toHaveLength(1);
    expect(seenUpstream[0]!.url).toBe("http://up-anth-mm.test/anthropic/v1/messages");
    expect(seenUpstream[0]!.rawBody).toBe(rawRequestBytes);
  });
});
