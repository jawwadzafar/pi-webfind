/**
 * Smart page fetcher: content-type aware, SSRF-guarded, with automatic
 * Wayback Machine fallback when a site blocks us (401/403/429/503).
 */
import { createDiskBackedCache } from "./cache.ts";
import { htmlToText } from "./engine.ts";
import { extractDate, htmlToMarkdown } from "./extract.ts";
import { topPassages, type PickedPassage } from "./rank.ts";
import { extractPdf } from "./pdf.ts";
import { assertSafeUrl, resolveSafe } from "./safe.ts";
import { assertOnline, hostCooldownUntil, jinaGap, markOnline, noteNotFound, setHostCooldown } from "./net.ts";

export const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// r.jina.ai blocks fake browser UAs but allows honest tool UAs (opposite of most sites)
import { TOOL_UA } from "./version.ts";

const FETCH_CACHE = createDiskBackedCache({ name: "fetch", maxEntries: 64, ttlMs: 60 * 60 * 1000 }); // 1h, survives restarts
const lastHitByHost = new Map<string, number>();
const MAX_BYTES = 3 * 1024 * 1024; // read at most 3MB
const DEFAULT_TIMEOUT = 15_000;
/** Extraction window for the full-text cache: one entry per URL holds up to this many chars. */
const EXTRACT_CAP = 200_000;

export interface FetchOptions {
	/** Optional query — when set, return the intro + query-relevant passages instead of the page head. */
	query?: string;
	maxChars: number;
	raw?: boolean;
	/** "markdown" (default): structure-aware article extraction. "text": legacy flattener. */
	format?: "markdown" | "text";
	timeoutMs?: number;
	headers?: Record<string, string>;
	waybackEnabled?: boolean;
	noCache?: boolean;
	/** Return 4xx/5xx responses (with body) instead of throwing — useful for API status checks (e.g. 404 = name available). */
	allowHttpErrors?: boolean;
	/** opt out of the r.jina.ai reader fallback for this call (default: enabled) */
	jinaEnabled?: boolean;
	/** query forwarded to the reader proxy (X-Query header) for targeted extraction */
	jinaQuery?: string;
	/** char offset into the extracted document; head view only (ignored with query/raw) */
	offset?: number;
	signal?: AbortSignal;
}

export interface FetchResult {
	text: string;
	status: number;
	finalUrl: string;
	contentType: string;
	source:
		| "direct"
		| "wayback"
		| "jina"
		| "github-api"
		| "github-issue-api"
		| "github-pr-api"
		| "github-raw"
		| "stackexchange-api"
		| "hn-algolia"
		| "reddit-json"
		| "wikipedia-rest"
		| "arxiv-pdf"
		| "markdown";
	waybackDate?: string;
	truncated: boolean;
	fromCache: boolean;
	/** publication date (YYYY-MM-DD) from meta/JSON-LD/<time>/URL path, when found */
	date?: string;
	/** extracted chars before any slicing (≤ EXTRACT_CAP); set on the head view */
	totalChars?: number;
	/** start offset of `text` within the extracted document (head view) */
	offset?: number;
	/** provenance notes ("jina skipped: custom headers", "body capped at 3MB", "redirected 2×") */
	notes?: string[];
	/** ranked passages (incl. scores) from query-aware extraction — set when opts.query was given */
	passages?: PickedPassage[];
}

// --------------------------------------------------------------- SSRF guard
// async address-level checks live in lib/safe.ts; assertSafeUrl is re-exported
// from there (sync subset for cache keys / adapter routing).

export { assertSafeUrl };

// ------------------------------------------------------------------- helpers

function politeDelay(host: string, signal?: AbortSignal, deadlineAt = Number.POSITIVE_INFINITY): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(); // never sleep past an aborted signal
		const prev = lastHitByHost.get(host) ?? 0;
		const wait = Math.max(0, Math.min(prev + 700 - Date.now(), Math.max(0, deadlineAt - Date.now())));
		lastHitByHost.set(host, Date.now() + wait);
		if (wait === 0) return resolve();
		const t = setTimeout(resolve, wait);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			resolve();
		}, { once: true });
	});
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/"/g, '"').replace(/&#39;|&#x27;|'/g, "'")
		.replace(/</g, "<").replace(/>/g, ">")
		.replace(/&nbsp;/g, " ").replace(/&/g, "&");
}

