# pi-web-search-free

**Free multi-engine web search + page fetching for the [pi coding agent](https://github.com/earendil-works/pi).**

No API keys. No signups. No paid tiers. No rate-limit tokens to buy. Just scraping of
search engines that tolerate it, with fallbacks and merging built in.

```bash
pi install /path/to/pi-web-search-free     # local
pi install git:github.com/jawwadzafar/pi-web-search-free   # once pushed
```

## Tools

### `web_search`

| Param | Default | Description |
|---|---|---|
| `query` | — | Search query |
| `max_results` | 8 | 1–20 |
| `recency` | — | `d`=day, `w`=week, `m`=month, `y`=year |
| `engine` | `ddg` | `ddg` \| `brave` \| `multi` |
| `refresh` | false | Skip the 10-min cache |

**Engine chain** (each falls through to the next on failure):

1. DuckDuckGo html endpoint (GET)
2. DuckDuckGo lite endpoint
3. DuckDuckGo html endpoint (POST — bypasses many GET challenges)
4. Brave Search HTML (independent index — real redundancy, not another DDG mirror)

`engine: "multi"` fires DDG + Brave **in parallel**, then merges results
round-robin (engine diversity) and dedupes by normalized URL. If the primary
engine throws, the tool automatically retries with multi before giving up.

### `fetch_page`

Fetches a URL and returns readable text: `<script>/<style>/<nav>/<footer>/…`
stripped, `<article>`/`<main>` content preferred, entities decoded, lists
rendered as bullets. `{ url, max_chars (default 8000, max 50k), raw? }`.

## The research loop (Claude-style, $0)

```
web_search(query)  →  fetch_page(top 1-3 urls)  →  synthesize
```

## Design notes

- **Zero runtime dependencies** — Node ≥20 built-in `fetch`, `AbortSignal.any/timeout`
- **Politeness**: global per-host throttle (1.2s), browser-like UA, sane timeouts
- **Cache**: in-memory LRU (128 entries, 10 min TTL) so repeat questions cost nothing
- **Peer deps only**: `@earendil-works/pi-coding-agent` + `typebox` (provided by pi itself)

## Comparison with alternatives

| Package | Needs API key? | Engines | Notes |
|---|---|---|---|
| **pi-web-search-free** | **No** | DDG ×3 + Brave, merged | zero deps |
| henyo-pi-web | No | DDG (html→lite) | + SO/Wikipedia tools |
| @everyx/pi-web-tools | Partial | multi + Exa fallback | Exa needs key |
| pi-web-access | **Yes** | Brave/Tavily/Serper/… | most features, keys required |

## Limits (be honest about free)

- Scraping is best-effort: engines can tighten bot defenses anytime; the
  fallback chain + multi-engine merge is the mitigation
- Don't hammer it: the built-in throttle is there for a reason
- Behind aggressive VPNs/proxies you'll see more 403/429s — retry with `refresh: false`
  after a minute

## License

MIT
