import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

const realFetch = globalThis.fetch;
const env = { ANTHROPIC_API_KEY: "test-key", ACCESS_CODE: "letmein", ALLOWED_ORIGIN: "https://me.github.io", MODEL: "claude-sonnet-5-5" };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

const post = (path, body, headers = {}) =>
  new Request("https://api.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://me.github.io", "x-access-code": "letmein", ...headers },
    body: JSON.stringify(body),
  });

// --- access control and CORS
let res = await worker.fetch(post("/api/format", { prompt: "x" }, { "x-access-code": "nope" }), env, ctx);
assert.equal(res.status, 401);
res = await worker.fetch(post("/api/format", { prompt: "x" }, { origin: "https://evil.example" }), env, ctx);
assert.equal(res.status, 403);
res = await worker.fetch(new Request("https://api.test/api/format", { method: "OPTIONS", headers: { origin: "https://me.github.io" } }), env, ctx);
assert.equal(res.status, 204);
assert.equal(res.headers.get("access-control-allow-origin"), "https://me.github.io");

// --- /api/format streams plain text from Anthropic's event stream
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
let seen;
globalThis.fetch = async (url, init) => {
  seen = { url: String(url), body: JSON.parse(init.body), key: init.headers["x-api-key"] };
  const text = sse([
    { type: "message_start", message: {} },
    { type: "content_block_delta", delta: { type: "text_delta", text: '{"body":"Hello ' } },
    { type: "content_block_delta", delta: { type: "text_delta", text: 'world","references":[]}' } },
    { type: "message_stop" },
  ]);
  // split mid-line to exercise buffering
  const mid = Math.floor(text.length / 2);
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text.slice(0, mid))); c.enqueue(enc.encode(text.slice(mid))); c.close(); } }), { status: 200 });
};
res = await worker.fetch(post("/api/format", { prompt: "format this" }), env, ctx);
assert.equal(res.status, 200);
assert.equal(await res.text(), '{"body":"Hello world","references":[]}');
await Promise.all(pending);
assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
assert.equal(seen.key, "test-key");
assert.equal(seen.body.stream, true);
assert.equal(seen.body.model, "claude-sonnet-5-5");
assert.equal(seen.body.messages[0].content, "format this");

// upstream rate limit is passed on as a friendly code
globalThis.fetch = async () => new Response("{}", { status: 429 });
res = await worker.fetch(post("/api/format", { prompt: "x" }), env, ctx);
assert.equal(res.status, 429);
assert.equal((await res.json()).code, "rate_limited");

// --- /api/scrape
const page = `<html><head><meta name="author" content="Ann Lee"><title>Page</title></head><body><article><p>${"Plenty of readable words here. ".repeat(12)}</p></article></body></html>`;
globalThis.fetch = async (url) => {
  const r = new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  Object.defineProperty(r, "url", { value: String(url) });
  return r;
};
res = await worker.fetch(post("/api/scrape", { url: "https://example.org/a" }), env, ctx);
let j = await res.json();
assert.equal(res.status, 200);
assert.equal(j.ok, true);
assert.match(j.details, /Author: Ann Lee/);
assert.match(j.text, /\[para\. 1\]/);

for (const bad of ["http://localhost/x", "http://127.0.0.1/", "http://192.168.1.5/", "http://169.254.169.254/latest", "ftp://example.org/", "not a url"]) {
  res = await worker.fetch(post("/api/scrape", { url: bad }), env, ctx);
  assert.equal(res.status, 400, bad);
}

globalThis.fetch = async () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } });
res = await worker.fetch(post("/api/scrape", { url: "https://example.org/a.pdf" }), env, ctx);
assert.equal(res.status, 415);

// --- Workers AI path: no API key needed
let aiSeen;
const aiEnv = { ALLOWED_ORIGIN: "https://me.github.io", AI: { run: async (model, input) => { aiSeen = { model, input }; return { response: '{"body":"Hi"}' }; } } };
res = await worker.fetch(post("/api/format", { prompt: "p" }), aiEnv, ctx);
assert.equal(res.status, 200);
assert.equal(await res.text(), '{"body":"Hi"}');
assert.equal(aiSeen.model, "@cf/google/gemma-4-26b-a4b-it");
assert.equal(aiSeen.input.messages[0].content, "p");
assert.equal(aiSeen.input.stream, undefined);
assert.ok(aiSeen.input.max_tokens > 256);

const shapes = [
  { choices: [{ message: { content: '{"body":"Yo"}' } }] },
  { choices: [{ message: { content: [{ type: "text", text: '{"body":"Yo"}' }] } }] },
  { result: { response: '{"body":"Yo"}' } },
  '{"body":"Yo"}',
];
for (const shape of shapes) {
  res = await worker.fetch(post("/api/format", { prompt: "p" }), { ALLOWED_ORIGIN: "https://me.github.io", AI: { run: async () => shape } }, ctx);
  assert.equal(await res.text(), '{"body":"Yo"}', JSON.stringify(shape));
}

res = await worker.fetch(post("/api/format", { prompt: "p" }), { ALLOWED_ORIGIN: "https://me.github.io", AI: { run: async () => { throw new Error("You have used up your daily free allocation of 10,000 neurons."); } } }, ctx);
assert.equal(res.status, 429);
j = await res.json();
assert.equal(j.code, "rate_limited");
assert.match(j.error, /00:00 UTC/);

res = await worker.fetch(post("/api/format", { prompt: "p" }), { ALLOWED_ORIGIN: "https://me.github.io", AI: { run: async () => { throw new Error("boom"); } } }, ctx);
assert.equal(res.status, 502);
res = await worker.fetch(post("/api/format", { prompt: "p" }), { ALLOWED_ORIGIN: "https://me.github.io", AI: { run: async () => ({}) } }, ctx);
assert.equal(res.status, 502);
res = await worker.fetch(post("/api/format", { prompt: "p" }), { ALLOWED_ORIGIN: "https://me.github.io" }, ctx);
assert.equal(res.status, 500);

// both configured: Workers AI wins unless PROVIDER is "anthropic"
let anthropicCalled = false;
globalThis.fetch = async () => { anthropicCalled = true; return new Response(sse([{ type: "content_block_delta", delta: { type: "text_delta", text: "C" } }])); };
const both = { ALLOWED_ORIGIN: "https://me.github.io", ANTHROPIC_API_KEY: "k", AI: { run: async () => ({ response: "A" }) } };
res = await worker.fetch(post("/api/format", { prompt: "p" }), both, ctx);
assert.equal(await res.text(), "A");
assert.equal(anthropicCalled, false);
res = await worker.fetch(post("/api/format", { prompt: "p" }), { ...both, PROVIDER: "anthropic" }, ctx);
assert.equal(await res.text(), "C");
await Promise.all(pending);

globalThis.fetch = realFetch;
console.log("worker tests passed");
