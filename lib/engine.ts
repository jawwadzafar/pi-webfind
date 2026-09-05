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
 * rate-limited globally (1 / 1.2s per host) and results are cached on disk
 * (JSON snapshot under ~/.pi/agent/cache/webfind, 10 min TTL).
 */
import { createDiskBackedCache } from "./cache.ts";
import { hostCooldownUntil, setHostCooldown } from "./net.ts";
import { tokenize } from "./rank.ts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// r.jina.ai blocks fake browser UAs but allows honest tool UAs (opposite of most sites)
import { TOOL_UA } from "./version.ts";
const TIMEOUT_MS = 15_000;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	engine: string;
	/** Publication date when the source surface provides one (ISO or human-readable). */
	date?: string;
	/** "indexed" = crawl stamp (e.g. Bing pubDate within 3 days of now), not a publication date */
	dateKind?: "published" | "indexed";
	/** every engine that returned this URL (set by fuse) */
	engines?: string[];
}

export interface SearchOutcome {
	results: SearchResult[];
	engines: string[];
	errors: string[];
	/** per engine: rows returned → rows that passed the relevance gate */
	stats: Record<string, { got: number; kept: number }>;
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
	if (!res.ok) {
		// 202 = DDG's anomaly/challenge wall — the body IS the challenge page, hand it
		// to the parser so it can throw the structured 'ddg challenge' error
		if (res.status === 202 && (res.headers.get("content-type") ?? "").includes("html")) {
			return res.text();
		}
		const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
		err.status = res.status;
		throw err;
	}
	return res.text();
}

// ------------------------------------------------------------------ engines

