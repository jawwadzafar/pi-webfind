# Tool reference

Every tool and parameter, so you can audit the surface area.

## web_search

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | required |
| `max_results` | number | 1–20, default 8 |
| `recency` | string | `d` day · `w` week · `m` month · `y` year |
| `engine` | string | `ddg` (default) · `brave` · `bing` · `multi` (parallel, RRF-fused) |
| `deep` | boolean \| number | read top results, attach query-relevant excerpts. `true` = 4, or 1–8 |
| `refresh` | boolean | skip the 10-minute cache |

Rows include the URL, publication date when the engine provides one, and a
`via` line showing which engines served the results. Deep rows show an
`excerpt:` line per result.

Fallback chain: DDG html → DDG lite → DDG POST → r.jina.ai proxy → Bing RSS.
Any primary-engine failure auto-retries through `multi`.

## fetch_page

| Parameter | Type | Notes |
|---|---|---|
| `url` | string | http/https only (SSRF-guarded) |
| `query` | string | returns intro + most query-relevant passages (BM25) instead of the page head |
| `max_chars` | number | default 8000, max 50000 |
| `raw` | boolean | return raw HTML instead of extracted markdown |
| `timeout` | number | 1000–60000 ms |
| `headers` | object | custom request headers |
| `no_cache` / `no_wayback` / `allow_http_errors` | boolean | escape hatches |

Handles HTML (markdown extraction), JSON (pretty-printed), plain text and
PDFs (poppler if installed, internal parser otherwise). Bot-walls retry via
the Wayback Machine; thin/SPA pages re-render through a reader proxy. The
output header reports the source: `direct`, `wayback`, `jina`,
`github-issue-api`, `stackexchange-api`, `wikipedia-rest`, …

### Site adapters

Known URL shapes skip scraping entirely:

- `github.com/{o}/{r}` — API metadata + raw README
- `github.com/{o}/{r}/issues|pull/{n}` — issue/PR + comments as markdown
- `github.com/{o}/{r}/blob/{ref}/{path}` — raw file
- `stackoverflow.com/questions/{id}` — question + top answers
- `news.ycombinator.com/item?id=` — thread via Algolia
- `reddit.com/.../comments/...` — post + top comments via `.json`
- `wikipedia.org/wiki/{title}` — REST html → markdown

## search_stackoverflow / search_wikipedia / search_npm / search_github / search_hn

Single `query` (+ `max`) each. All free APIs, no keys; `search_github`
honours an optional `GITHUB_TOKEN` env var for rate limits.

## /research `<topic>`

Runs web + HN + GitHub + Wikipedia searches in parallel with live footer
progress, fetches the most promising pages, then asks the model for a
grouped briefing: documents worth reading, recurring conclusions, and
disagreements between sources.
