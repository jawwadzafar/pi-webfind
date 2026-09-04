/**
 * pi-webfind — the complete free web toolkit for pi.
 * No API keys, no paid services, zero runtime dependencies.
 *
 * Tools (7): web_search, fetch_page, search_stackoverflow, search_wikipedia,
 *            search_npm, search_github, search_hn
 * Command:   /research <topic>  — multi-source research with live progress
 *
 * Claude Code-style UX: compact colored tool headers, live status while
 * running, expanded result views, durations and engine attribution.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	braveSearch,
	bingRssSearch,
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
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

interface Row {
	title: string;
	url: string;
	snippet?: string;
	meta?: string;
	/** publication date when the engine provides one */
	date?: string;
	/** deep mode: query-relevant excerpt fetched from the page itself */
	excerpt?: string;
}

function fmtResults(results: Row[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			const lines = [`${i + 1}. ${r.title}`, `   ${r.url}${r.date ? `  (${r.date})` : ""}`];
			if (r.meta) lines.push(`   ${r.meta}`);
			if (r.excerpt) lines.push(`   excerpt: ${clip(r.excerpt, 400)}`);
			else if (r.snippet) lines.push(`   ${clip(r.snippet, 250)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

// ------------------------------------------------------------- TUI rendering

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}


/**
 * Claude Code-style renderers (flat — no background box, no emoji):
 *   ⏺ Web Search("query")
 *     ⎿ Found 8 results in 4.1s
 *     ⎿ via ddg · (ctrl+o to expand)
 * Green dot marks state, live ticking elapsed while running.
 */
function makeRenderers(
	toolName: string,
	argDetail: (args: any) => string,
	resultSummary: (details: any) => { ok: boolean; line1: string; line2?: string; rows?: Row[]; preview?: string },
) {
	return {
		// self shell: no default Box bg — flat like Claude Code
		renderShell: "self" as const,
		renderCall(args: any, theme: any, context: any) {
			const t = theme as Theme;
			if (context.executionStarted && context.state.startedAt === undefined) {
				context.state.startedAt = Date.now();
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				t.fg("success", "⏺ ") +
					t.fg("toolTitle", t.bold(toolName)) +
					t.fg("dim", `(${JSON.stringify(clip(String(argDetail(args ?? {})), 70))})`),
			);
			return text;
		},
		renderResult(
			result: any,
			options: { expanded?: boolean; isPartial?: boolean },
			theme: any,
			context: any,
		) {
			const t = theme as Theme;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const state = context.state ?? {};

			// live elapsed ticking while partial (1s interval, like pi's bash renderer)
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate?.(), 1000);
			}
			if (!options.isPartial && state.interval) {
				clearInterval(state.interval);
				state.interval = undefined;
			}

			if (options.isPartial) {
				const step = result?.details?.status ?? "Searching…";
				const elapsed = state.startedAt !== undefined ? secs(Date.now() - state.startedAt) : "";
				text.setText(t.fg("warning", `  ⎿ ${step}${elapsed ? ` · ${elapsed}` : ""}`));
				return text;
			}

			const isError = result?.isError || result?.details?.error;
			if (isError) {
				const msg = result?.details?.error ?? result?.content?.[0]?.text ?? "failed";
				text.setText(t.fg("error", `  ⎿ ${clip(String(msg), 160)}`));
				return text;
			}

			const { ok, line1, line2, rows, preview } = resultSummary(result?.details ?? {});
			let out = t.fg("success", "  ⎿ ") + t.fg("muted", line1);
			if (line2) out += `\n  ⎿ ${t.fg("dim", line2)}`;
			if (options.expanded) {
				if (rows && rows.length > 0) {
					out +=
						"\n" +
						rows
							.map((r, i) => {
								let line = `    ${t.fg("accent", `${i + 1}. ${clip(r.title, 90)}`)}`;
								line += `\n       ${t.fg("dim", clip(r.url, 110))}`;
								if (r.meta) line += `  ${t.fg("muted", clip(r.meta, 80))}`;
								if (r.date) line += `  ${t.fg("muted", r.date)}`;
								return line;
							})
							.join("\n");
				} else if (preview) {
					out += "\n" + t.fg("dim", clip(String(preview), 400));
				}
			} else {
				out += t.fg("dim", `  (${keyHint("app.tools.expand", "to expand")})`);
			}
			text.setText(out);
			return text;
		},
	};
}

// ------------------------------------------------------------------ factory

function registerSearchTool(
	pi: ExtensionAPI,
	name: string,
	label: string,
	description: string,
	promptSnippet: string,
	run: (query: string, max: number, signal?: AbortSignal) => Promise<Row[]>,
	summary: (details: any) => { ok: boolean; line1: string; line2?: string; rows?: Row[]; preview?: string } = (d) => ({
		ok: true,
		line1: `Found ${d.count ?? 0} results in ${secs(d.durationMs ?? 0)}`,
		rows: d.results,
	}),
) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet,
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
			no_cache: Type.Optional(Type.Boolean({ description: "Skip the 10-minute cache" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const started = Date.now();
			onUpdate?.({
				content: [{ type: "text", text: `${label}…` }],
				details: { status: `Searching ${JSON.stringify(clip(params.query, 50))}…` },
			});
			try {
				const results = await run(params.query, MAX(params.max), signal);
				return {
					content: [{ type: "text", text: fmtResults(results) }],
					details: { results, count: results.length, durationMs: Date.now() - started },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `${label} error: ${err?.message ?? err}` }],
					details: { error: err?.message ?? String(err), durationMs: Date.now() - started },
					isError: true,
				};
			}
		},
		...makeRenderers(label, (args) => args.query ?? "", summary),
	});
}

// ------------------------------------------------------------------- setup

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------- web_search
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"General web search — free, no API key (DuckDuckGo + Brave). Returns titles, URLs, snippets. " +
			"Use for news, articles, broad topics. Use fetch_page to read a result in full. " +
			"engine='multi' merges both engines in parallel for best coverage.",
		promptSnippet: "Free multi-engine web search (DDG + Brave) with recency filter",
		promptGuidelines: [
			"For anything factual or current, search before answering. Run 2-3 searches with different phrasings (add a year, quote the exact error, add 'docs' or 'github') — one query is rarely enough.",
			"Set deep:true on web_search when you need facts rather than links; use fetch_page with query when you need one page in depth. Cite URLs inline.",
			"Read at least two independent sources before stating a conclusion. Prefer primary sources (official docs, repos, papers) over aggregators, and say when sources disagree or are thin.",
			"Results include dates when available — prefer recent ones for fast-moving topics and mention which date you relied on.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(Type.Number({ description: "Max results, 1-20 (default 8)" })),
			recency: Type.Optional(Type.String({ description: "d=day, w=week, m=month, y=year (optional)" })),
			engine: Type.Optional(Type.String({ description: "ddg (default) | brave | bing | multi (parallel merge)" })),
			refresh: Type.Optional(Type.Boolean({ description: "Skip the 10-minute cache" })),
			deep: Type.Optional(
				Type.Union([Type.Boolean(), Type.Number()], {
					description:
						"Read the top results and attach a query-relevant excerpt to each. true = 4 results; or a number 1-8. Use when you need facts, not just links — often removes the need for fetch_page.",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const started = Date.now();
			const maxResults = MAX(params.max_results);
			const recency = (["d", "w", "m", "y"] as const).includes(params.recency as any)
				? (params.recency as Recency)
				: undefined;
			const engine = params.engine ?? "ddg";
			const cacheKey = `s:${engine}:${recency ?? ""}:${maxResults}:${params.query}`;
			const run = async () => {
				if (engine === "multi") {
					onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "querying ddg + brave in parallel…" } });
					const r = await multiSearch(params.query, maxResults, recency, signal);
					return { results: r.results as Row[], engines: r.engines, errors: r.errors };
				}
				if (engine === "brave") {
					onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "querying brave…" } });
					return { results: (await braveSearch(params.query, maxResults, recency, signal)) as Row[], engines: ["brave"], errors: [] as string[] };
				}
				if (engine === "bing") {
					onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "querying bing rss…" } });
					return { results: (await bingRssSearch(params.query, maxResults, recency, signal)) as Row[], engines: ["bing"], errors: [] as string[] };
				}
				onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "querying duckduckgo…" } });
				try {
					return { results: (await ddgSearch(params.query, maxResults, recency, signal)) as Row[], engines: ["ddg"], errors: [] as string[] };
				} catch (err) {
					// ddg fully failed — structured bing rss before giving up
					onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "ddg failed — trying bing rss…" } });
					return { results: (await bingRssSearch(params.query, maxResults, recency, signal)) as Row[], engines: ["bing"], errors: [String((err as Error)?.message ?? err)] };
				}
			};
			try {
				let cachedHit = false;
				if (!params.refresh) {
					const hit = cacheGet(cacheKey);
					if (hit) {
						cachedHit = true;
						return {
							content: [{ type: "text", text: `[cached]\n${fmtResults(hit)}` }],
							details: { cached: true, results: hit, count: hit.length, durationMs: Date.now() - started },
						};
					}
				}
				const { results, engines, errors } = await run();
				// deep mode: read top results in parallel, attach query-relevant excerpts
				const deepN = params.deep === true ? 4 : typeof params.deep === "number" ? Math.min(Math.max(Math.round(params.deep), 1), 8) : 0;
				if (deepN > 0 && results.length > 0 && !cachedHit) {
					onUpdate?.({
						content: [{ type: "text", text: "…" }],
						details: { status: `reading top ${Math.min(deepN, results.length)} results for excerpts…` },
					});
					const top = results.slice(0, deepN);
					const deadline = Date.now() + 25_000;
					await Promise.all(
						top.map(async (r) => {
							const budget = Math.max(deadline - Date.now(), 4_000);
							try {
								const page = await smartFetch(r.url, {
									maxChars: 12_000,
									timeoutMs: budget,
									query: params.query,
									noCache: false,
									signal,
								} satisfies FetchOptions);
								const body = page.text.replace(/\n\n\[\d+ of \d+ passages shown[^\n]*\n?\n?$/, "");
								const first = body.split("\n\n").find((p) => !/^(via |\[|\d+\.)/.test(p.trim()));
								if (first && first.trim().length > 80) {
									(r as Row).excerpt = clip(first.trim().replace(/\n+/g, " "), 500);
								}
							} catch {
								/* ship without excerpt */
							}
						}),
					);
				}
				if (results.length > 0) cacheSet(cacheKey, results);
				return {
					content: [
						{
							type: "text",
							text: `[via ${engines.join(" + ")}]${errors.length ? ` (failed: ${errors.join("; ")})` : ""}\n\n${fmtResults(results)}`,
						},
					],
					details: { results, count: results.length, engines, errors, durationMs: Date.now() - started },
				};
			} catch (err: any) {
				if (engine !== "multi") {
					onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "primary engine failed — trying multi…" } });
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
								details: { results: r.results, count: r.results.length, engines: r.engines, durationMs: Date.now() - started },
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
					details: { error: err?.message ?? String(err), durationMs: Date.now() - started },
					isError: true,
				};
			}
		},
		...makeRenderers(
			"Web Search",
			(args) => String(args.query ?? ""),
			(d) => {
				const eng = (d.engines ?? []).join(" + ") || (d.cached ? "cache" : "ddg");
				const line1 = `Found ${d.count ?? 0} results in ${secs(d.durationMs ?? 0)}`;
				const line2 = d.cached
					? `via cache · ${eng}`
					: (d.errors ?? []).length > 0
						? `via ${eng} · failed: ${(d.errors ?? []).join("; ")}`
						: `via ${eng}`;
				return { ok: (d.count ?? 0) > 0, line1, line2, rows: d.results, preview: undefined };
			},
		),
	});

	// ------------------------------------------------------------- fetch_page
	pi.registerTool({
		name: "fetch_page",
		label: "Fetch Page",
		description:
			"Fetch a URL and return readable content. Handles HTML (article extraction, nav/ads stripped), " +
			"JSON (pretty-printed), plain text, and PDFs (text extraction). On 401/403/429/503 automatically " +
			"retries via the Wayback Machine; thin/SPA pages re-rendered via a reader proxy. SSRF-protected. " +
				"Pass query to get the most relevant passages of a long page instead of its head. Cached 1h.",
		promptSnippet: "Fetch a URL → readable text; handles PDFs, JSON, bot-walls (Wayback fallback)",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http/https only)" }),
			query: Type.Optional(
				Type.String({
					description:
						"What you're looking for on this page. Returns intro + most query-relevant passages instead of the page head. Recommended for long pages.",
				}),
			),
			max_chars: Type.Optional(Type.Number({ description: "Max text chars (default 8000, max 50000)" })),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of extracted text" })),
			timeout: Type.Optional(Type.Number({ description: "Timeout ms (1000-60000, default 15000)" })),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: 'Custom headers, e.g. {"Authorization": "Bearer ..."}',
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
		async execute(_id, params, signal, onUpdate) {
			const started = Date.now();
			try {
				const u = new URL(params.url);
				onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: `fetching ${u.host}…` } });
				const r = await smartFetch(params.url, {
					query: (params.query as string | undefined)?.trim() || undefined,
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
					r.source === "wayback" ? `Wayback ${r.waybackDate}` : null,
					r.fromCache ? "cached" : null,
				].filter(Boolean).join(" · ");
				return {
					content: [{ type: "text", text: `[${r.finalUrl}]\n[${tags}]\n\n${r.text}` }],
					details: {
						status: r.status,
						source: r.source,
						fromCache: r.fromCache,
						chars: r.text.length,
						truncated: r.truncated,
						host: u.host,
						preview: r.text.slice(0, 300),
						durationMs: Date.now() - started,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Fetch error: ${err?.message ?? err}` }],
					details: { error: err?.message ?? String(err), durationMs: Date.now() - started },
					isError: true,
				};
			}
		},
		...makeRenderers(
			"Fetch Page",
			(args) => String(args.url ?? ""),
			(d) => {
				const line1 = `Read ${d.chars ?? 0} chars in ${secs(d.durationMs ?? 0)}`;
				const bits = [`HTTP ${d.status ?? "?"}`];
				if (d.source === "wayback") bits.push("via Wayback");
				if (d.source === "jina") bits.push("via r.jina.ai");
				if (d.fromCache) bits.push("cached");
				if (d.truncated) bits.push("truncated");
				return { ok: !d.error, line1, line2: bits.join(" · "), rows: undefined, preview: d.preview };
			},
		),
	});

	// ------------------------------------------------------ specialized tools
	registerSearchTool(
		pi,
		"search_stackoverflow",
		"Stack Overflow Search",
		"Programming Q&A via the Stack Exchange API (free, no key). Use for error messages, " +
			"code patterns, debugging. Paste the full error for best results. " +
			"Shows score, answer count, accepted status and tags.",
		"Search Stack Overflow for programming Q&A (errors, debugging)",
		(q, m, s) => searchStackOverflow(q, m, s),
		(d) => ({ ok: (d.count ?? 0) > 0, line1: `Found ${d.count ?? 0} questions in ${secs(d.durationMs ?? 0)}` }),
	);

	registerSearchTool(
		pi,
		"search_wikipedia",
		"Wikipedia Search",
		"Encyclopedia search via the MediaWiki API (free, no key). Use for definitions, concepts, " +
			"history, people, places. Use short topic names, not full questions.",
		"Search Wikipedia for encyclopedic background",
		(q, m, s) => searchWikipedia(q, m, s),
		(d) => ({ ok: (d.count ?? 0) > 0, line1: `Found ${d.count ?? 0} articles in ${secs(d.durationMs ?? 0)}` }),
	);

	registerSearchTool(
		pi,
		"search_npm",
		"npm Search",
		"Search the npm registry (free, no key) for JavaScript/TypeScript packages. " +
			"Returns name, version, description, quality and popularity scores.",
		"Search npm registry for JS/TS packages with quality scores",
		(q, m, s) => searchNpm(q, m, s),
		(d) => ({ ok: (d.count ?? 0) > 0, line1: `Found ${d.count ?? 0} packages in ${secs(d.durationMs ?? 0)}` }),
	);

	registerSearchTool(
		pi,
		"search_hn",
		"Hacker News Search",
		"Search Hacker News via the Algolia API (free, no key). Use for tech community opinion, " +
			"launches, discussions. Returns points, comment counts, dates. Great for 'what do devs think of X'.",
		"Search Hacker News for community discussion and opinion",
		(q, m, s) => searchHackerNews(q, m, s),
		(d) => ({ ok: (d.count ?? 0) > 0, line1: `Found ${d.count ?? 0} stories in ${secs(d.durationMs ?? 0)}` }),
	);

	// github (separate: honors GITHUB_TOKEN)
	pi.registerTool({
		name: "search_github",
		label: "GitHub Search",
		description:
			"Search GitHub repositories via the API (free, no key; 10 req/min). Returns stars, " +
			"language, last-updated. Honors GITHUB_TOKEN env var if set (higher rate limits).",
		promptSnippet: "Search GitHub repositories (stars, language, activity)",
		parameters: Type.Object({
			query: Type.String({ description: "Repository search query, e.g. 'websocket library language:python'" }),
			max: Type.Optional(Type.Number({ description: "Max results (default 8)" })),
			no_cache: Type.Optional(Type.Boolean({ description: "Skip the 10-minute cache" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const started = Date.now();
			onUpdate?.({ content: [{ type: "text", text: "…" }], details: { status: "searching github…" } });
			try {
				const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
				const results = await searchGithubRepos(params.query, MAX(params.max), signal, token);
				return {
					content: [{ type: "text", text: fmtResults(results) }],
					details: { results, count: results.length, durationMs: Date.now() - started },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `GitHub search error: ${err?.message ?? err}` }],
					details: { error: err?.message ?? String(err), durationMs: Date.now() - started },
					isError: true,
				};
			}
		},
		...makeRenderers(
			"GitHub Search",
			(args) => String(args.query ?? ""),
			(d) => ({ ok: (d.count ?? 0) > 0, line1: `Found ${d.count ?? 0} repos in ${secs(d.durationMs ?? 0)}`, rows: d.results }),
		),
	});

	// ------------------------------------------------------------ /research
	pi.registerCommand("research", {
		description: "Multi-source research: web + HN + GitHub + Wikipedia, fetches top pages, then synthesizes",
		handler: async (args, ctx) => {
			const topic = (args ?? "").trim();
			if (!topic) {
				ctx.ui.notify("Usage: /research <topic>", "warning");
				return;
			}
			const setStatus = (s: string) => {
				try {
					ctx.ui.setStatus("research", s);
				} catch {
					/* non-tui */
				}
			};
			const setWidget = (lines: string[]) => {
				try {
					ctx.ui.setWidget(
						"research",
						lines.map((l) => clip(l, 100)),
					);
				} catch {
					/* non-tui */
				}
			};

			setStatus("researching…");
			setWidget([`searching: "${topic}"`]);

			const sources: Array<{ kind: string; rows: Row[] }> = [];
			const steps: string[] = [];
			const push = async (kind: string, fn: () => Promise<Row[]>) => {
				try {
					const rows = await fn();
					if (rows.length > 0) {
						sources.push({ kind, rows });
						steps.push(`✓ ${kind}: ${rows.length} results`);
					} else steps.push(`– ${kind}: 0 results`);
				} catch (e: any) {
					steps.push(`✗ ${kind}: ${clip(String(e?.message ?? e), 60)}`);
				}
				setWidget([`gathering sources…`, ...steps]);
			};

			await push("web", () => multiSearch(topic, 6, undefined).then((r) => r.results));
			await push("hn", () => searchHackerNews(topic, 4));
			await push("github", () => searchGithubRepos(topic, 4));
			await push("wikipedia", () => searchWikipedia(topic, 3));

			// fetch top pages (diverse hosts, skip search-engines/aggregators)
			setStatus("fetching top pages…");
			setWidget([...steps, "fetching top pages…"]);
			const seenHosts = new Set<string>();
			const picked: Array<{ url: string; title: string }> = [];
			for (const s of sources.filter((x) => x.kind === "web")) {
				for (const r of s.rows) {
					try {
						const host = new URL(r.url).host;
						if (seenHosts.has(host) || /duckduckgo|brave.com|reddit.com|medium.com/.test(host)) continue;
						seenHosts.add(host);
						picked.push({ url: r.url, title: r.title });
						if (picked.length >= 3) break;
					} catch {
						/* skip */
					}
				}
				if (picked.length >= 3) break;
			}
			const pages: Array<{ title: string; url: string; text: string }> = [];
			for (const p of picked) {
				try {
					const r = await smartFetch(p.url, { maxChars: 4000, timeoutMs: 15_000 });
					pages.push({ title: p.title, url: p.url, text: r.text });
					steps.push(`✓ fetched: ${clip(new URL(p.url).host, 40)}`);
				} catch (e: any) {
					steps.push(`✗ fetch failed: ${clip(new URL(p.url).host, 30)} (${clip(String(e?.message ?? e), 40)})`);
				}
				setWidget([...steps]);
			}

			// hand everything to the model for synthesis
			setStatus("synthesizing…");
			let material = `# Research: ${topic}\n\n`;
			for (const s of sources) {
				material += `## ${s.kind} results\n${fmtResults(s.rows)}\n\n`;
			}
			if (pages.length > 0) {
				material += `## Page contents\n`;
				for (const p of pages) {
					material += `### ${p.title}\n${p.url}\n\n${p.text}\n\n`;
				}
			}
			material += `---\nSynthesize the above into a research briefing:
- Group findings by sub-topic (like "three-way comparisons", "benchmarks", etc.)
- For each group, list the documents worth reading: [source name](url) — one line on what it covers
- End with "Recurring conclusions": 3-6 bullets of the consensus/tensions across sources
- Cite only what appears above; if sources are thin, say so.`;

			pi.sendUserMessage(material);
			setWidget([...steps, "handed to model for synthesis"]);
			setStatus(`done · ${steps.length} steps`);
			setTimeout(() => {
				try {
					ctx.ui.setStatus("research", undefined as never);
					ctx.ui.setWidget("research", []);
				} catch {
					/* cleanup best-effort */
				}
			}, 8000);
		},
	});
}
