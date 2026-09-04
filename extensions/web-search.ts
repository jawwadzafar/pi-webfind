/**
 * pi-web-search-free — the complete free web toolkit for pi.
 * No API keys, no paid services, zero runtime dependencies.
 *
 * Tools:
 *   web_search          multi-engine search (DDG ×3 + Brave, merged)
 *   fetch_page          smart page fetch (extraction, wayback fallback, SSRF guard)
 *   search_stackoverflow  programming Q&A (Stack Exchange API)
 *   search_wikipedia      encyclopedia (MediaWiki API)
 *   search_npm            JS package registry
 *   search_github         repos via GitHub API
 *   search_hn             Hacker News (Algolia API)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	braveSearch,
	cacheGet,
	cacheSet,
	ddgSearch,
	multiSearch,
	type Recency,
	type SearchResult,
} from "../lib/engine.ts";
import {
	searchGithubRepos,
	searchHackerNews,
	searchNpm,
	searchStackOverflow,
	searchWikipedia,
} from "../lib/apis.ts";
import { smartFetch, type FetchOptions } from "../lib/fetcher.ts";

const MAX = (n?: number, dflt = 8, cap = 20) => Math.min(Math.max(n ?? dflt, 1), cap);

function fmtResults(results: Array<{ title: string; url: string; snippet?: string; meta?: string }>): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`];
			if (r.meta) lines.push(`   ${r.meta}`);
			if (r.snippet) lines.push(`   ${r.snippet.slice(0, 250)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------- web_search
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"General web search — free, no API key (DuckDuckGo + Brave). Returns titles, URLs, snippets. " +
			"Use for news, articles, broad topics. Use fetch_page to read a result in full. " +
			"engine='multi' merges both engines in parallel for best coverage.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(Type.Number({ description: "Max results, 1-20 (default 8)" })),
			recency: Type.Optional(
				Type.String({ description: "d=day, w=week, m=month, y=year (optional)" }),
			),
			engine: Type.Optional(
				Type.String({ description: "ddg (default) | brave | multi (parallel merge)" }),
			),
			refresh: Type.Optional(Type.Boolean({ description: "Skip the 10-minute cache" })),
		}),
		async execute(_id, params, signal) {
			const maxResults = MAX(params.max_results);
			const recency = (["d", "w", "m", "y"] as const).includes(params.recency as any)
				? (params.recency as Recency)
				: undefined;
			const engine = params.engine ?? "ddg";
			const cacheKey = `s:${engine}:${recency ?? ""}:${maxResults}:${params.query}`;
			const run = async () => {
				if (engine === "multi") {
					const r = await multiSearch(params.query, maxResults, recency, signal);
					return { results: r.results, engines: r.engines, errors: r.errors };
				}
				if (engine === "brave") {
					return { results: await braveSearch(params.query, maxResults, recency, signal), engines: ["brave"], errors: [] as string[] };
				}
				return { results: await ddgSearch(params.query, maxResults, recency, signal), engines: ["ddg"], errors: [] as string[] };
			};
			try {
				if (!params.refresh) {
					const hit = cacheGet(cacheKey);
					if (hit)
						return {
							content: [{ type: "text", text: `[cached]\n${fmtResults(hit)}` }],
							details: { cached: true, results: hit },
						};
				}
				const { results, engines, errors } = await run();
				if (results.length > 0) cacheSet(cacheKey, results);
				const header = `[via ${engines.join(" + ")}]${errors.length ? ` (failed: ${errors.join("; ")})` : ""}`;
				return {
					content: [{ type: "text", text: `${header}\n\n${fmtResults(results)}` }],
					details: { engines, errors, results },
				};
			} catch (err: any) {
				if (engine !== "multi") {
					try {
						const r = await multiSearch(params.query, maxResults, recency, signal);
						if (r.results.length > 0) {
							cacheSet(cacheKey, r.results);
							return {
								content: [
									{
										type: "text",
										text: `${fmtResults(r.results)}\n\n[primary engine '${engine}' failed: ${err?.message ?? err}]`,
									},
								],
								details: { engines: r.engines, results: r.results },
							};
						}
					} catch {
						/* fall through */
					}
				}
				return {
					content: [
						{
							type: "text",
							text: `Search error: ${err?.message ?? err}. Engines may be rate-limited — wait a minute or retry with engine='multi', refresh=true.`,
						},
					],
					details: {},
				};
			}
		},
	});

	// ------------------------------------------------------------- fetch_page
	pi.registerTool({
		name: "fetch_page",
		label: "Fetch Page",
		description:
			"Fetch a URL and return readable content. Handles HTML (article extraction, nav/ads stripped), " +
			"JSON (pretty-printed), plain text; detects binaries. On 401/403/429/503 automatically retries " +
			"via the Wayback Machine. SSRF-protected. Custom headers supported. Cached 1h.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http/https only)" }),
			max_chars: Type.Optional(Type.Number({ description: "Max text chars (default 8000, max 50000)" })),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of extracted text" })),
			timeout: Type.Optional(Type.Number({ description: "Timeout ms (1000-60000, default 15000)" })),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Custom headers, e.g. {\"Authorization\": \"Bearer ...\"}",
				}),
			),
			no_cache: Type.Optional(Type.Boolean({ description: "Skip the 1-hour cache" })),
			no_wayback: Type.Optional(Type.Boolean({ description: "Disable Wayback Machine fallback" })),
			allow_http_errors: Type.Optional(
				Type.Boolean({
					description:
						"Return 4xx/5xx responses (with body) instead of throwing. Use for API status checks, e.g. crates.io/npm 404 = name available.",
				}),
			),
		}),
		async execute(_id, params, signal) {
			try {
		const r = await smartFetch(params.url, {
					maxChars: MAX(params.max_chars, 8000, 50_000),
					raw: params.raw,
					timeoutMs: params.timeout ? Math.min(Math.max(params.timeout, 1000), 60_000) : undefined,
					headers: params.headers as Record<string, string> | undefined,
					waybackEnabled: !params.no_wayback,
					allowHttpErrors: params.allow_http_errors,
					signal,
				} satisfies FetchOptions);
				const tags = [
					`HTTP ${r.status}`,
					r.source === "wayback" ? `Wayback snapshot ${r.waybackDate}` : null,
					r.fromCache ? "cached" : null,
					r.truncated ? "truncated" : null,
				].filter(Boolean).join(" · ");
				return {
					content: [{ type: "text", text: `[${r.finalUrl}]\n[${tags}]\n\n${r.text}` }],
					details: { status: r.status, source: r.source, fromCache: r.fromCache },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Fetch error: ${err?.message ?? err}` }],
					details: {},
				};
			}
		},
	});

	// ------------------------------------------------------ specialized tools
	const apiTool = (
		name: string,
		label: string,
		description: string,
		fn: (query: string, max: number, signal?: AbortSignal) => Promise<
			Array<{ title: string; url: string; snippet?: string; meta?: string }>
		>,
	) =>
		pi.registerTool({
			name,
			label,
			description,
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				max: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
				no_cache: Type.Optional(Type.Boolean({ description: "Skip the 10-minute cache" })),
			}),
			async execute(_id, params, signal) {
				try {
					const results = await fn(params.query, MAX(params.max), signal);
					return { content: [{ type: "text", text: fmtResults(results) }], details: { count: results.length } };
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `${label} error: ${err?.message ?? err}` }],
						details: {},
					};
				}
			},
		});

	apiTool(
		"search_stackoverflow",
		"Stack Overflow Search",
		"Programming Q&A via the Stack Exchange API (free, no key). Use for error messages, " +
			"code patterns, debugging. Paste the full error for best results. " +
			"Shows score, answer count, accepted status and tags.",
		(q, m, s) => searchStackOverflow(q, m, s),
	);

	apiTool(
		"search_wikipedia",
		"Wikipedia Search",
		"Encyclopedia search via the MediaWiki API (free, no key). Use for definitions, concepts, " +
			"history, people, places. Use short topic names, not full questions.",
		(q, m, s) => searchWikipedia(q, m, s),
	);

	apiTool(
		"search_npm",
		"npm Search",
		"Search the npm registry (free, no key) for JavaScript/TypeScript packages. " +
			"Returns name, version, description, quality and popularity scores.",
		(q, m, s) => searchNpm(q, m, s),
	);

	pi.registerTool({
		name: "search_github",
		label: "GitHub Search",
		description:
			"Search GitHub repositories via the API (free, no key; 10 req/min). Returns stars, " +
			"language, last-updated. Honors GITHUB_TOKEN env var if set (higher rate limits).",
		parameters: Type.Object({
			query: Type.String({ description: "Repository search query, e.g. 'websocket library language:python'" }),
			max: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
			no_cache: Type.Optional(Type.Boolean({ description: "Skip the 10-minute cache" })),
		}),
		async execute(_id, params, signal) {
			try {
				const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
				const results = await searchGithubRepos(params.query, MAX(params.max), signal, token);
				return { content: [{ type: "text", text: fmtResults(results) }], details: { count: results.length } };
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `GitHub search error: ${err?.message ?? err}` }],
					details: {},
				};
			}
		},
	});

	apiTool(
		"search_hn",
		"Hacker News Search",
		"Search Hacker News via the Algolia API (free, no key). Use for tech community opinion, " +
			"launches, discussions. Returns points, comment counts, dates. Great for 'what do devs think of X'.",
		(q, m, s) => searchHackerNews(q, m, s),
	);
}
