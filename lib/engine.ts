/**
 * Multi-engine free web search for pi — no API keys, no paid services.
 *
 * Engines (tried in order):
 *   1. DuckDuckGo html endpoint (GET)
 *   2. DuckDuckGo lite endpoint
 *   3. DuckDuckGo html endpoint (POST)  — often works when GET is challenged
 *   4. Brave Search HTML scraping       — independent index, good redundancy
 *
 * All engines are scraped with Node's built-in fetch. Requests are
 * rate-limited globally (1 / 1.2s per host) and results are cached
 * in-memory (LRU, 128 entries, 10 min TTL).
 */
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// r.jina.ai blocks fake browser UAs but allows honest tool UAs (opposite of most sites)
const TOOL_UA = "pi-webfind/0.4 (free web research toolkit for pi coding agent; +https://github.com/jawwadzafar/pi-webfind)";
const TIMEOUT_MS = 15_000;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	engine: string;
}

// ---------------------------------------------------------------- utilities

const lastHit = new Map<string, number>();
async function throttle(host: string, signal?: AbortSignal) {
	const key = host;
	const wait = (lastHit.get(key) ?? 0) + 1200 - Date.now();
	if (wait > 0) await sleep(wait, signal);
	lastHit.set(key, Date.now());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
	hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
	laquo: "«", raquo: "»", times: "×", middot: "·", bull: "•", deg: "°", plusmn: "±", eacute: "é",
	egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", euro: "€",
	trade_sup2: "²", dagger: "†", permil: "‰", prime: "′", Prime: "″", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
};

export function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (ent, name: string) => NAMED_ENTITIES[name] ?? ent)
		.replace(/"/g, '"')
		.replace(/</g, "<")
		.replace(/>/g, ">")
		.replace(/&/g, "&");
}

