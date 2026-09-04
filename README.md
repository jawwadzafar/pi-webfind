# pi-web-search-free

**The complete free web toolkit for the [pi coding agent](https://github.com/earendil-works/pi).**

No API keys. No signups. No paid tiers. Zero runtime dependencies.

```bash
pi install /path/to/pi-web-search-free                      # local
pi install git:github.com/jawwadzafar/pi-web-search-free    # once pushed
```

## Tools (7)

| Tool | Source | Best for |
|---|---|---|
| `web_search` | DuckDuckGo (×3 endpoints) + Brave | news, articles, broad queries |
| `fetch_page` | any URL | readable extraction, JSON, binaries, blocked pages |
| `search_stackoverflow` | Stack Exchange API | error messages, debugging |
| `search_wikipedia` | MediaWiki API | definitions, concepts, history |
| `search_npm` | npm registry API | JS/TS packages + quality scores |
| `search_github` | GitHub API | repos, stars, languages |
| `search_hn` | HN Algolia API | tech community opinion, launches |

All search tools share a 10-minute LRU cache and accept `max` / `no_cache`.

### web_search

```
{ query, max_results?, recency? (d|w|m|y), engine? (ddg|brave|multi), refresh? }
```

**Engine chain** (falls through on any failure):

1. DDG html (GET) → 2. DDG lite → 3. DDG html (POST, bypasses GET challenges) → 4. Brave HTML (independent index)

`engine: "multi"` runs DDG + Brave in parallel and merges round-robin with
URL dedupe. If the primary engine throws, the tool retries with `multi`
automatically before erroring.

### fetch_page

```
{ url, max_chars? (default 8000, max 50k), raw?, timeout?, headers?, no_cache?, no_wayback? }
```

- Content-type aware: HTML → readable text (article-aware, nav/ads stripped),
  JSON → pretty-printed, plain text passed through, binaries detected (metadata only)
- **Wayback Machine fallback**: on 401/403/429/503 automatically retries via
  archive.org snapshot (tagged in output with snapshot date)
- **SSRF protection**: localhost/private-range/link-local hosts and non-http protocols blocked
- Retry with exponential backoff; SPA detection (React/Next/shreddit/…)
- Custom headers (e.g. `Authorization`) honored; 1h cache; 3MB response cap

## Comparison

| | **pi-web-search-free** | henyo-pi-web | @everyx/pi-web-tools | pi-web-access |
|---|---|---|---|---|
| API keys | **none** | none | some | required |
| Runtime deps | **0** | jsdom+defuddle+unpdf | several | several |
| Engines | DDG×3 + Brave, merged | DDG | multi+Exa | many (keyed) |
| Verticals | SO, Wikipedia, npm, GitHub, HN | SO, Wikipedia, npm, GitHub | — | — |
| Wayback fallback | ✅ | ✅ | — | — |
| Recency filter | ✅ | — | — | ✅ |
| SSRF guard | ✅ | ✅ | — | — |

## Limits (be honest about free)

- Scraping is best-effort; engines can tighten bot defenses anytime — the
  fallback chain + multi-engine merge is the mitigation
- Built-in politeness throttle (per-host); don't bypass it
- Unauthenticated GitHub search: 10 req/min (set `GITHUB_TOKEN` for more — optional)

## License

MIT
