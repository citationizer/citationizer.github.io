// Shared by the Cloudflare Worker and the command-line scraper.
// No dependencies and no DOM, so it runs in Workers, Node and tests.
//
// extract(html, pageUrl) returns:
//   details  text block for the "What you know about it" box (author, title, site, date, DOI, URL)
//   type     "journal" | "book" | "" (only set when the page says so)
//   text     readable page text, with [para. N] markers counting paragraphs
//   words    word count of the text, markers excluded
//   note     one line about page numbers

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©",
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseAttrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function collectMeta(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    const key = (a.name || a.property || a.itemprop || "").toLowerCase();
    if (key && a.content !== undefined && a.content.trim()) (map[key] ||= []).push(a.content.trim());
  }
  return map;
}

function walkLd(node, out) {
  if (Array.isArray(node)) return node.forEach((n) => walkLd(n, out));
  if (!node || typeof node !== "object") return;
  const t = [].concat(node["@type"] || []).join(" ");
  if (/Article|BlogPosting|NewsArticle|WebPage|Report/i.test(t)) out.push(node);
  if (node["@graph"]) walkLd(node["@graph"], out);
}

function jsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { walkLd(JSON.parse(m[1].trim()), out); } catch { /* ignore malformed JSON-LD */ }
  }
  return out;
}

const nameList = (v) =>
  [].concat(v || [])
    .map((a) => (typeof a === "string" ? a : a && a.name))
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter((s) => s && !/^https?:\/\//i.test(s));

const first = (arr) => (arr && arr.length ? arr[0] : "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pickContainer(html) {
  for (const re of [/<article\b[\s\S]*?<\/article>/gi, /<main\b[\s\S]*?<\/main>/gi]) {
    const found = html.match(re) || [];
    if (found.length) return found.sort((a, b) => stripTags(b).length - stripTags(a).length)[0];
  }
  const body = /<body\b[\s\S]*<\/body>/i.exec(html);
  return body ? body[0] : html;
}

function readableBlocks(container) {
  const out = [];
  const re = /<(h[1-6]|p|li|pre|figcaption|dt|dd|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(container))) {
    const text = stripTags(m[2]);
    if (text) out.push({ tag: m[1].toLowerCase(), text });
  }
  return out;
}

export function extract(html, pageUrl = "") {
  html = String(html || "");
  const meta = collectMeta(html);
  const ld = jsonLd(html)[0] || {};

  // Metadata first, from the raw page, before scripts are removed.
  const rawTitle = first(meta["citation_title"]) || first(meta["og:title"]) || (ld.headline ? String(ld.headline) : "") ||
    stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");
  const site = first(meta["og:site_name"]) || first(meta["application-name"]) || "";
  const publisher = first(meta["citation_publisher"]) || (ld.publisher && ld.publisher.name ? String(ld.publisher.name) : "");
  const relAuthor = stripTags((/<a\b[^>]*rel\s*=\s*["'][^"']*author[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(html) || [])[1] || "");
  const authors = [...new Set([
    ...(meta["citation_author"] || []),
    ...(meta["author"] || []).filter((a) => !/^https?:\/\//i.test(a)),
    ...nameList(ld.author),
    ...(relAuthor ? [relAuthor] : []),
  ])].slice(0, 6);
  const dateRaw = first(meta["citation_publication_date"]) || first(meta["citation_date"]) || first(meta["article:published_time"]) ||
    first(meta["date"]) || (ld.datePublished ? String(ld.datePublished) : "") ||
    ((/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(html) || [])[1] || "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : dateRaw;
  const journal = first(meta["citation_journal_title"]);
  const volume = first(meta["citation_volume"]);
  const issue = first(meta["citation_issue"]);
  const first_p = first(meta["citation_firstpage"]);
  const last_p = first(meta["citation_lastpage"]);
  const pages = first_p ? (last_p ? `${first_p}-${last_p}` : first_p) : "";
  const doi = first(meta["citation_doi"]) || first(meta["dc.identifier"]) || "";

  const title = site ? rawTitle.replace(new RegExp("\\s*[|\\-–—:]\\s*" + escapeRe(site) + "\\s*$", "i"), "").trim() : rawTitle;

  const d = [];
  if (authors.length) d.push("Author: " + authors.join("; "));
  if (title) d.push("Title: " + title);
  if (journal) d.push("Journal: " + journal + (volume ? ", volume " + volume : "") + (issue ? ", issue " + issue : "") + (pages ? ", pages " + pages : ""));
  else if (site) d.push("Website: " + site);
  if (publisher && publisher !== site) d.push("Publisher: " + publisher);
  if (date) d.push("Published: " + date);
  if (doi) d.push("DOI: " + doi.replace(/^doi:\s*/i, ""));
  if (pageUrl) d.push("URL: " + pageUrl);

  const type = journal ? "journal" : first(meta["og:type"]) === "book" ? "book" : "";

  // Readable text: drop everything that is not content, find the article, number paragraphs.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|aside|button|select)\b[\s\S]*?<\/\1>/gi, "");
  const lines = [];
  let n = 0, prev = "";
  for (const b of readableBlocks(pickContainer(cleaned))) {
    if (b.text === prev) continue;
    prev = b.text;
    if (/^h[1-6]$/.test(b.tag)) { lines.push("## " + b.text); continue; }
    const min = b.tag === "p" || b.tag === "pre" ? 20 : 30;
    if (b.text.length < min) continue;
    if (b.tag === "p" || b.tag === "li") { n += 1; lines.push(`[para. ${n}] ${b.text}`); }
    else lines.push(b.text);
  }
  let text = lines.join("\n\n");
  if (text.length > 40000) text = text.slice(0, text.lastIndexOf("\n\n", 40000) > 0 ? text.lastIndexOf("\n\n", 40000) : 40000);
  const words = text.replace(/\[para\. \d+\]/g, "").split(/\s+/).filter(Boolean).length;

  return {
    details: d.join("\n"),
    type,
    text,
    words,
    note: "Web pages have no printed page numbers. [para. N] markers count paragraphs, which APA can use. MLA credits will show the author only.",
  };
}