async function rawFetch(
	url: URL,
	opts: FetchOptions,
	extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; bodyText: string; bytes: Buffer; finalUrl: string; capped: boolean; hops: number }> {
	// one deadline for the whole call — the signal smartFetchRaw built already
	// carries the timeout; no per-attempt timer here
	const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT);
	let current = await resolveSafe(url);
	let custom = opts.headers ?? {};
	let hops = 0;
	for (let hop = 0; ; hop++) {
		await politeDelay(current.host, opts.signal, Number(opts.timeoutMs) || Number.POSITIVE_INFINITY);
		const res = await fetch(current, {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
				"Accept-Language": "en-US,en;q=0.9",
				...extraHeaders,
				...custom,
			},
			redirect: "manual",
			signal,
		});
		const loc = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && loc) {
			await res.body?.cancel();
			if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}) from ${url.href}`);
			const next = await resolveSafe(new URL(loc, current)); // throws Blocked host → no retry, no jina
			if (next.host !== current.host) custom = {}; // drop Authorization etc. across hosts, like browsers
			current = next;
			hops++;
			continue;
		}
		const { bytes, capped } = await readCapped(res);
		const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		return { res, bodyText, bytes, finalUrl: current.href, capped, hops };
	}
}

const MAX_REDIRECTS = 5;
const SKIP_BODY = /^(image|video|audio|font)\/|^application\/(zip|gzip|x-tar|octet-stream|wasm|sqlite|x-7z-compressed|x-rar)/;

/** Stream the body with a hard cap; skip the download entirely for binary types. */
async function readCapped(res: Response): Promise<{ bytes: Buffer; capped: boolean }> {
	const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
	const len = Number(res.headers.get("content-length") ?? 0);
	if (ct && SKIP_BODY.test(ct)) {
		await res.body?.cancel();
		return { bytes: Buffer.alloc(0), capped: false };
	}
	if (len > MAX_BYTES) {
		await res.body?.cancel();
		throw new Error(`Response too large: ${(len / 1e6).toFixed(1)}MB`);
	}
	if (!res.body) return { bytes: Buffer.alloc(0), capped: false };
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (received + value.byteLength > MAX_BYTES) {
			chunks.push(value.subarray(0, MAX_BYTES - received));
			received = MAX_BYTES;
			await reader.cancel();
			return { bytes: Buffer.concat(chunks, received), capped: true };
		}
		chunks.push(value);
		received += value.byteLength;
	}
	return { bytes: Buffer.concat(chunks, received), capped: false };
}

// ---------------------------------------------------- jina reader proxy

const SECRET_PARAM = /^(token|key|api[_-]?key|auth|authorization|sig|signature|secret|password|access[_-]?token|code|session|jwt)$/i;
const NON_HTML_PATH = /\.(json|xml|txt|csv|pdf|md|yaml|yml|rss|atom)(\?|$)/i;

/** null = allowed; otherwise the reason, recorded in FetchResult.notes. */
export function jinaBlockReason(url: URL, opts: FetchOptions, contentType?: string): string | null {
	if (opts.jinaEnabled === false) return "disabled";
	if (opts.raw) return "raw";
	if (opts.headers && Object.keys(opts.headers).length > 0) return "custom headers";
	for (const k of url.searchParams.keys()) if (SECRET_PARAM.test(k)) return `secret-looking param '${k}'`;
	if (contentType !== undefined) {
		const ct = contentType.split(";")[0]!.trim().toLowerCase();
		if (ct && !/html/.test(ct)) return `content-type ${ct}`;
	} else if (NON_HTML_PATH.test(url.pathname + url.search)) {
		return "non-HTML path";
	}
	return null;
}

async function jinaFetchText(url: URL, opts: FetchOptions, contentType?: string): Promise<Extracted | null> {
	const why = jinaBlockReason(url, opts, contentType);
	if (why) return null; // blocked — callers surface the reason via jinaBlockReason when needed
	try {
		assertOnline();
		await jinaGap(opts.signal);
		const res = await fetch(`https://r.jina.ai/${url.href}`, {
			headers: {
				"User-Agent": TOOL_UA,
				Accept: "text/plain",
				...(opts.jinaQuery ? { "X-Query": opts.jinaQuery } : {}),
			},
			signal: opts.signal,
		});
		if (!res.ok) return null;
		markOnline();
		let text = await res.text();
		// jina 200s even when the ORIGIN 404'd — it prepends "Warning: Target URL
		// returned error 404"; treat those bodies as failures so callers surface
		// the real status instead of caching error-page text
		const originErr = text.match(/^Warning: Target URL returned error (\d{3})/m);
		if (originErr) {
			const err = new Error(`HTTP ${originErr[1]}`) as Error & { status?: number };
			err.status = Number(originErr[1]);
			throw err;
		}
		if (text.trim().length < 40) return null;
		// jina sometimes returns the block-page itself — detect and reject
		const hardBlock = /You've been blocked|blocked by network security|log in to your (developer token|Reddit account)/i.test(
			text.slice(0, 3000),
		);
		const softBlock = /Warning: (Target URL returned error|This page maybe requiring CAPTCHA)|Just a moment\.\.\.|Checking your browser/i.test(
			text.slice(0, 2000),
		);
		if (hardBlock) return null;
		if (softBlock) {
			// keep only if there's substantial real content after the warning
			const bodyStart = text.indexOf("Markdown Content:");
			const body = bodyStart >= 0 ? text.slice(bodyStart) : "";
			if (body.replace(/\s+/g, " ").trim().length < 600) return null;
		}
		return {
			text,
			status: 200,
			finalUrl: url.href,
			contentType: "text/markdown (via r.jina.ai)",
			source: "jina",
			truncated: false,
			fromCache: false,
			at: Date.now(),
		};
	} catch {
		return null;
	}
}

