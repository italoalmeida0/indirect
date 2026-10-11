import { describe, expect, test } from "bun:test";
import { shouldCompressRelayEvent, relayFrameSessionId } from "../server/routes/relay";

// Regression: audit bugs 5, 64 — the compression whitelist and the push
// session-id extraction. Both are pure (exported test seams).

describe("Bug 64 — compression whitelist matches the real frame types", () => {
  test("turn_file_changes compresses (was missing) and file_balloon does not (phantom)", () => {
    // Real balloon-carrying frames from the daemon:
    expect(shouldCompressRelayEvent({ type: "turn_file_changes" })).toBe(true);
    expect(shouldCompressRelayEvent({ type: "session_data" })).toBe(true);
    expect(shouldCompressRelayEvent({ type: "session_content" })).toBe(true);
    expect(shouldCompressRelayEvent({ type: "agent_event" })).toBe(true);
    // file_balloon exists nowhere else in the repo (phantom type).
    expect(shouldCompressRelayEvent({ type: "file_balloon" })).toBe(false);
    // Small status signals stay uncompressed.
    expect(shouldCompressRelayEvent({ type: "session_status" })).toBe(false);
  });

  test("non-record input is not compressed", () => {
    expect(shouldCompressRelayEvent(null)).toBe(false);
    expect(shouldCompressRelayEvent("x")).toBe(false);
    expect(shouldCompressRelayEvent(42)).toBe(false);
  });
});

describe("Bug 5 — push title reads the session id from nested session", () => {
  test("realtime session_data (no top-level sessionId) falls back to session.id", () => {
    // The daemon's realtime session_data frames carry hostId + session only
    // (session_actor.go / turn_worker.go) — the old top-level read returned
    // "" and the title cache never filled.
    const realtime = { type: "session_data", hostId: "h1", session: { id: "s42", title: "My session" } };
    expect(relayFrameSessionId(realtime)).toBe("s42");
  });

  test("top-level sessionId wins when present", () => {
    expect(relayFrameSessionId({ type: "session_status", sessionId: "s7" })).toBe("s7");
  });

  test("frames without any session id return empty", () => {
    expect(relayFrameSessionId({ type: "health" })).toBe("");
    expect(relayFrameSessionId(null)).toBe("");
    expect(relayFrameSessionId("x")).toBe("");
    expect(relayFrameSessionId({ type: "session_data", session: {} })).toBe("");
  });
});
