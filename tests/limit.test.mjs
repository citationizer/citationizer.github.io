import assert from "node:assert/strict";
import worker, { Limiter } from "../worker/src/index.js";

const ORIGIN = "https://me.github.io";
const ctx = { waitUntil() {} };
const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock = 1_700_000_000_000;
Date.now = () => clock;

// An in-memory stand-in for the Durable Object namespace, running the real Limiter class.
function fakeLimiter() {
  const objects = new Map();
  const names = [];
  return {
    names,
    idFromName(n) { names.push(n); return n; },
    get(id) {
      if (!objects.has(id)) {
        const m = new Map();
        objects.set(id, new Limiter({ storage: { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) } }));
      }
      const o = objects.get(id);
      return { fetch: (url, init) => o.fetch(new Request(url, init)) };
    },
  };
}

function makeEnv(extra = {}) {
  let calls = 0;
  const env = {
    ALLOWED_ORIGIN: ORIGIN,
    ACCESS_CODE: "owner-secret",
    LIMITER: fakeLimiter(),
    AI: { run: async () => { calls++; return { response: '{"body":"ok"}' }; } },
    ...extra,
  };
  return { env, calls: () => calls };
}

const post = (path, body, { ip = "1.2.3.4", code = "" } = {}) =>
  new Request("https://api.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip, "x-access-code": code },
    body: JSON.stringify(body),
  });

const fmt = (env, opts) => worker.fetch(post("/api/format", { prompt: "p" }, opts), env, ctx);

// --- 3 formats per IP, then a clear message
{
  const { env, calls } = makeEnv();
  for (const left of ["2", "1", "0"]) {
    const res = await fmt(env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-uses-left"), left);
    assert.equal(res.headers.get("x-uses-limit"), "3");
    assert.equal(res.headers.get("access-control-expose-headers"), "x-uses-left, x-uses-limit");
  }
  clock += 75 * 60000; // 75 minutes later
  const blocked = await fmt(env);
  assert.equal(blocked.status, 429);
  const j = await blocked.json();
  assert.equal(j.code, "limit_reached");
  assert.equal(j.error, "You've used all 3 free formats for this 4-hour window. You can format again in 2 hours 45 minutes.");
  assert.equal(calls(), 3, "the AI is not called once the limit is hit");

  // another visitor has their own allowance
  assert.equal((await fmt(env, { ip: "5.6.7.8" })).status, 200);

  // the window slides: the oldest use expires after 4 hours
  clock += 165 * 60000 + 1000; // now just past 4 hours since the first use
  assert.equal((await fmt(env)).status, 200);
  clock += 1000;
  const again = await fmt(env);
  assert.equal(again.status, 200, "second use also expired");
}

// --- the owner's code skips the limit, and a wrong code does not
{
  const { env } = makeEnv();
  for (let i = 0; i < 6; i++) {
    const res = await fmt(env, { code: "owner-secret" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-uses-left"), null, "owner gets no counter");
  }
  for (let i = 0; i < 3; i++) assert.equal((await fmt(env, { code: "wrong" })).status, 200);
  assert.equal((await fmt(env, { code: "wrong" })).status, 429);
}

// --- failures do not use up a turn
{
  let fail = true;
  const { env } = makeEnv({ AI: { run: async () => { if (fail) throw new Error("boom"); return { response: "x" }; } } });
  for (let i = 0; i < 5; i++) assert.equal((await fmt(env)).status, 502);
  fail = false;
  for (let i = 0; i < 3; i++) assert.equal((await fmt(env)).status, 200);
  assert.equal((await fmt(env)).status, 429);
}

// --- fetching pages has its own, larger allowance
{
  const { env } = makeEnv({ FETCH_LIMIT: "2" });
  const html = `<html><body><article><p>${"Plenty of readable words here. ".repeat(12)}</p></article></body></html>`;
  globalThis.fetch = async (url) => {
    const r = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(r, "url", { value: String(url) });
    return r;
  };
  const scrape = () => worker.fetch(post("/api/scrape", { url: "https://example.org/a" }), env, ctx);
  assert.equal((await scrape()).status, 200);
  assert.equal((await scrape()).status, 200);
  const blocked = await scrape();
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /fetched 2 pages in this 4-hour window/);
  assert.equal((await fmt(env)).status, 200, "formats are unaffected by fetches");
  globalThis.fetch = realFetch;
}

// --- settings are respected
{
  const { env } = makeEnv({ USE_LIMIT: "1", WINDOW_HOURS: "1" });
  assert.equal((await fmt(env)).status, 200);
  const blocked = await fmt(env);
  assert.equal((await blocked.json()).error, "You've used all 1 free formats for this 1-hour window. You can format again in 1 hour.");
}

// --- raw IPs are never stored as names
{
  const { env } = makeEnv();
  await fmt(env, { ip: "203.0.113.77" });
  assert.ok(env.LIMITER.names.length > 0);
  assert.ok(env.LIMITER.names.every((n) => !n.includes("203.0.113.77")));
}

// --- limiter down: say so instead of letting everyone through
{
  const { env } = makeEnv({ LIMITER: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) } });
  const res = await fmt(env);
  assert.equal(res.status, 503);
}

Date.now = realNow;
console.log("limit tests passed");