// -------------------------------------------------------------- wayback

async function waybackFetch(
	url: URL,
	opts: FetchOptions,
): Promise<Extracted | null> {
	if (opts.waybackEnabled === false) return null;
	// An authenticated URL has no useful public snapshot, and the availability
	// API call would leak the (possibly secret-bearing) URL to archive.org.
	if (opts.headers && Object.keys(opts.headers).length > 0) return null;
	try {
		assertOnline();
		const api = new URL("https://archive.org/wayback/available");
		api.searchParams.set("url", url.href);
		const res = await fetch(api, { headers: { "User-Agent": UA }, signal: opts.signal });
		const data = (await res.json()) as {
			archived_snapshots?: { closest?: { url: string; timestamp: string } };
		};
		const snap = data.archived_snapshots?.closest;
		if (!snap) return null;
		markOnline();
		const snapUrl = new URL(snap.url);
		// headers: undefined — custom headers (Authorization etc.) never reach archive.org
		const { res: sres, bodyText, bytes: bytes2 } = await rawFetch(snapUrl, { ...opts, headers: undefined });
		if (!sres.ok) return null;
		const { text } = await extract(snapUrl, sres.headers.get("content-type") ?? "", bodyText, { ...opts, maxChars: EXTRACT_CAP }, bytes2, Number(sres.headers.get("content-length") ?? 0));
		return {
			text,
			status: 200,
			finalUrl: snapUrl.href,
			contentType: sres.headers.get("content-type") ?? "text/html",
			source: "wayback",
			waybackDate: snap.timestamp,
			truncated: false,
			fromCache: false,
			at: Date.now(),
		};
	} catch {
		return null;
	}
}

