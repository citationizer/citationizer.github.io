# Citationizer

Paste a paper and its sources, pick MLA 9 or APA 7, and get the paper formatted with in-text credits and a reference list. Download it as a Word file.

```
docs/      the site (GitHub Pages serves this folder)
worker/    Cloudflare Worker: reads web pages and runs the AI, so nothing secret sits in the site
scripts/   scrape.mjs, a standalone web page scraper (Node 18+, no packages)
tests/     npm test
```

## What the pieces do

- **The site** takes your paper, details and sources, builds the prompt, shows the formatted paper, and exports a .docx. It talks only to your Worker.
- **The Worker** has two routes. `/api/scrape` fetches a public web page and returns its details (author, title, site, date, DOI) and readable text with `[para. N]` markers. `/api/format` runs the AI on the prompt and returns the answer.
- **The AI** is Cloudflare Workers AI. It needs no API key and no extra account: it runs from the same free Cloudflare account that hosts the Worker.
- **The scraper script** does the same page reading as `/api/scrape`, from your own machine, with no server.

## Set it up

You need a free GitHub account and a free Cloudflare account. No AI API key.

### 1. Put the repo on GitHub

```bash
git init
git add .
git commit -m "Citationizer"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/citationizer.git
git push -u origin main
```

### 2. Turn on GitHub Pages

Repo Settings, Pages, "Deploy from a branch", branch `main`, folder `/docs`. The site appears at `https://YOUR-USERNAME.github.io/citationizer/`.

### 3. Deploy the Worker

```bash
cd worker
npx wrangler login
```

Open `wrangler.toml` and set `ALLOWED_ORIGIN` to `https://YOUR-USERNAME.github.io` (origin only, no path). Then:

```bash
npx wrangler secret put ACCESS_CODE      # optional, strongly recommended
npx wrangler deploy
```

Wrangler prints an address like `https://citationizer-api.your-name.workers.dev`.

`ACCESS_CODE` matters. `ALLOWED_ORIGIN` only stops other websites from calling your Worker in a browser. Anyone can still call the Worker directly, and every format request uses up your daily AI allowance. With an access code set, requests without it are refused. Type the code into "Server access code" on the site once; the browser remembers it.

### 4. Point the site at the Worker

Edit `docs/config.js`:

```js
window.CITATIONIZER = { api: "https://citationizer-api.your-name.workers.dev" };
```

Commit and push. Done.

## The free AI allowance

Workers AI gives 10,000 Neurons per day on the free plan, reset at 00:00 UTC. When it runs out, the site shows a message saying so and works again after the reset. Check your usage on the Cloudflare dashboard under Workers AI. Going past the allowance needs the Workers Paid plan.

The default model is `@cf/google/gemma-4-26b-a4b-it`. To try another, change `AI_MODEL` in `worker/wrangler.toml` to any text model from the Workers AI catalog and redeploy. Some models need a paid plan; if one fails, switch back.

Free models follow strict citation rules less reliably than a top-tier model. Always read the result, check the Changes tab, and check the reference list against your sources.

To use Claude instead, set `PROVIDER = "anthropic"` in `wrangler.toml` and run `npx wrangler secret put ANTHROPIC_API_KEY`. That needs a paid Anthropic API key.

## Run it locally

```bash
cp worker/.dev.vars.example worker/.dev.vars
npm run dev:api                                  # Worker on http://localhost:8787
npx serve docs                                   # site on http://localhost:3000
```

Set `api` in `docs/config.js` to `http://localhost:8787` and add `http://localhost:3000` to `ALLOWED_ORIGIN` while testing. Workers AI calls from `wrangler dev` use your Cloudflare login and count against the same allowance.

## The scraper script

```bash
node scripts/scrape.mjs https://example.org/article
node scripts/scrape.mjs <url> <url> --json
```

It prints a Details block and a Source text block. Paste them into "What you know about it" and "Source text you used" for that source.

## What the scraper can and cannot do

- It reads HTML pages. It does not read PDFs, pages that build their content with JavaScript, or pages behind a login or paywall. For those, paste the text yourself.
- Web pages have no printed page numbers. The `[para. N]` markers are counted by the scraper. APA 7 allows paragraph numbers for pages without page numbers, so APA credits use them. MLA 9 does not, so MLA credits for web pages show the author only.
- For real page numbers (books, journal PDFs), paste the text with markers like `[p. 12]` where each page starts. The formatter uses a page number only when a marker covers the passage, and warns when it cannot find one.
- The details block comes from the page's own tags, which are sometimes missing or wrong. Check the reference entry it produces.

## Settings

Set in `worker/wrangler.toml`:

| Setting | Default | What it does |
| --- | --- | --- |
| `ALLOWED_ORIGIN` | your Pages address | Sites allowed to use the Worker; separate several with commas |
| `AI_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Workers AI model used for formatting |
| `AI_MAX_TOKENS` | `8000` | Longest answer allowed; very long papers need more |
| `PROVIDER` | not set | Set to `anthropic` to use Claude (needs `ANTHROPIC_API_KEY`) |
| `MODEL`, `MAX_TOKENS` | `claude-sonnet-5-5`, `16000` | Claude settings, used only with `PROVIDER = "anthropic"` |

## Privacy

Your paper and source text go from your browser to your Worker and on to Cloudflare Workers AI (or the Anthropic API if you switch). The Worker stores nothing. Do not paste text you are not allowed to share.

## Tests

```bash
npm test                      # page extractor
node tests/worker.test.mjs    # Worker routes with mocked network and AI calls
```
