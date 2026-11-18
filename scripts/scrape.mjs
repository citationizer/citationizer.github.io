#!/usr/bin/env node
// Standalone web page scraper for Citationizer. Needs Node 18 or newer, no packages.
//
//   node scripts/scrape.mjs https://example.org/some-article
//   node scripts/scrape.mjs <url> <url> ...        several pages in one run
//   node scripts/scrape.mjs <url> --json           machine-readable output
//
// Paste the "Details" block into "What you know about it" and the "Source text" block
// into "Source text you used" for that source in Citationizer.

import { extract } from "../worker/src/extract.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const urls = args.filter((a) => !a.startsWith("--"));

if (!urls.length) {
  console.error("Usage: node scripts/scrape.mjs <url> [more urls] [--json]");
  process.exit(1);
}

const results = [];
for (const u of urls) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https links are supported.");
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; Citationizer/1.0; citation helper)", accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error(`The site answered ${res.status}.`);
    if (!/html/i.test(res.headers.get("content-type") || "")) throw new Error("Only web pages are supported. Paste the text of PDFs by hand.");
    const out = extract(await res.text(), res.url || url.href);
    if (out.words < 30) throw new Error("Almost no readable text. The page may need JavaScript or a login.");
    results.push({ url: u, ...out });
  } catch (e) {
    results.push({ url: u, error: e.message });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (r.error) { console.error(`${r.url}\n  ${r.error}\n`); continue; }
    console.log(`===== ${r.url}\n\n--- Details\n${r.details}\n\n--- Source text\n${r.text}\n\n${r.note}\n`);
  }
}
process.exitCode = results.some((r) => r.error) ? 1 : 0;