const BINARY_TYPES = /^(image\/|video\/|audio\/|application\/(zip|gzip|x-tar|pdf|octet-stream|wasm|sqlite))/;
async function extract(
	url: URL,
	contentType: string,
	body: string,
	opts: FetchOptions,
	bytes?: Buffer,
	contentLength?: number,
): Promise<{ text: string; truncated: boolean; date?: string }> {
	const ct = contentType.split(";")[0].trim().toLowerCase();

	// PDF → text extraction (poppler if installed, else internal parser)
	if (bytes && (ct === "application/pdf" || /\.pdf($|\?)/i.test(url.pathname))) {
		try {
			const pdfText = await extractPdf(bytes);
			const collapsed = pdfText.replace(/\n{3,}/g, "\n\n");
			return { text: collapsed.slice(0, opts.maxChars), truncated: collapsed.length > opts.maxChars };
		} catch (err) {
			return {
				text: `[PDF detected (${bytes.length} bytes) but text extraction failed: ${(err as Error).message}]`,
				truncated: false,
			};
		}
	}

	// Binary content: metadata only (body is not downloaded for these types)
	if (BINARY_TYPES.test(ct)) {
		const size = contentLength !== undefined && contentLength > 0 ? `${(contentLength / 1e6).toFixed(1)}MB` : "size unknown";
		return {
			text: `[binary content: ${ct} — Content-Length ${size}, not downloaded]`,
			truncated: false,
		};
	}
	if (opts.raw) {
		return { text: body.slice(0, opts.maxChars), truncated: body.length > opts.maxChars };
	}

	// JSON → pretty print
	if (ct === "application/json" || ct.endsWith("+json")) {
		try {
			const pretty = JSON.stringify(JSON.parse(body), null, 2);
			return { text: pretty.slice(0, opts.maxChars), truncated: pretty.length > opts.maxChars };
		} catch {
			/* fall through to text */
		}
	}
	if (ct.startsWith("text/") && !ct.includes("html")) {
		return { text: body.slice(0, opts.maxChars), truncated: body.length > opts.maxChars };
	}

	// HTML → readable text
	const format = opts.format ?? "markdown";
	const date = extractDate(body, url.href);
	if (format === "markdown") {
		try {
			const md = htmlToMarkdown(body, url.href, opts.maxChars);
			if (md.text) return { ...md, date }; // junk check inside; fall through on failure
		} catch {
			/* fall through to flattener */
		}
	}
	const { text, truncated } = htmlToText(body, opts.maxChars);
	const withDate = { date };
	if (text.length < 200 && body.length > 5000 && /<app-root|<div id="root"|<div id="app"|ng-app|data-reactroot|__NEXT_DATA__|window\.__INITIAL_STATE__|shreddit|<web-app/i.test(body)) {
		return {
			text: text + "\n\n[page appears to be a client-rendered SPA — little static text available]",
			truncated,
			...withDate,
		};
	}
	if (text.length < 200 && body.length > 20000) {
		return {
			text: text + "\n\n[very little readable text extracted from a large page — likely JS-rendered or bot-walled; try the Wayback fallback with no_wayback=false, or a different URL]",
			truncated,
			...withDate,
		};
	}
	return { text, truncated, ...withDate };
}

// ------------------------------------------------------------------- main

/**
 * Error message with the cause's errno code appended: "fetch failed (ECONNREFUSED)".
 */
