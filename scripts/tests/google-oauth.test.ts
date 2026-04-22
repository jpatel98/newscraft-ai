import assert from "node:assert/strict";
import test from "node:test";

import {
  isGoogleEmailVerified,
  parseGoogleState,
  readJsonSafe,
} from "../../src/lib/server/google-oauth";

test("parseGoogleState accepts valid, non-expired payloads", () => {
  const state = JSON.stringify({
    state: "state-value",
    next: "/channel/general",
    createdAt: Date.now(),
  });

  const parsed = parseGoogleState(state);
  assert.equal(parsed?.state, "state-value");
  assert.equal(parsed?.next, "/channel/general");
});

test("parseGoogleState rejects malformed JSON", () => {
  assert.equal(parseGoogleState("not-json"), null);
});

test("parseGoogleState rejects expired values", () => {
  const expired = JSON.stringify({
    state: "old-state",
    next: "/",
    createdAt: Date.now() - 5 * 60 * 1000 - 10,
  });

  assert.equal(parseGoogleState(expired), null);
});

test("parseGoogleState rejects missing fields", () => {
  const missing = JSON.stringify({ state: "just-state", next: "/channel" });
  assert.equal(parseGoogleState(missing), null);
});

test("isGoogleEmailVerified validates true-ish values only", () => {
  assert.equal(isGoogleEmailVerified(true), true);
  assert.equal(isGoogleEmailVerified("true"), true);
  assert.equal(isGoogleEmailVerified("TRUE"), true);
  assert.equal(isGoogleEmailVerified("false"), false);
  assert.equal(isGoogleEmailVerified(undefined), false);
});

test("readJsonSafe returns fallback on invalid JSON", async () => {
  const response = new Response("not-json", {
    headers: { "Content-Type": "application/json" },
  });

  const data = await readJsonSafe(response, "bad-json");
  assert.equal(data.error, "bad-json");
});

test("readJsonSafe parses valid JSON", async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });

  const data = await readJsonSafe(response, "bad-json");
  assert.deepEqual(data, { ok: true });
});
