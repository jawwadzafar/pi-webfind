# Getting started

## Install

```sh
pi install git:github.com/jawwadzafar/pi-webfind
# or, after the npm publish:
pi install npm:pi-webfind
```

Pi loads the TypeScript extension directly — no build step, no config.

## What you get

Seven tools and one command, all free:

| Tool | Best for |
|---|---|
| `web_search` | news, articles, broad queries — set `deep: true` for excerpts |
| `fetch_page` | read a URL — pass `query` for relevant passages |
| `search_stackoverflow` | error messages, debugging |
| `search_wikipedia` | definitions, concepts, history |
| `search_npm` | JS/TS packages with quality scores |
| `search_github` | repos, stars, languages |
| `search_hn` | tech community opinion, launches |

Plus the **`/research <topic>`** command: parallel search across web, HN,
GitHub and Wikipedia, fetches the top pages, then briefs you with
"documents worth reading + recurring conclusions".

## Two habits that get better answers

**Search deep, not wide.** For factual questions pass `deep: true` — the top
results get read and each row carries a query-relevant excerpt. Often the
answer is on screen without a single fetch.

```json
{ "query": "why does rust have lower latency than go", "max_results": 5, "deep": true }
```

**Fetch with intent.** Long pages return the passages that match your query,
not the first 8000 characters:

```json
{ "url": "https://en.wikipedia.org/wiki/DuckDuckGo", "query": "how does duckduckgo make money" }
```

## Caches

Search results (10 min) and fetched pages (1 h) are cached under
`~/.pi/agent/cache/webfind/` and survive restarts. `refresh: true` /
`no_cache: true` skip them.

## Security

pi-webfind runs with full system access like any pi extension. It makes
outbound HTTPS requests to search engines, public APIs and pages you fetch.
It never reads your files, never executes fetched content, and blocks
requests to localhost/private networks (SSRF guard). Engine traffic uses a
politeness throttle; the only optional credential is `GITHUB_TOKEN` to lift
GitHub's 10 req/min anonymous limit.