const stripTags = (s: string) =>
	decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function unwrapRedirect(href: string): string | null {
	const m = href.match(/[?&]uddg=([^&]+)/);
	if (m) return decodeURIComponent(m[1]);
	if (href.startsWith("//")) return "https:" + href;
	if (/^https?:\/\//.test(href)) return href;
	return null;
}

async function get(url: string, signal?: AbortSignal, post?: string): Promise<string> {
	const host = new URL(url).host;
	await throttle(host, signal);
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await fetch(url, {
		method: post ? "POST" : "GET",
		headers: {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml",
			"Accept-Language": "en-US,en;q=0.9",
			...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
		},
		body: post,
		signal: combined,
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

// ------------------------------------------------------------------ engines

function parseDdgHtml(page: string): SearchResult[] {
	const out: SearchResult[] = [];
	const snippets = [...page.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(
		(m) => stripTags(m[1]),
	);
	let i = 0;
	for (const m of page.matchAll(
		/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
	)) {
		const url = unwrapRedirect(m[1]);
		if (!url) continue;
		out.push({ title: stripTags(m[2]), url, snippet: snippets[i++] ?? "", engine: "ddg" });
	}
	return out;
}

function parseDdgLite(page: string): SearchResult[] {
	const links = [
		...page.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
	];
	const snippets = [...page.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
		stripTags(m[1]),
	);
	const out: SearchResult[] = [];
	links.forEach((m, i) => {
		const url = unwrapRedirect(m[1]);
		if (!url) return;
		out.push({ title: stripTags(m[2]), url, snippet: snippets[i] ?? "", engine: "ddg-lite" });
	});
	return out;
}

function parseBrave(page: string): SearchResult[] {
	// Brave svelte markup: results are <a href="https://..." class="svelte-... l1">
	const out: SearchResult[] = [];
	const seen = new Set<string>();
	for (const m of page.matchAll(
		/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\bsvelte-[^"]*l1[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
	)) {
		const url = unwrapRedirect(m[1]);
		if (!url || seen.has(url) || /search\.brave\.com|brave\.com\/search/.test(url)) continue;
		seen.add(url);
		out.push({ title: stripTags(m[2]) || url, url, snippet: "", engine: "brave" });
	}
	// Fallback: any external anchor with heading-like content
	if (out.length === 0) {
		for (const m of page.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
			const url = unwrapRedirect(m[1]);
			const title = stripTags(m[2]);
			if (
				!url ||
				seen.has(url) ||
				/brave\.com|imgs=|\/search\?|\.svg|\.css|\.js/.test(url) ||
				title.length < 15
			)
				continue;
			seen.add(url);
			out.push({ title, url, snippet: "", engine: "brave" });
		}
	}
	return out;
}

export type Recency = "d" | "w" | "m" | "y" | undefined;

// ------------------------------------------- jina reader proxy (keyless)

/**
 * r.jina.ai — keyless reader proxy with its own IP pool and headless browser.
 * Used as an anti-blocking hop: different IPs than ours, executes JS,
 * and can relay search-engine HTML when our direct requests get walled.
 * Rate limit (keyless): ~20 req/min per IP — only used as fallback.
 */
const JINA_RATE_MS = 3_500;
let lastJina = 0;

async function jinaGet(url: string, signal?: AbortSignal): Promise<string> {
	const wait = lastJina + JINA_RATE_MS - Date.now();
	if (wait > 0) await sleep(wait, signal);
	lastJina = Date.now();
	const timeout = AbortSignal.timeout(30_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await fetch(`https://r.jina.ai/${url}`, {
		headers: { "User-Agent": TOOL_UA, Accept: "text/plain" },
		signal: combined,
	});
	if (!res.ok) throw new Error(`jina HTTP ${res.status}`);
	return res.text();
}

/** Parse r.jina.ai's markdown output of a DDG html/lite page into results. */
function parseJinaDdg(md: string): SearchResult[] {
	const out: SearchResult[] = [];
	const seen = new Set<string>();
	// markdown links: [title](https://duckduckgo.com/l/?uddg=ENCODED ...) or direct links
	for (const m of md.matchAll(/\[([^\]]{4,120})\]\((https?:\/\/[^)]+)\)/g)) {
		const title = decodeEntities(m[1].replace(/[*_`]/g, "")).trim();
		const url = unwrapRedirect(m[2]);
		if (!url || seen.has(url)) continue;
		if (/duckduckgo\.com(?!\/l\/)|\/y\.js|bing\.com|\.svg/.test(url)) continue;
		seen.add(url);
		out.push({ title, url, snippet: "", engine: "ddg-jina" });
	}
	return out;
}

export async function ddgSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const params = new URLSearchParams({ q: query });
	if (recency) params.set("df", recency);
	const enc = params.toString();
	let directFailed = false;

	// 0. jina proxy (different IP pool — works when our IP is rate-limited)
	try {
		const results = parseJinaDdg(await jinaGet(`https://html.duckduckgo.com/html/?${enc}`, signal));
		if (results.length > 0) return results.slice(0, maxResults);
	} catch {
		/* try next */
	}

	// 1. html GET
	try {
		const results = parseDdgHtml(await get(`https://html.duckduckgo.com/html/?${enc}`, signal));
		if (results.length > 0) return results.slice(0, maxResults);
		directFailed = true;
	} catch {
		directFailed = true;
	}

	// 2. lite GET
	try {
		const results = parseDdgLite(await get(`https://lite.duckduckgo.com/lite/?${enc}`, signal));
		if (results.length > 0) return results.slice(0, maxResults);
	} catch {
		/* try next */
	}

	// 3. html POST (often bypasses GET challenges)
	try {
		const results = parseDdgHtml(await get("https://html.duckduckgo.com/html/", signal, enc));
		if (results.length > 0) return results.slice(0, maxResults);
	} catch {
		/* fall to jina */
	}

	// 4. jina relay of lite endpoint (last resort for search)
	const results = parseJinaDdg(await jinaGet(`https://lite.duckduckgo.com/lite/?${enc}`, signal));
	if (results.length === 0) throw new Error("no results from duckduckgo (direct + jina proxy)");
	return results.slice(0, maxResults);
}

export async function braveSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const params = new URLSearchParams({ q: query });
	if (recency) {
		const map: Record<string, string> = { d: "pd", w: "pw", m: "pm", y: "py" };
		params.set("tf", map[recency]);
	}
	const results = parseBrave(await get(`https://search.brave.com/search?${params}`, signal));
	if (results.length === 0) throw new Error("no results from brave");
	return results.slice(0, maxResults);
}

function parseRssItems(xml: string, engine: string): SearchResult[] {
	const out: SearchResult[] = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1];
		const title = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
		const url = (item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
		const snippet = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
		if (!title || !/^https?:\/\//.test(url)) continue;
		out.push({ title, url, snippet, engine });
	}
	return out;
}

/** Bing RSS — structured endpoint, real web index, no bot challenges. */
export async function bingRssSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const params = new URLSearchParams({
		q: query,
		format: "rss",
		count: String(Math.max(maxResults, 15)),
		setmkt: "en-US",
		setlang: "en",
	});
	if (recency) params.set("qdr", recency); // bing supports freshness via qdr on html; harmless on rss
	const xml = await get(`https://www.bing.com/search?${params}`, signal);
	const results = parseRssItems(xml, "bing");
	if (results.length === 0) throw new Error("no results from bing rss");
	return results.slice(0, maxResults);
}

/** Run several engines in parallel; RRF-fuse, dedupe by URL, consensus ranks first. */
export async function multiSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; engines: string[]; errors: string[] }> {
	const attempts: Array<{ name: string; fn: () => Promise<SearchResult[]> }> = [
		{ name: "ddg", fn: () => ddgSearch(query, 15, recency, signal) },
		{ name: "brave", fn: () => braveSearch(query, 15, recency, signal) },
		{ name: "bing", fn: () => bingRssSearch(query, 15, recency, signal) },
	];
	const settled = await Promise.allSettled(attempts.map((a) => a.fn()));
	const namedBuckets: Array<{ name: string; rows: SearchResult[] }> = [];
	const engines: string[] = [];
	const errors: string[] = [];
	settled.forEach((r, i) => {
		if (r.status === "fulfilled" && r.value.length > 0) {
			namedBuckets.push({ name: attempts[i].name, rows: r.value });
			engines.push(attempts[i].name);
		} else if (r.status === "rejected") {
			errors.push(`${attempts[i].name}: ${(r.reason as Error)?.message ?? r.reason}`);
		}
	});
	// reciprocal rank fusion (RRF, k=60) — consensus hits across engines rank higher, dedupe by normalized URL
	const K = 60;
	const norm = (u: string) => u.replace(/\/+$/, "").replace(/^https?:\/\/www\./, "http://");
	const scored = new Map<string, { r: SearchResult; s: number; engines: Set<string> }>();
	for (const bucket of namedBuckets) {
		bucket.rows.forEach((r, i) => {
			const key = norm(r.url);
			const e = scored.get(key) ?? { r, s: 0, engines: new Set<string>() };
			e.s += 1 / (K + i + 1);
			e.engines.add(bucket.name);
			scored.set(key, e);
		});
	}
	const merged = [...scored.values()]
		.sort((a, b) => b.s - a.s)
		.slice(0, maxResults)
		.map((e) => ({ ...e.r, engines: [...e.engines] }) as SearchResult & { engines?: string[] });
	if (merged.length > 0) return { results: merged, engines, errors };
}

// -------------------------------------------------------------------- cache

const CACHE_MAX = 128;
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: SearchResult[] }>();

export function cacheGet(key: string): SearchResult[] | null {
	const hit = cache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > CACHE_TTL) {
		cache.delete(key);
		return null;
	}
	// LRU refresh
	cache.delete(key);
	cache.set(key, hit);
	return hit.value;
}

export function cacheSet(key: string, value: SearchResult[]) {
	if (cache.size >= CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest) cache.delete(oldest);
	}
	cache.set(key, { at: Date.now(), value });
}

// ----------------------------------------------------- page text extraction

/** HTML → readable text. Prefers <article>/<main>/content markup; strips chrome. */
export function htmlToText(page: string, maxChars: number): { text: string; truncated: boolean } {
	const titleMatch = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";

	let scope = page;
	const articleMatch =
		page.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
		page.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
		page.match(/<(?:div|section)[^>]*(?:id|class)="[^"]*(?:content|article|post|entry)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i);
	// Only scope down when the candidate is substantial relative to the page
	if (articleMatch && articleMatch[1].length > page.length * 0.1) scope = articleMatch[1];

	const text = scope
		.replace(/<(script|style|noscript|template|svg|iframe|nav|footer|header|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|td)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "• ")
		.replace(/<[^>]+>/g, " ");
	const body = decodeEntities(text)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\n /g, "\n")
		.trim();
	const full = title ? `${title}\n${"=".repeat(Math.min(title.length, 60))}\n${body}` : body;
	const truncated = full.length > maxChars;
	return { text: truncated ? full.slice(0, maxChars) : full, truncated };
}
