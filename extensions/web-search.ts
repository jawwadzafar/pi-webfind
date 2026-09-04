/**
 * pi-web-search-free — free multi-engine web search + page fetch for pi.
 * No API keys, no paid services. DDG + Brave, merged and deduped.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	braveSearch,
	cacheGet,
	cacheSet,
	ddgSearch,
	htmlToText,
	multiSearch,
	type Recency,
	type SearchResult,
} from "../lib/engine.ts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;

function formatResults(results: SearchResult[], engines: string[], errors: string[]): string {
	if (results.length === 0) {
		return (
			`No results found.${errors.length ? `\nEngine errors: ${errors.join("; ")}` : ""}`
		);
	}
	const header = `[via ${engines.join(" + ")}]${errors.length ? ` (failed: ${errors.join("; ")})` : ""}`;
	const body = results
		.map(
			(r, i) =>
				`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}${r.engine ? `  [${r.engine}]` : ""}`,
		)
		.join("\n\n");
	return `${header}\n\n${body}`;
}

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------- web_search
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for free (DuckDuckGo + Brave, no API key). Returns titles, URLs, snippets. " +
			"Use fetch_page afterwards to read a result in full. Use engine='multi' for better coverage " +
			"on hard queries (merges both engines).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Number({ description: "Max results, 1-20 (default 8)" }),
			),
			recency: Type.Optional(
				Type.String({
					description: "Restrict to recent results: d=day, w=week, m=month, y=year",
				}),
			),
			engine: Type.Optional(
				Type.String({
					description: "ddg (default, fast) | brave | multi (parallel DDG+Brave, merged)",
				}),
			),
			refresh: Type.Optional(
				Type.Boolean({ description: "Skip the 10-minute result cache" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const maxResults = Math.min(Math.max(params.max_results ?? 8, 1), 20);
			const recency = (["d", "w", "m", "y"] as const).includes(params.recency as any)
				? (params.recency as Recency)
				: undefined;
			const engine = params.engine ?? "ddg";
			const cacheKey = `s:${engine}:${recency ?? ""}:${maxResults}:${params.query}`;
			try {
				if (!params.refresh) {
					const hit = cacheGet(cacheKey);
					if (hit) {
						return {
							content: [{ type: "text", text: `[cached] ${formatResults(hit, ["cache"], [])}` }],
							details: { cached: true, results: hit },
						};
					}
				}
				let results: SearchResult[];
				let engines: string[] = [];
				let errors: string[] = [];
				if (engine === "multi") {
					const r = await multiSearch(params.query, maxResults, recency, signal);
					results = r.results;
					engines = r.engines;
					errors = r.errors;
				} else if (engine === "brave") {
					results = await braveSearch(params.query, maxResults, recency, signal);
					engines = ["brave"];
				} else {
					results = await ddgSearch(params.query, maxResults, recency, signal);
					engines = ["ddg"];
				}
				if (results.length > 0) cacheSet(cacheKey, results);
				return {
					content: [
						{ type: "text", text: formatResults(results, engines, errors) },
					],
					details: { engines, errors, results },
				};
			} catch (err: any) {
				// Last-ditch: try multi before giving up
				if (engine !== "multi") {
					try {
						const r = await multiSearch(params.query, maxResults, recency, signal);
						if (r.results.length > 0) {
							cacheSet(cacheKey, r.results);
							return {
								content: [
									{
										type: "text",
										text: `${formatResults(r.results, r.engines, r.errors)}\n\n[primary engine failed: ${err?.message ?? err}]`,
									},
								],
								details: { engines: r.engines, results: r.results },
							};
						}
					} catch {
						/* fall through to error */
					}
				}
				return {
					content: [
						{
							type: "text",
							text: `Search error: ${err?.message ?? err}. All engines may be rate-limited — wait a minute and retry, or try engine='multi'.`,
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
			"Fetch a web page and return its readable text (HTML stripped, nav/ads removed, " +
			"article content preferred). Use after web_search to read results in full.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http/https)" }),
			max_chars: Type.Optional(
				Type.Number({ description: "Max characters of text to return (default 8000)" }),
			),
			raw: Type.Optional(
				Type.Boolean({ description: "Return raw HTML instead of extracted text" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const maxChars = Math.min(Math.max(params.max_chars ?? 8000, 200), 50_000);
			try {
				const url = new URL(params.url);
				if (!/^https?:$/.test(url.protocol)) throw new Error("Only http/https URLs are supported");
				const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
				const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
				const res = await fetch(url, {
					headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
					signal: combined,
					redirect: "follow",
				});
				const html = await res.text();
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const { text, truncated } = params.raw
					? { text: html, truncated: html.length > maxChars }
					: htmlToText(html, maxChars);
				const note = truncated
					? `\n\n[truncated — raise max_chars (up to 50000) if you need more]`
					: "";
				return {
					content: [{ type: "text", text: `[${url.href}] (${res.status})\n\n${text}${note}` }],
					details: { status: res.status },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Fetch error: ${err?.message ?? err}` }],
					details: {},
				};
			}
		},
	});
}
