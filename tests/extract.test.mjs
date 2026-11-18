import assert from "node:assert/strict";
import { extract } from "../worker/src/extract.js";

const html = `<!doctype html><html><head>
<title>Starting a Community Garden | Greenline Guides</title>
<meta property="og:title" content="Starting a Community Garden">
<meta property="og:site_name" content="Greenline Guides">
<meta name="author" content="Marisol Tran">
<meta property="article:published_time" content="2022-03-03T09:00:00Z">
<script type="application/ld+json">{"@type":"Article","publisher":{"@type":"Organization","name":"Greenline Alliance"}}</script>
<script>var x = "<p>script text that is not content at all</p>";</script>
</head><body>
<nav><ul><li>Home page navigation link text that should never appear</li></ul></nav>
<article>
<h1>Starting a Community Garden</h1>
<p>A typical plot needs only soil, a water source, and a group willing to share tools.</p>
<p>Most gardens fail in their second year when the first wave of volunteers moves on &amp; stops showing up.</p>
<p>Short.</p>
<ul><li>Agree on a regular work schedule early and write it down.</li></ul>
</article>
<footer><p>Copyright notice that should be removed from the output text.</p></footer>
</body></html>`;

const out = extract(html, "https://example.org/start-a-garden");

assert.match(out.details, /Author: Marisol Tran/);
assert.match(out.details, /Title: Starting a Community Garden\n/, "site suffix is trimmed from the title");
assert.match(out.details, /Website: Greenline Guides/);
assert.match(out.details, /Publisher: Greenline Alliance/);
assert.match(out.details, /Published: 2022-03-03/);
assert.match(out.details, /URL: https:\/\/example\.org\/start-a-garden/);

assert.match(out.text, /\[para\. 1\] A typical plot/);
assert.match(out.text, /\[para\. 2\] Most gardens fail .* & stops/);
assert.match(out.text, /\[para\. 3\] Agree on a regular work schedule/);
assert.ok(!/Short\./.test(out.text), "very short lines are dropped");
assert.ok(!/Home page navigation|script text|Copyright notice/.test(out.text), "page furniture is removed");
assert.match(out.text, /## Starting a Community Garden/);
assert.equal(out.type, "");

const journal = extract(`<html><head><meta name="citation_title" content="A Study"><meta name="citation_author" content="Okafor, Rui"><meta name="citation_journal_title" content="Journal of Urban Ecology"><meta name="citation_volume" content="14"><meta name="citation_issue" content="2"><meta name="citation_firstpage" content="101"><meta name="citation_lastpage" content="118"><meta name="citation_doi" content="10.1000/xyz"></head><body><main><p>${"Word ".repeat(40)}</p></main></body></html>`, "https://example.org/a");
assert.equal(journal.type, "journal");
assert.match(journal.details, /Journal: Journal of Urban Ecology, volume 14, issue 2, pages 101-118/);
assert.match(journal.details, /DOI: 10\.1000\/xyz/);

console.log("extract tests passed");
