import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EID_PATTERN,
  buildHeaders,
  createEid,
  parseAuth,
  providerModels,
  toModelSeeds,
} from "../extensions/omnirush.ts";

test("createEid produces opencode EID shape", () => {
  for (let i = 0; i < 50; i++) {
    const ses = createEid("ses");
    const msg = createEid("msg");
    assert.match(ses, EID_PATTERN);
    assert.match(msg, EID_PATTERN);
    assert.ok(ses.startsWith("ses_"));
    assert.ok(msg.startsWith("msg_"));
  }
});

test("createEid is unique across rapid calls", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = createEid("ses");
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test("parseAuth handles full file", () => {
  const auth = parseAuth(
    JSON.stringify({
      accessToken: "omnirush-0abc",
      refreshToken: "omr_xyz",
      gatewayUrl: "https://omnirush.ai/omnirush/v1",
      savedAt: "2026-11-01T12:00:00.000Z",
    }),
  );
  assert.equal(auth.accessToken, "omnirush-0abc");
  assert.equal(auth.refreshToken, "omr_xyz");
  assert.equal(auth.gatewayUrl, "https://omnirush.ai/omnirush/v1");
  assert.equal(typeof auth.savedAt, "number");
});

test("parseAuth tolerates missing/garbage", () => {
  assert.deepEqual(parseAuth(""), {});
  assert.deepEqual(parseAuth("not json"), {});
  assert.deepEqual(parseAuth(undefined), {});
});

test("buildHeaders produces the gateway fingerprint", () => {
  const auth = { accessToken: "tok123", refreshToken: "ref" };
  const headers = buildHeaders(auth, "ses_abcd", "2.7.1");
  assert.deepEqual(headers, {
    "user-agent": "omnirush",
    "x-omnirush-client": "cli/2.7.1",
    "x-omnirush-session-id": "ses_abcd",
    authorization: "Bearer tok123",
  });
});

test("buildHeaders omits authorization without token", () => {
  const headers = buildHeaders({}, "ses_abcd", "2.7.1");
  assert.equal("authorization" in headers, false);
  assert.equal(headers["user-agent"], "omnirush");
});

test("toModelSeeds maps catalog payload", () => {
  const payload = {
    data: [
      {
        id: "gpt-6-astra",
        display_name: "GPT 6 Astra",
        status: "active",
        limits: { context: 400000, output: 128000 },
        capabilities: { reasoning: true, image_input: true },
      },
      { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", status: "active", limits: { context: 400000, output: 128000 }, capabilities: { reasoning: true } },
      { id: "gpt-6-deprecated", display_name: "Old", status: "deprecated", limits: { context: 10, output: 10 }, capabilities: {} },
      { id: 123 },
    ],
  };
  const seeds = toModelSeeds(payload);
  assert.equal(seeds.length, 2);
  assert.deepEqual(seeds[0], {
    id: "gpt-6-astra",
    name: "GPT 6 Astra",
    reasoning: true,
    input: ["text", "image"],
    context: 400000,
    output: 128000,
  });
  assert.deepEqual(seeds[1].input, ["text"]);
});

test("toModelSeeds handles empty/bad payload", () => {
  assert.deepEqual(toModelSeeds(undefined), []);
  assert.deepEqual(toModelSeeds({}), []);
  assert.deepEqual(toModelSeeds({ data: "nope" }), []);
});

test("providerModels maps seeds into Pi model defs", () => {
  const models = providerModels([
    { id: "gpt-6-astra", name: "GPT 6 Astra", reasoning: true, input: ["text", "image"], context: 400000, output: 128000 },
  ]);
  assert.equal(models.length, 1);
  const m = models[0] as Record<string, unknown>;
  assert.equal(m.type, "chat");
  assert.equal(m.id, "gpt-6-astra");
  assert.equal(m.reasoning, true);
  assert.equal(m.contextWindow, 400000);
  assert.equal(m.maxTokens, 128000);
  assert.deepEqual((m.cost as Record<string, unknown>).input, 0);
});
