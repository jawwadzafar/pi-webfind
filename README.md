<p align="center">
  <img alt="pi-webfind logo" src="docs/public/logo.png" width="128">
</p>

<h1 align="center">pi-webfind</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-webfind"><img alt="npm version" src="https://img.shields.io/npm/v/pi-webfind?style=flat-square&color=cb3837" /></a>
  <a href="https://github.com/jawwadzafar/pi-webfind/actions/workflows/deploy-docs.yml"><img alt="docs" src="https://img.shields.io/website?url=https%3A%2F%2Fjawwadzafar.github.io%2Fpi-webfind%2F&style=flat-square&label=docs" /></a>
  <a href="https://github.com/jawwadzafar/pi-webfind/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/pi-webfind?style=flat-square" /></a>
  <a href="https://github.com/jawwadzafar/pi-webfind/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/jawwadzafar/pi-webfind?style=flat-square&color=b5bd68" /></a>
</p>

<p align="center">
  <b>Claude Code-style web research for the <a href="https://github.com/earendil-works/pi">pi coding agent</a>.<br>100% free — no API keys, no signups, zero dependencies.</b>
</p>

<p align="center">
  <a href="https://jawwadzafar.github.io/pi-webfind/">Docs</a> ·
  <a href="https://github.com/jawwadzafar/pi-webfind/releases">Releases</a> ·
  <a href="#security">Security</a>
</p>

---

## Install

```bash
pi install npm:pi-webfind
```

or straight from GitHub:

```bash
pi install git:github.com/jawwadzafar/pi-webfind
```

## What it does

Same muscle memory as Claude Code's WebSearch — `⏺ Web Search("query")`
headers, live status, `✓ 8 results · ddg+brave · 2.1s`, expandable rows,
document reading, grouped synthesis. No cost, no keys.

![research session](https://jawwadzafar.github.io/pi-webfind/screenshot.png)

**7 tools + 1 command:**

| Tool | Best for |
|---|---|
| `web_search` | news, articles, broad queries — DuckDuckGo + Brave + Bing RSS, RRF-fused |
| `fetch_page` | read any URL — HTML/PDF/JSON, query-aware passages, bot-wall busting |
| `search_stackoverflow` | error messages, debugging |
| `search_wikipedia` | definitions, concepts, history |
| `search_npm` | JS/TS packages with quality scores |
| `search_github` | repos, stars, languages |
| `search_hn` | tech community opinion, launches |
| `/research <topic>` | parallel multi-source research → grouped briefing |

## Reading comprehension, not just fetching

- **`fetch_page` with `query`** — returns the intro plus the most
  query-relevant passages (BM25, heading trails), not the first 8,000
  characters. The difference between an infobox dump and the two paragraphs
  that answer you.
- **`web_search` with `deep: true`** — reads the top results in parallel and
  attaches a query-relevant excerpt to every row. Factual questions often
  answer themselves without a single fetch.
- **Markdown extraction** — density-scored article detection turns pages into
  structured markdown; Wikipedia arrives as prose, not `{{cite web}}` soup.
- **Site adapters** — GitHub repos/issues/PRs/files, Stack Overflow, HN,
  Reddit and Wikipedia skip scraping entirely and come from their clean free
  APIs. The output header tells you which served you (`github-issue-api`,
  `stackexchange-api`, …).

<div align="center">
<video src="https://jawwadzafar.github.io/pi-webfind/demo.mp4" controls muted playsinline width="100%"></video>
<p><sub>70s: <code>/research do browsers cache dns how long</code> — multi-engine search, source dives, final briefing with citations</sub></p>
</div>

## When engines fight back

Every search and fetch walks a fallback ladder before admitting failure:

```text
web_search   DDG html → lite → POST → r.jina.ai proxy → Bing RSS
             → engine "multi": DDG ∥ Brave ∥ Bing in parallel, RRF-fused
             → any primary failure auto-retries via multi

fetch_page   site adapter (GitHub/SE/HN/Reddit/Wikipedia APIs)
             → direct fetch (browser UA, 3× backoff)
             → 401/403/429/503 → Wayback Machine snapshot
             → thin/SPA page → r.jina.ai headless render
             → block-page detection (never shows fake content as success)
```

Disk-backed caches (`~/.pi/agent/cache/webfind/`) survive restarts: 10-min
search, 1-h fetch. `refresh` / `no_cache` flags skip them.

## Security

pi-webfind runs with full system access like any pi extension. What it does
with it:

- **Outbound HTTPS only** — search engines, public APIs, pages you fetch
- **SSRF-guarded** — localhost, private ranges and link-local addresses are blocked
- **Never executes or writes fetched content**; it reads URLs and returns text
- Politeness throttle per host; fake-browser UA only where required, honest
  `pi-webfind/x.y` UA everywhere it matters
- The only optional credential is `GITHUB_TOKEN` (lifts GitHub's 10 req/min
  anonymous limit). Everything else is keyless by design.

## Limits (be honest about free)

- Scraped engines tighten defenses anytime — the fallback ladder is the mitigation
- Unauthenticated GitHub is 10 req/min (see `GITHUB_TOKEN` above)
- Result dates appear only when engines provide them (DDG stamps, Bing pubDates)
- Public SearXNG instances rate-limit cloud IPs; jina proxy + Brave cover that gap

## Docs

Full tool reference, parameters and guides at
**[jawwadzafar.github.io/pi-webfind](https://jawwadzafar.github.io/pi-webfind/)**.

## License

MIT