export function describeError(err: unknown): string {
	const msg = String((err as Error)?.message ?? err);
	const code =
		(err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
	return code && !msg.includes(code) ? `${msg} (${code})` : msg;
}

type ErrClass = "permanent" | "notfound" | "auth" | "ratelimit" | "transient";

/** Bucket an error or HTTP status into the retry-policy class. */
function classify(x: number | unknown): ErrClass {
	if (typeof x === "number") {
		if (x === 401 || x === 403) return "auth";
		if (x === 429) return "ratelimit";
		if (x === 404 || x === 410) return "notfound";
		return "transient"; // 5xx and odd 4xx
	}
	const msg = String((x as Error)?.message ?? x);
	if (/Blocked (protocol|host)|Invalid URL|too large|Too many redirects|DNS lookup failed/.test(msg)) return "permanent";
	if ((x as Error)?.name === "AbortError") return "permanent";
	return "transient";
}

/** Retry-After header (seconds or HTTP-date) in ms. */
function retryAfterMs(v: string | null): number | undefined {
	if (!v) return undefined;
	const s = Number(v);
	if (Number.isFinite(s) && s >= 0) return s * 1000;
	const d = Date.parse(v);
	return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

function httpMessage(host: string, status: number): string {
	if (status === 401 || status === 403) return `HTTP ${status} — ${host} refuses unauthenticated requests`;
	if (status === 429) return `HTTP 429 — ${host} rate-limits us`;
	return `HTTP ${status}`;
}

/** Hosts that always wall unauthenticated scrapers — jina relay is skipped for them (reddit policy). */
const KNOWN_WALLS = [/(^|\.)reddit\.com$/];

/** What the disk cache stores: one entry per URL, independent of maxChars/query/offset. */
interface Extracted {
	text: string;
	status: number;
	finalUrl: string;
	contentType: string;
	source: FetchResult["source"];
	waybackDate?: string;
	notes?: string[];
	truncated?: boolean;
	fromCache?: boolean;
	date?: string;
	at: number;
}

function headView(text: string, opts: FetchOptions): { body: string; truncated: boolean } {
	const totalChars = text.length;
	const start = Math.max(0, Math.floor(opts.offset ?? 0));
	if (start >= totalChars) {
		return { body: `[offset ${start} is past the end (${totalChars} chars)]`, truncated: false };
	}
	// budgets <600 never get a truncation footer (E5: a tiny query+maxChars call
	// must not come back all footer) — they simply end at maxChars
	if (opts.maxChars < 600) {
		const end = Math.min(start + opts.maxChars, totalChars);
		return { body: text.slice(start, end), truncated: end < totalChars };
	}
	const budget = Math.max(1, opts.maxChars - 120); // footer reserve
	const end = Math.min(start + budget, totalChars);
	const truncated = end < totalChars;
	if (!truncated) return { body: text.slice(start, end), truncated: false };
	const footer = `\n\n[truncated at ${end} of ${totalChars} chars — pass offset:${end} for the next part, or a query]`;
	// footer lives INSIDE the budget (E3): body = budget − footer.length, total ≤ maxChars
	const bodyEnd = Math.min(end, start + Math.max(1, budget - footer.length));
	const footerText = `\n\n[truncated at ${bodyEnd} of ${totalChars} chars — pass offset:${bodyEnd} for the next part, or a query]`;
	return { body: text.slice(start, bodyEnd) + footerText, truncated: true };
}

export async function smartFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
	// full-text cache: one entry per URL — the view (head / query / offset) is
	// derived per call from the stored extraction
	const extracted = await smartFetchRaw(url, { ...opts });
	const base: FetchResult = {
		text: extracted.text,
		status: extracted.status,
		finalUrl: extracted.finalUrl,
		contentType: extracted.contentType,
		source: extracted.source,
		...(extracted.waybackDate ? { waybackDate: extracted.waybackDate } : {}),
		...(extracted.date ? { date: extracted.date } : {}),
		notes: extracted.notes,
		truncated: false,
		fromCache: extracted.fromCache === true,
	};
	const totalChars = extracted.text.length;

	if (opts.raw || extracted.source === "jina") {
		// raw and jina views slice directly (jina text is already reader-formatted)
		if (opts.raw) {
			const start = Math.max(0, Math.floor(opts.offset ?? 0));
			if (start >= totalChars) {
				return { ...base, text: `[offset ${start} is past the end (${totalChars} chars)]`, truncated: false, totalChars, offset: start };
			}
			const body = extracted.text.slice(start, start + opts.maxChars);
			return { ...base, text: body, truncated: start + opts.maxChars < totalChars, totalChars, offset: start };
		}
	}
	if (opts.query?.trim() && !opts.raw) {
		const { picked, total, passages } = topPassages(extracted.text, opts.query, opts.maxChars, 600);
		if (picked.length === 0) {
			const { body } = headView(extracted.text, opts);
			return { ...base, text: body, truncated: totalChars > opts.maxChars, totalChars, offset: opts.offset ?? 0, passages };
		}
		const parts: string[] = [];
		let prevHeading: string | undefined;
		for (const p of picked) {
			parts.push(p.heading && p.heading !== prevHeading ? `## ${p.heading}\n${p.text}` : p.text);
			prevHeading = p.heading;
		}
		const footer = `\n\n[${picked.length} of ${total} passages shown — most relevant to the query. Omit query for the page head; offset pages it.]`;
		let body = parts.join("\n\n");
		const truncated = body.length + footer.length > opts.maxChars;
		if (truncated) body = body.slice(0, Math.max(opts.maxChars - footer.length, 0));
		return { ...base, text: body + footer, truncated, totalChars, offset: opts.offset ?? 0, passages };
	}
	// head view with optional offset
	const { body, truncated } = headView(extracted.text, opts);
	return { ...base, text: body, truncated, totalChars, offset: Math.max(0, Math.floor(opts.offset ?? 0)) };
}

async function smartFetchRaw(url: string, opts: FetchOptions): Promise<Extracted> {
	const safeUrl = assertSafeUrl(url);
	const cacheKey = `x:${opts.raw ? "raw" : "md"}:${opts.headers ? JSON.stringify(opts.headers) : ""}:${safeUrl.href}`;
	const cached = opts.noCache ? null : (FETCH_CACHE.get(cacheKey) as Extracted | null);
	if (cached) return { ...cached, fromCache: true };

	// site adapters: known URL shapes route to their clean API (github/so/hn/reddit/wikipedia)
	if (!opts.raw) {
		const { trySiteAdapter } = await import("./adapters.ts");
		const ad = await trySiteAdapter(safeUrl.href, opts.signal).catch(() => null);
		if (ad) {
			const out: Extracted = {
				text: ad.text,
				status: 200,
				finalUrl: safeUrl.href,
				contentType: "text/markdown",
				source: ad.source as any,
				truncated: false,
				fromCache: false,
				...(ad.date ? { date: ad.date } : {}),
				at: Date.now(),
			};
			FETCH_CACHE.set(cacheKey, out);
			return out;
		}
	}

	const deadlineAt = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT);
	const remaining = () => deadlineAt - Date.now();
	const overall = opts.signal
		? AbortSignal.any([opts.signal, AbortSignal.timeout(Math.max(1, remaining()))])
		: AbortSignal.timeout(Math.max(1, remaining()));
	const inner: FetchOptions = { ...opts, signal: overall, maxChars: EXTRACT_CAP };

	// host rate-limited from an earlier call? skip straight to Wayback/jina
	const cooldownLeft = hostCooldownUntil(safeUrl.host) - Date.now();
	if (cooldownLeft > 0) {
		const secs = Math.ceil(cooldownLeft / 1000);
		if (remaining() > 2_000) {
			const wb = await waybackFetch(safeUrl, inner);
			if (wb) return store(cacheKey, wb, safeUrl);
		}
		const j = remaining() > 2_000 + 3_500 ? await jinaFetchText(safeUrl, inner) : null;
		if (j) return store(cacheKey, j, safeUrl);
		throw new Error(`HTTP 429 — ${safeUrl.host} rate-limits us; retry in ${secs}s`);
	}

	let lastErr: unknown;
	let waybackTried = false;
	for (let attempt = 0; attempt < 3 && remaining() > 0; attempt++) {
		try {
			const { res, bodyText, bytes, finalUrl, capped, hops } = await rawFetch(safeUrl, inner);
			markOnline();
			const notes: string[] = [];
			if (capped) notes.push("body capped at 3MB");
			if (hops > 0) notes.push(`redirected ${hops}×`);
			if (res.ok) {
				const ctHeader = res.headers.get("content-type") ?? "";
				const { text, date } = await extract(safeUrl, ctHeader, bodyText, inner, bytes, Number(res.headers.get("content-length") ?? 0));
				// Thin HTML (SPA/bot-wall that 200s) → jina for real rendered text
				const looksThin = ctHeader.includes("html") && text.replace(/\s+/g, " ").trim().length < 400 && !opts.raw;
				if (looksThin && remaining() > 5_500) {
					const why = jinaBlockReason(safeUrl, opts, ctHeader);
					if (why && why !== "disabled" && why !== "raw") notes.push(`jina skipped: ${why}`);
					const jina = await jinaFetchText(safeUrl, inner, ctHeader);
					if (jina && jina.text.replace(/\s+/g, " ").trim().length > text.replace(/\s+/g, " ").trim().length) {
						jina.notes = notes;
						return store(cacheKey, jina, safeUrl);
					}
				}
				const out: Extracted = { text, status: res.status, finalUrl, contentType: ctHeader, source: "direct", truncated: false, fromCache: false, notes, date, at: Date.now() };
				return store(cacheKey, out, safeUrl, finalUrl);
			}
			const cls = classify(res.status);
			if (cls === "ratelimit") {
				const ra = retryAfterMs(res.headers.get("retry-after"));
				setHostCooldown(safeUrl.host, Math.min(ra ?? 60_000, 300_000));
			}
			// wayback fallback for auth walls, rate limits and flaky 5xx/503
			if ((cls === "auth" || cls === "ratelimit" || res.status === 503) && !waybackTried && remaining() > 2_000 && opts.waybackEnabled !== false) {
				waybackTried = true;
				const wb = await waybackFetch(safeUrl, inner);
				if (wb) return store(cacheKey, wb, safeUrl);
			}
			if (opts.allowHttpErrors) {
				const { text } = await extract(safeUrl, res.headers.get("content-type") ?? "", bodyText, inner, bytes);
				return { text, status: res.status, finalUrl, contentType: res.headers.get("content-type") ?? "", source: "direct", truncated: false, fromCache: false, notes, at: Date.now() };
			}
			if (cls === "auth") {
				// jina renders public pages fine even when the origin 401s anonymous hits
				const jina = remaining() > 5_500 ? await jinaFetchText(safeUrl, inner) : null;
				if (jina) return store(cacheKey, jina, safeUrl);
				const wall = KNOWN_WALLS.some((re) => re.test(safeUrl.host));
				throw new Error(`HTTP ${res.status} — ${safeUrl.host} refuses unauthenticated requests; Wayback has no snapshot; ${wall ? "no free path (reddit)" : "no free path"}`);
			}
			if (cls === "ratelimit") {
				const secs = Math.ceil(Math.min(retryAfterMs(res.headers.get("retry-after")) ?? 60_000, 300_000) / 1000);
				throw new Error(`HTTP 429 — ${safeUrl.host} rate-limits us; retry in ${secs}s`);
			}
			if (cls === "notfound") throw new Error(`HTTP 404 — ${safeUrl.host} has no such page`);
			lastErr = new Error(httpMessage(safeUrl.host, res.status)); // 5xx → backoff and retry
		} catch (err) {
			lastErr = err;
			let cls: ErrClass = classify(err);
			const structured = (err as { code?: string })?.code ?? "";
			// structured auth/ratelimit throws above are terminal even though classify()
			// sees only the message text (which reads "HTTP 401/429 ...")
			if (structured === "HTTP_401" || structured === "HTTP_403") cls = "auth";
			if (structured === "HTTP_429") cls = "ratelimit";
			if (cls !== "transient" || overall.aborted || opts.signal?.aborted) throw err;
			const code = (err as { cause?: { code?: string } })?.cause?.code;
			if (code === "ENOTFOUND" || code === "ENETUNREACH") noteNotFound(safeUrl.host);
		}
		const backoff = 300 * 3 ** attempt;
		if (remaining() < backoff + 500) break;
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, backoff);
			overall.addEventListener("abort", () => {
				clearTimeout(t);
				resolve();
			}, { once: true });
		});
	}
	// budget left → jina as the last leg
	if (remaining() > 5_500) {
		const jina = await jinaFetchText(safeUrl, inner);
		if (jina) return store(cacheKey, jina, safeUrl);
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Cache the extraction under its key (and the finalUrl key when redirected). */
function store(key: string, ex: Extracted, safeUrl: URL, finalUrl?: string): Extracted {
	const done = { ...ex, fromCache: false, at: Date.now() };
	FETCH_CACHE.set(key, done);
	if (finalUrl && finalUrl !== safeUrl.href) {
		const altKey = `${key.split(":").slice(0, 3).join(":")}:${finalUrl}`;
		FETCH_CACHE.set(altKey, done);
	}
	return { ...done, fromCache: false };
}

export { decodeEntities };
