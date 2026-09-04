# pi-webfind

**Claude Code-style web research for the [pi coding agent](https://github.com/earendil-works/pi) — free, no API keys, no signups.**

Same muscle memory as Claude Code's WebSearch: `⏺ Web Search("query")` headers,
live status, `✓ 8 results · ddg+brave · 2.1s`, expandable results, document
reading, grouped synthesis via `/research`. Zero cost.

Docs: **https://jawwadzafar.github.io/pi-webfind/**

```bash
pi install /path/to/pi-webfind                             # local
pi install git:github.com/jawwadzafar/pi-webfind           # once pushed
```

## Why "webfind"

- `find`, but for the web — search + fetch + read
- short, unique on npm and GitHub (zero collisions at publish time)
- no "-free" suffix: freedom is in the description line, not the name

## Tools (7)

| Tool | Source | Best for |
|---|---|---|
| `web_search` | DuckDuckGo (×3 endpoints) + Brave + Bing RSS, RRF-merged | news, articles, broad queries |
| `fetch_page` | any URL | HTML/PDF/JSON extraction, bot-wall busting |
| `search_stackoverflow` | Stack Exchange API | error messages, debugging |
| `search_wikipedia` | MediaWiki API | definitions, concepts, history |
| `search_npm` | npm registry API | JS/TS packages + quality scores |
| `search_github` | GitHub API | repos, stars, languages |
| `search_hn` | HN Algolia API | tech community opinion, launches |

Plus: **`/research <topic>`** — runs web+HN+GitHub+Wikipedia in parallel,
fetches the top pages, shows live progress in the footer widget, then hands
everything to the model for a grouped "documents worth reading + recurring
conclusions" briefing (the Claude Code research flow).

## Reading comprehension (the P0 features)

- **`fetch_page` with `query`** — instead of the page head, returns the intro
  plus the most query-relevant passages (BM25 ranking with heading trails,
  junk penalty), in document order. The difference between reading a 60k-char
  infobox dump and the two paragraphs that answer the question.
- **`web_search` with `deep: true`** (or a count 1–8) — reads the top results
  in parallel and attaches a query-relevant excerpt to each row. For factual
  questions this often removes the need to fetch any page at all.
- **Markdown extraction** — pages come back as structured markdown (headings,
  links, code fences, lists, tables) from a density-scored article detector,
  not flattened tag soup. Wikipedia pages arrive as prose instead of
  `{{cite web}}` citation templates.
- **Site adapters** — known URL shapes route to their cleanest free source:
  GitHub repos/issues/PRs/files via the API, Stack Overflow questions via the
  SE API, HN threads via Algolia, Reddit posts via `.json`, Wikipedia via
  REST. `FetchResult.source` reports which adapter served you.

## Reliability ladder (what happens when engines fight back)

```
web_search   DDG html → DDG lite → DDG POST → r.jina.ai proxy (own IP pool)
             → Bing RSS (structured, no challenges)
             → engine "multi": DDG ∥ Brave ∥ Bing in parallel, RRF-fused
             → any primary failure auto-retries via multi

fetch_page   site adapter (GitHub/SE/HN/Reddit/Wikipedia APIs)
             → direct fetch (browser UA, retries ×3 backoff)
             → 401/403/429/503 → Wayback Machine snapshot
             → thin/SPA content → r.jina.ai headless render
             → jina block-pages are detected and rejected (never fake content)
```

- SSRF protection: localhost / private ranges / link-local blocked
- Per-host politeness throttle; keyless rate limits respected (jina ~20/min)
- Honest UA policy: fake-browser UA for engines that want it, honest tool UA
  for those that don't (r.jina.ai blocks fake browser UAs!)
- Caches are disk-backed (`~/.pi/agent/cache/webfind/`) — restarts keep
  their 10-min search cache and 1-h fetch cache

## Claude Code parity

| Claude Code | pi-webfind |
|---|---|
| `⏺ Web Search("…")` rows | ✅ `renderCall` custom rendering |
| "Did 1 search in 10s" | ✅ `✓ N results · engines · duration` |
| Live progress | ✅ `onUpdate` partial status ("querying duckduckgo…") |
| Reads PDFs & documents | ✅ poppler-or-internal extraction, arxiv-verified |
| Excerpt per search hit | ✅ `deep: true` ranked excerpts |
| Relevant passages per page | ✅ `fetch_page` `query` param (BM25) |
| Research → grouped summary | ✅ `/research` command + widget progress |
| WebSearch tool auto-selection | ✅ `promptSnippet`/`promptGuidelines` |

## Limits (be honest about free)

- Scraped engines can tighten defenses anytime — the ladder above is the mitigation
- Public SearXNG instances are IP-rate-limited from cloud IPs (verified); the
  jina proxy + Brave cover that gap without self-hosting
- Unauthenticated GitHub: 10 req/min (optional `GITHUB_TOKEN` lifts it)
- Search-result dates appear when the engine provides them (DDG stamps, Bing
  pubDate) — not every row carries one

## License

MIT