export function parseDdgHtml(page: string): SearchResult[] { // exported for tests
	if (/anomaly-modal|g-recaptcha/.test(page)) throw new Error("ddg challenge");
	const out: SearchResult[] = [];
	const snippets = [...page.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(
		(m) => stripTags(m[1]),
	);
	// optional per-result date stamp (html endpoint emits it when the source provides one)
	const timestamps = [...page.matchAll(/class="result__timestamp"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
	let i = 0;
	for (const m of page.matchAll(
		/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
	)) {
		const url = unwrapRedirect(m[1]);
		if (!url) continue;
		const date = timestamps[i]?.trim();
		out.push({ title: stripTags(m[2]), url, snippet: snippets[i] ?? "", engine: "ddg", ...(date ? { date } : {}) });
		i++;
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
		// title: inner element with class~="title" when present; else the last
		// breadcrumb segment of the anchor text ("Site › Path › Page Title")
		const inner = m[2];
		const tm = inner.match(/<[^>]*class="[^"]*\btitle[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);
		const rawText = stripTags(inner);
		const fallbackTitle = rawText.includes("›") ? rawText.split("›").pop()!.trim() : rawText;
		const title = (tm ? stripTags(tm[1]) : fallbackTitle).slice(0, 120) || url;
		// the rest of the anchor text after the title is the snippet
		const snippet = (tm ? rawText.replace(stripTags(tm[1]), "").trim() : "").slice(0, 200);
		out.push({ title, url, snippet, engine: "brave" });
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
			out.push({ title: title.slice(0, 120), url, snippet: "", engine: "brave" });
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

/** Bare domain/path echo of the URL (favicon-adjacent link in relayed DDG), not prose. */
function isUrlEcho(s: string): boolean {
	return /^(?:[a-z0-9-]+\.)+[a-z]{2,6}(?:\/\S*)?$/i.test(s);
}

/** Parse r.jina.ai's markdown output of a DDG html/lite page into results. */
export function parseJinaDdg(md: string): SearchResult[] { // exported for tests
	const out: SearchResult[] = [];
	const seen = new Map<string, SearchResult>();
	// markdown links: [title](https://duckduckgo.com/l/?uddg=ENCODED ...) or direct links
	for (const m of md.matchAll(/\[([^\]]{4,400})\]\((https?:\/\/[^)]+)\)/g)) {
		const text = decodeEntities(m[1].replace(/[*_`]/g, "")).trim();
		const url = unwrapRedirect(m[2]);
		if (!url) continue;
		if (/duckduckgo\.com(?!\/l\/)|\/y\.js|bing\.com|\.svg/.test(url)) continue;
		const row = seen.get(url);
		if (!row) {
			// date trails the URL line on html variant ("… 2026-08-20T00:00:00.0000000")
			const tail = md.slice(m.index, m.index + 1200);
			const d = tail.match(/\b(20[12]\d-\d{2}-\d{2})(?:T[0-9:.]+)?/);
			const date = d ? d[1] : undefined;
			const r: SearchResult = { title: text, url, snippet: "", engine: "ddg-jina", ...(date ? { date } : {}) };
			seen.set(url, r);
			out.push(r);
		} else if (row.snippet === "" && !isUrlEcho(text)) {
			// the result__snippet anchor renders as a second [text](same uddg url) link
			// right after the title link — jina drops the class info, we recover it here.
			// (a bare domain/path echo of the URL is the favicon-adjacent link, not prose)
			row.snippet = text.slice(0, 300);
		}
	}
	return out;
}

/** DDG without the jina relay: html GET → lite GET → html POST. */
async function ddgDirect(query: string, maxResults: number, recency: Recency, signal?: AbortSignal): Promise<SearchResult[]> {
	const params = new URLSearchParams({ q: query });
	if (recency) params.set("df", recency);
	const enc = params.toString();

	// 1. html GET — a challenge wall (202/403) means this IP is flagged: the POST
	// retry below would only work around a *soft* block, and lite/POST serve the
	// same wall from the same IP, so give up at once and let jina's IP pool try.
	let softEmpty = false;
	try {
		const page = await get(`https://html.duckduckgo.com/html/?${enc}`, signal);
		const results = parseDdgHtml(page);
		if (results.length > 0) return results.slice(0, maxResults);
		softEmpty = true; // 200 but zero rows — bot-wall serving empty markup
	} catch (err) {
		const msg = String((err as Error)?.message ?? err);
		const st = (err as Error & { status?: number }).status;
		if (msg === "ddg challenge" || st === 202 || st === 403) {
			throw new Error("ddg challenge (rate-limited; jina relay may still work)");
		}
	}

	// 2. lite GET (cheap retry on transient network errors — a challenge wall never
	// reaches this point; that case threw above)
	try {
		const results = parseDdgLite(await get(`https://lite.duckduckgo.com/lite/?${enc}`, signal));
		if (results.length > 0) return results.slice(0, maxResults);
	} catch {
		/* try next */
	}

	// 3. html POST (often bypasses soft GET blocks)
	if (softEmpty) {
		try {
			const results = parseDdgHtml(await get("https://html.duckduckgo.com/html/", signal, enc));
			if (results.length > 0) return results.slice(0, maxResults);
		} catch {
			/* fall to jina */
		}
	}
	throw new Error("no results from duckduckgo (direct)");
}

/** DDG via the jina relay (different IP pool): html first, then lite. */
async function ddgJina(query: string, maxResults: number, recency: Recency, signal?: AbortSignal): Promise<SearchResult[]> {
	const params = new URLSearchParams({ q: query });
	if (recency) params.set("df", recency);
	const enc = params.toString();
	try {
		const results = parseJinaDdg(await jinaGet(`https://html.duckduckgo.com/html/?${enc}`, signal));
		if (results.length > 0) return results.slice(0, maxResults);
	} catch (err) {
		// the relay itself failed (rate limit / network) — the lite relay hits the
		// same r.jina.ai host and will fail the same way; don't pay the jina gap twice
		throw new Error(`no results from duckduckgo (jina relay: ${(err as Error)?.message ?? err})`);
	}
	// html relay answered but zero rows parsed (challenge relayed, or genuinely empty).
	// A second relayed request pays the 3.5s jina gap and relays the same challenge — stop here.
	throw new Error("no results from duckduckgo (jina relay)");
}

/** DDG with the jina relay as fallback — kept for `engine:'ddg'`. */
export async function ddgSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	try {
		return await ddgDirect(query, maxResults, recency, signal);
	} catch {
		return ddgJina(query, maxResults, recency, signal);
	}
}

export async function braveSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const cooldown = hostCooldownUntil("search.brave.com");
	if (cooldown > Date.now()) {
		throw new Error(`brave: cooling down (${Math.ceil((cooldown - Date.now()) / 1000)}s)`);
	}
	const params = new URLSearchParams({ q: query });
	if (recency) {
		const map: Record<string, string> = { d: "pd", w: "pw", m: "pm", y: "py" };
		params.set("tf", map[recency]);
	}
	let page: string;
	try {
		page = await get(`https://search.brave.com/search?${params}`, signal);
	} catch (err) {
		const msg = String((err as Error)?.message ?? err);
		if (msg === "HTTP 429") setHostCooldown("search.brave.com", 60_000);
		throw err;
	}
	const results = parseBrave(page);
	if (results.length === 0) throw new Error("no results from brave");
	return results.slice(0, maxResults);
}

function parseRssItems(xml: string, engine: string): SearchResult[] {
	const out: SearchResult[] = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1];
		const title = stripTags(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
		const url = decodeEntities(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
		const snippet = stripTags(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
		if (!title || !/^https?:\/\//.test(url)) continue;
		const pubRaw = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "").trim();
		let date: string | undefined;
		let dateKind: SearchResult["dateKind"];
		if (pubRaw) {
			const ts = Date.parse(pubRaw);
			if (!Number.isNaN(ts)) {
				date = new Date(ts).toISOString().slice(0, 10);
				// a pubDate within 3 days of now is a crawl stamp, not a publication date
				dateKind = Date.now() - ts < 3 * 86_400_000 ? "indexed" : "published";
			}
		}
		out.push({ title, url, snippet, engine, ...(date ? { date, dateKind } : {}) });
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

// ---------------------------------------------------------------- relevance

const STOP_TOKENS = new Set([
	"how", "to", "in", "vs", "the", "a", "an", "of", "for", "and", "or", "is", "what", "with", "on", "does", "do",
]);

/** Query tokens used by the relevance gate (deduped, stopwords + ≤2-char words removed). */
function gateTokens(query: string): string[] {
	return [...new Set(tokenize(query))].filter((t) => t.length > 2 && !STOP_TOKENS.has(t));
}

/** Does `doc` contain a hit for query token `q`? Exact or prefix match when either side is ≥ 5 chars. */
function tokenHit(q: string, docTokens: Set<string>): boolean {
	if (docTokens.has(q)) return true;
	if (q.length >= 5) {
		for (const d of docTokens) if (d.startsWith(q) || (d.length >= 5 && q.startsWith(d))) return true;
	}
	return false;
}

/**
 * Drop rows that share almost no vocabulary with the query. Runs before fusion
 * on every engine's bucket (including single-engine modes). Non-Latin queries
 * (tokenizer yields nothing) pass everything through.
 */
export function relevanceGate(query: string, rows: SearchResult[]): SearchResult[] {
	const q = gateTokens(query);
	if (q.length === 0) return rows;
	const minHits = Math.min(2, q.length);
	return rows.filter((r) => {
		const path = (() => {
			try {
				return decodeURIComponent(new URL(r.url).pathname).replace(/[-_/.]+/g, " ");
			} catch {
				return r.url;
			}
		})();
		const docTokens = new Set(tokenize(`${r.title} ${r.snippet} ${path}`));
		let hits = 0;
		for (const t of q) if (tokenHit(t, docTokens)) hits++;
		return hits >= minHits;
	});
}

// --------------------------------------------------------------- url normalize

/**
 * Canonical key for cross-engine URL dedupe: scheme/hash stripped, tracking
 * params dropped, www/mobile/amp hosts and paths collapsed, SO question slugs
 * trimmed, params sorted.
 */
export function normalizeUrl(u: string): string {
	let url: URL;
	try {
		url = new URL(u);
	} catch {
		return u.trim().toLowerCase();
	}
	const host = url.hostname
		.toLowerCase()
		.replace(/^(www|m|amp|mobile)\./, "")
		.replace(/^([a-z]{2,3})\.m\./, "$1.");
	let path = url.pathname.replace(/\/+$/, "").replace(/^\/amp(?=\/)/, "").replace(/\/amp$/, "");
	// /index.{html,htm,php} and hashbang paths fold to the directory
	if (url.hash.startsWith("#!/")) path = url.hash.slice(2);
	path = path.replace(/\/index\.(html?|php)$/i, "");
	if (/(^|\.)(stackoverflow|superuser|serverfault)\.com$|\.stackexchange\.com$/.test(host)) {
		path = path.replace(/^(\/questions\/\d+)\/.*/, "$1");
	}
	const params = [...url.searchParams]
		.filter(([k]) => !/^(utm_\w+|fbclid|gclid|ref|ref_src|si)$/i.test(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `${host}${path || "/"}${params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : ""}`;
}

// ------------------------------------------------------------------- fusion

const WEIGHT: Record<string, number> = { ddg: 1, "ddg-lite": 1, "ddg-jina": 0.9, brave: 1, bing: 0.5 };

/**
 * Reciprocal-rank fusion across engine buckets (k=60, per-engine weights),
 * field-merging rows that share a normalized URL: longest snippet, shortest
 * meaningful title, earliest non-crawl date, union of engine names.
 */
export function fuse(buckets: Array<{ name: string; rows: SearchResult[] }>, maxResults: number): SearchResult[] { // exported for tests
	const K = 60;
	const scored = new Map<string, { r: SearchResult; s: number; engines: Set<string> }>();
	for (const { name, rows } of buckets) {
		rows.forEach((r, i) => {
			const key = normalizeUrl(r.url);
			const cur = scored.get(key) ?? { r: { ...r }, s: 0, engines: new Set<string>() };
			cur.s += (WEIGHT[name] ?? 1) / (K + i + 1);
			cur.engines.add(name);
			if (r.snippet.length > cur.r.snippet.length) cur.r.snippet = r.snippet;
			if (r.title.length >= 8 && r.title.length < cur.r.title.length) cur.r.title = r.title;
			if (r.date && r.dateKind !== "indexed" && (!cur.r.date || cur.r.dateKind === "indexed" || r.date < cur.r.date)) {
				cur.r.date = r.date;
				cur.r.dateKind = "published";
			}
			scored.set(key, cur);
		});
	}
	return [...scored.values()]
		.sort((a, b) => b.s - a.s)
		.slice(0, maxResults)
		.map((e) => ({ ...e.r, engines: [...e.engines] }));
}

// --------------------------------------------------------------------- race

/**
 * Default engine: DDG-direct and Bing RSS in parallel, gated, RRF-fused.
 * Fast path returns as soon as one bucket has ≥5 kept rows (300 ms grace for
 * the other); Brave (cooldown-aware) then jina-relayed DDG only when both
 * primary legs came up empty.
 */
export async function searchRace(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const stats: SearchOutcome["stats"] = {};
	const errors: string[] = [];
	const buckets: Array<{ name: string; rows: SearchResult[] }> = [];
	const leg = (name: string, p: Promise<SearchResult[]>) =>
		p.then(
			(rows) => {
				const kept = relevanceGate(query, rows);
				stats[name] = { got: rows.length, kept: kept.length };
				if (kept.length) buckets.push({ name, rows: kept });
			},
			(e) => {
				errors.push(`${name}: ${(e as Error)?.message ?? e}`);
			},
		);
	const ddg = leg("ddg", ddgDirect(query, 15, recency, signal));
	const bing = leg("bing", bingRssSearch(query, 15, recency, signal));
	await Promise.race([ddg, bing]);
	if (buckets.some((b) => b.rows.length >= 5)) await Promise.race([Promise.all([ddg, bing]), sleep(300, signal)]);
	else await Promise.all([ddg, bing]);
	const challenged = errors.some((e) => e.startsWith("ddg: ddg challenge"));
	if (buckets.length === 0 && !challenged && hostCooldownUntil("search.brave.com") <= Date.now()) {
		await leg("brave", braveSearch(query, 15, recency, signal));
	}
	if (buckets.length === 0) await leg("ddg-jina", ddgJina(query, 15, recency, signal));
	return { results: fuse(buckets, maxResults), engines: buckets.map((b) => b.name), errors, stats };
}

/** Run several engines in parallel; gate, RRF-fuse by normalized URL, merge fields. */
export async function multiSearch(
	query: string,
	maxResults: number,
	recency: Recency,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const attempts: Array<{ name: string; fn: () => Promise<SearchResult[]> }> = [
		{ name: "ddg", fn: () => ddgSearch(query, 15, recency, signal) },
		{ name: "brave", fn: () => braveSearch(query, 15, recency, signal) },
		{ name: "bing", fn: () => bingRssSearch(query, 15, recency, signal) },
	];
	const settled = await Promise.allSettled(attempts.map((a) => a.fn()));
	const namedBuckets: Array<{ name: string; rows: SearchResult[] }> = [];
	const engines: string[] = [];
	const errors: string[] = [];
	const stats: SearchOutcome["stats"] = {};
	settled.forEach((r, i) => {
		const name = attempts[i]!.name;
		if (r.status === "fulfilled") {
			const kept = relevanceGate(query, r.value);
			stats[name] = { got: r.value.length, kept: kept.length };
			if (kept.length > 0) {
				namedBuckets.push({ name, rows: kept });
				engines.push(name);
			}
		} else {
			errors.push(`${name}: ${(r.reason as Error)?.message ?? r.reason}`);
		}
	});
	return { results: fuse(namedBuckets, maxResults), engines, errors, stats };
}

// -------------------------------------------------------------------- cache

const CACHE_TTL = 10 * 60 * 1000;
const cache = createDiskBackedCache({ name: "search", maxEntries: 256, ttlMs: CACHE_TTL });

export interface CachedSearch {
	results: SearchResult[];
	engines: string[];
}

export function cacheGet(key: string): CachedSearch | null {
	const hit = cache.get(key);
	if (Array.isArray(hit)) return hit.length > 0 ? { results: hit as SearchResult[], engines: [] } : null; // legacy bare-array shape
	const c = hit as CachedSearch | null;
	return c && c.results.length > 0 ? c : null;
}

export function cacheSet(key: string, value: CachedSearch) {
	if (value.results.length > 0) cache.set(key, value);
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
