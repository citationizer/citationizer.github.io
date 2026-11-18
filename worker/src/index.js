// Citationizer API: a Cloudflare Worker with two routes.
//   POST /api/scrape  { url }     -> fetches a web page and returns its details and text
//   POST /api/format  { prompt }  -> runs the AI and returns its answer as plain text
//
// The AI is Cloudflare Workers AI by default: the "AI" binding in wrangler.toml, no API key needed.
// Settings (see README): ACCESS_CODE (secret, optional), ALLOWED_ORIGIN, AI_MODEL, AI_MAX_TOKENS.
// Optional: set ANTHROPIC_API_KEY (secret) and PROVIDER="anthropic" to use Claude instead (MODEL, MAX_TOKENS).

import { extract } from "./extract.js";

const MAX_PROMPT_CHARS = 300000;
const MAX_PAGE_BYTES = 2000000;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const origin = request.headers.get("origin");
    if (origin && !cors["access-control-allow-origin"]) {
      return json({ ok: false, code: "forbidden", error: "This site is not allowed to use the server." }, 403, cors);
    }
    if (request.method !== "POST") return json({ ok: false, code: "not_found", error: "Not found." }, 404, cors);

    if (env.ACCESS_CODE && !same(request.headers.get("x-access-code") || "", String(env.ACCESS_CODE))) {
      return json({ ok: false, code: "unauthorized", error: "The access code is missing or wrong." }, 401, cors);
    }

    const path = new URL(request.url).pathname;
    if (path === "/api/scrape") return scrape(request, cors);
    if (path === "/api/format") return format(request, env, ctx, cors);
    return json({ ok: false, code: "not_found", error: "Not found." }, 404, cors);
  },
};

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin") || "";
  const h = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-access-code",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (!allowed.length) h["access-control-allow-origin"] = "*";
  else if (allowed.includes(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function isPrivateHost(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return !host.includes(".");
}

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      chunks.push(value.subarray(0, value.length - (size - max)));
      try { await reader.cancel(); } catch { /* already closed */ }
      size = max;
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return new TextDecoder("utf-8").decode(buf);
}

async function scrape(request, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, code: "bad_request", error: "Send JSON with a url." }, 400, cors); }

  let target;
  try { target = new URL(String(body.url || "").trim()); } catch {
    return json({ ok: false, code: "bad_url", error: "That does not look like a web address." }, 400, cors);
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    return json({ ok: false, code: "bad_url", error: "Only public http and https addresses are allowed." }, 400, cors);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  let res;
  try {
    res = await fetch(target, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; Citationizer/1.0; citation helper)", accept: "text/html,application/xhtml+xml" },
    });
  } catch {
    return json({ ok: false, code: "fetch_failed", error: "Could not reach that page. Paste the text yourself." }, 502, cors);
  } finally {
    clearTimeout(timer);
  }

  if (res.url && isPrivateHost(new URL(res.url).hostname)) {
    return json({ ok: false, code: "bad_url", error: "That page redirected somewhere that is not allowed." }, 400, cors);
  }
  if (!res.ok) {
    return json({ ok: false, code: "fetch_failed", error: `The site answered ${res.status}. Paste the text yourself.` }, 502, cors);
  }
  if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") || "")) {
    return json({ ok: false, code: "unsupported", error: "Only web pages are supported. Paste the text of PDFs and other files." }, 415, cors);
  }

  const html = await readLimited(res, MAX_PAGE_BYTES);
  const out = extract(html, res.url || target.href);
  if (out.words < 30) {
    return json({ ok: false, code: "empty", error: "The page had almost no readable text. It may need JavaScript or a login. Paste the text yourself." }, 422, cors);
  }
  return json({ ok: true, ...out }, 200, cors);
}

async function format(request, env, ctx, cors) {
  const useAnthropic = Boolean(env.ANTHROPIC_API_KEY) && (env.PROVIDER === "anthropic" || !env.AI);
  if (!useAnthropic && !env.AI) {
    return json({ ok: false, code: "server", error: "The server has no AI set up. Add the Workers AI binding to wrangler.toml (see the README)." }, 500, cors);
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, code: "bad_request", error: "Send JSON with a prompt." }, 400, cors); }
  const prompt = String(body.prompt || "");
  if (!prompt.trim()) return json({ ok: false, code: "bad_request", error: "The prompt was empty." }, 400, cors);
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json({ ok: false, code: "too_large", error: "That is too much to format at once." }, 413, cors);
  }

  if (!useAnthropic) return formatWorkersAI(prompt, env, cors);

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.MODEL || "claude-sonnet-5-5",
      max_tokens: Number(env.MAX_TOKENS) || 16000,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const code = upstream.status === 429 ? "rate_limited" : "server";
    const error = upstream.status === 429 ? "Too many requests right now. Wait a minute, then try again." : "The formatting service failed. Try again.";
    return json({ ok: false, code, error }, upstream.status === 429 ? 429 : 502, cors);
  }

  const { readable, writable } = new TransformStream();
  ctx.waitUntil(pump(upstream.body, writable));
  return new Response(readable, {
    headers: { ...cors, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

// Turns Anthropic's server-sent events into a plain stream of the text Claude writes.
async function pump(src, dest) {
  const reader = src.getReader();
  const writer = dest.getWriter();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          await writer.write(enc.encode(ev.delta.text));
        }
      }
    }
  } catch {
    /* the stream ends early; the page reports an incomplete result */
  } finally {
    try { await writer.close(); } catch { /* already closed */ }
  }
}

// Cloudflare Workers AI. Waits for the whole answer and returns it as plain text.
// Different models return different shapes, so the text is picked out tolerantly.
async function formatWorkersAI(prompt, env, cors) {
  const model = env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  let out;
  try {
    out = await env.AI.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: Number(env.AI_MAX_TOKENS) || 8000,
      temperature: 0.2,
    });
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (/neuron|daily|allocation|quota|limit/i.test(msg)) {
      return json({ ok: false, code: "rate_limited", error: "The free daily AI allowance is used up. It resets at 00:00 UTC. Try again then." }, 429, cors);
    }
    return json({ ok: false, code: "server", error: "The AI model failed. Try again, or pick another AI_MODEL (see the README)." }, 502, cors);
  }
  const text = pickText(out);
  if (!text) return json({ ok: false, code: "server", error: "The AI model returned nothing. Try again." }, 502, cors);
  return new Response(text, { headers: { ...cors, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function pickText(out) {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return "";
  const c = out.choices && out.choices[0];
  const msg = c && c.message && c.message.content;
  const parts = [out.response, out.result && out.result.response, typeof msg === "string" ? msg : "", c && c.text, out.output_text];
  if (Array.isArray(msg)) parts.push(msg.map((p) => (p && p.text) || "").join(""));
  const hit = parts.find((p) => typeof p === "string" && p.trim());
  return hit || "";
}
