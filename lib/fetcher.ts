/**
 * Smart page fetcher: content-type aware, SSRF-guarded, with automatic
 * Wayback Machine fallback when a site blocks us (401/403/429/503).
 */
import { createDiskBackedCache } from "./cache.ts";
import { htmlToText } from "./engine.ts";
import { htmlToMarkdown } from "./extract.ts";
import { topPassages, type PickedPassage } from "./rank.ts";
import { extractPdf, extractPdfViaPoppler } from "./pdf.ts";
import { assertSafeUrl, resolveSafe } from "./safe.ts";

export const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// r.jina.ai blocks fake browser UAs but allows honest tool UAs (opposite of most sites)
import { TOOL_UA } from "./version.ts";

const FETCH_CACHE = createDiskBackedCache({ name: "fetch", maxEntries: 256, ttlMs: 60 * 60 * 1000 }); // 1h, survives restarts
const lastHitByHost = new Map<string, number>();
const MAX_BYTES = 3 * 1024 * 1024; // read at most 3MB
const DEFAULT_TIMEOUT = 15_000;

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

function politeDelay(host: string, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const prev = lastHitByHost.get(host) ?? 0;
		const wait = Math.max(0, prev + 700 - Date.now());
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
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	let current = await resolveSafe(url);
	let custom = opts.headers ?? {};
	let hops = 0;
	for (let hop = 0; ; hop++) {
		await politeDelay(current.host, opts.signal);
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

let lastJinaFetch = 0;
async function jinaFetchText(url: URL, opts: FetchOptions, contentType?: string): Promise<FetchResult | null> {
	const why = jinaBlockReason(url, opts, contentType);
	if (why) return null; // blocked — callers surface the reason via jinaBlockReason when needed
	try {
		const wait = lastJinaFetch + 3_500 - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastJinaFetch = Date.now();
		const timeout = AbortSignal.timeout(30_000);
		const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const res = await fetch(`https://r.jina.ai/${url.href}`, {
			headers: {
				"User-Agent": TOOL_UA,
				Accept: "text/plain",
				...(opts.jinaQuery ? { "X-Query": opts.jinaQuery } : {}),
			},
			signal: combined,
		});
		if (!res.ok) return null;
		let text = await res.text();
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
			text: text.slice(0, opts.maxChars),
			status: 200,
			finalUrl: url.href,
			contentType: "text/markdown (via r.jina.ai)",
			source: "jina",
			truncated: text.length > opts.maxChars,
			fromCache: false,
		};
	} catch {
		return null;
	}
}

// -------------------------------------------------------------- wayback

async function waybackFetch(
	url: URL,
	opts: FetchOptions,
): Promise<FetchResult | null> {
	if (opts.waybackEnabled === false) return null;
	// An authenticated URL has no useful public snapshot, and the availability
	// API call would leak the (possibly secret-bearing) URL to archive.org.
	if (opts.headers && Object.keys(opts.headers).length > 0) return null;
	try {
		const api = new URL("https://archive.org/wayback/available");
		api.searchParams.set("url", url.href);
		const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT);
		const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const res = await fetch(api, { headers: { "User-Agent": UA }, signal: combined });
		const data = (await res.json()) as {
			archived_snapshots?: { closest?: { url: string; timestamp: string } };
		};
		const snap = data.archived_snapshots?.closest;
		if (!snap) return null;
		const snapUrl = new URL(snap.url);
		// headers: undefined — custom headers (Authorization etc.) never reach archive.org
		const { res: sres, bodyText, bytes: bytes2 } = await rawFetch(snapUrl, { ...opts, headers: undefined });
		if (!sres.ok) return null;
		const { text, truncated } = extract(snapUrl, sres.headers.get("content-type") ?? "", bodyText, opts, bytes2, Number(sres.headers.get("content-length") ?? 0));
		return {
			text,
			status: 200,
			finalUrl: snapUrl.href,
			contentType: sres.headers.get("content-type") ?? "text/html",
			source: "wayback",
			waybackDate: snap.timestamp,
			truncated,
			fromCache: false,
		};
	} catch {
		return null;
	}
}

const BINARY_TYPES = /^(image\/|video\/|audio\/|application\/(zip|gzip|x-tar|pdf|octet-stream|wasm|sqlite))/;
function extract(
	url: URL,
	contentType: string,
	body: string,
	opts: FetchOptions,
	bytes?: Buffer,
	contentLength?: number,
): { text: string; truncated: boolean } {
	const ct = contentType.split(";")[0].trim().toLowerCase();

	// PDF → text extraction (poppler if installed, else internal parser)
	if (bytes && (ct === "application/pdf" || /\.pdf($|\?)/i.test(url.pathname))) {
		try {
			const pdfText = extractPdfSync(bytes);
			if (pdfText) {
				const collapsed = pdfText.replace(/\n{3,}/g, "\n\n");
				return { text: collapsed.slice(0, opts.maxChars), truncated: collapsed.length > opts.maxChars };
			}
		} catch {
			return {
				text: `[PDF detected (${bytes.length} bytes) but text extraction failed — likely scanned/image-only or encrypted]`,
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
	if (format === "markdown") {
		try {
			const md = htmlToMarkdown(body, url.href, opts.maxChars);
			if (md.text) return md; // junk check inside; fall through on failure
		} catch {
			/* fall through to flattener */
		}
	}
	const { text, truncated } = htmlToText(body, opts.maxChars);
	if (text.length < 200 && body.length > 5000 && /<app-root|<div id="root"|<div id="app"|ng-app|data-reactroot|__NEXT_DATA__|window\.__INITIAL_STATE__|shreddit|<web-app/i.test(body)) {
		return {
			text: text + "\n\n[page appears to be a client-rendered SPA — little static text available]",
			truncated,
		};
	}
	if (text.length < 200 && body.length > 20000) {
		return {
			text: text + "\n\n[very little readable text extracted from a large page — likely JS-rendered or bot-walled; try the Wayback fallback with no_wayback=false, or a different URL]",
			truncated,
		};
	}
	return { text, truncated };
}

// ------------------------------------------------------------------- main

/**
 * Query-aware wrapper: fetches with a wide extraction window, then ranks
 * passages against opts.query (lib/rank.ts) down to opts.maxChars. Applied
 * AFTER all fallback paths so wayback/jina results benefit equally.
 */
export async function smartFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
	const wide = opts.query?.trim() && !opts.raw ? Math.max(opts.maxChars * 8, 40_000) : opts.maxChars;
	const result = await smartFetchRaw(url, { ...opts, maxChars: wide });
	if (!opts.query?.trim() || opts.raw) return result;
	const { picked, total, passages } = topPassages(result.text, opts.query, opts.maxChars, 600);
	if (picked.length === 0) {
		return { ...result, text: result.text.slice(0, opts.maxChars), truncated: result.text.length > opts.maxChars };
	}
	const parts = picked.map((p) => (p.heading ? `## ${p.heading}\n${p.text}` : p.text));
	const footer = `\n\n[${picked.length} of ${total} passages shown — most relevant to the query. Omit query for the page head.]`;
	let body = parts.join("\n\n");
	const truncated = body.length + footer.length > opts.maxChars;
	if (truncated) body = body.slice(0, Math.max(opts.maxChars - footer.length, 0));
	return { ...result, text: body + footer, truncated, passages };
}

async function smartFetchRaw(url: string, opts: FetchOptions): Promise<FetchResult> {
	const safeUrl = assertSafeUrl(url);
	const cacheKey = `f:${opts.raw ? "raw" : opts.maxChars}:${opts.query ?? ""}:${opts.headers ? JSON.stringify(opts.headers) : ""}:${safeUrl.href}`;
	const cached = opts.noCache ? null : (FETCH_CACHE.get(cacheKey) as FetchResult | null);
	if (cached) return { ...cached, fromCache: true };

	// site adapters: known URL shapes route to their clean API (github/so/hn/reddit/wikipedia)
	if (!opts.raw) {
		const { trySiteAdapter } = await import("./adapters.ts");
		const ad = await trySiteAdapter(safeUrl.href, opts.signal).catch(() => null);
		if (ad) {
			const out: FetchResult = {
				text: ad.text.slice(0, opts.maxChars),
				status: 200,
				finalUrl: safeUrl.href,
				contentType: "text/markdown",
				source: ad.source as any,
				truncated: ad.text.length > opts.maxChars,
				fromCache: false,
			};
			FETCH_CACHE.set(cacheKey, out);
			return out;
		}
	}

	// retry with exponential backoff on transient failures
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const { res, bodyText, bytes, finalUrl, capped, hops } = await rawFetch(safeUrl, opts);
			const notes: string[] = [];
			if (capped) notes.push("body capped at 3MB");
			if (hops > 0) notes.push(`redirected ${hops}×`);
			if ([401, 403, 429, 503].includes(res.status)) {
				const wb = await waybackFetch(safeUrl, opts);
				if (wb) {
					FETCH_CACHE.set(cacheKey, wb);
					return wb;
				}
				if (opts.allowHttpErrors) {
					const { text, truncated } = extract(safeUrl, res.headers.get("content-type") ?? "", bodyText, opts, bytes);
					return { text, status: res.status, finalUrl, contentType: res.headers.get("content-type") ?? "", source: "direct", truncated, fromCache: false, notes };
				}
				throw new Error(`HTTP ${res.status}${res.status === 403 ? " (bot protection?)" : ""}`);
			}
			if (!res.ok) {
				if (opts.allowHttpErrors) {
					const { text, truncated } = extract(safeUrl, res.headers.get("content-type") ?? "", bodyText, opts, bytes);
					return { text, status: res.status, finalUrl, contentType: res.headers.get("content-type") ?? "", source: "direct", truncated, fromCache: false, notes };
				}
				throw new Error(`HTTP ${res.status}`);
			}
			const ctHeader = res.headers.get("content-type") ?? "";
			const { text, truncated } = extract(safeUrl, ctHeader, bodyText, opts, bytes, Number(res.headers.get("content-length") ?? 0));
			// Thin HTML (SPA/bot-wall that 200s) → jina for real rendered text; other types/headers never promoted
			const looksThin = ctHeader.includes("html") && text.replace(/\s+/g, " ").trim().length < 400 && !opts.raw;
			if (looksThin) {
				const why = jinaBlockReason(safeUrl, opts, ctHeader);
				if (why && why !== "disabled" && why !== "raw") notes.push(`jina skipped: ${why}`);
				const jina = await jinaFetchText(safeUrl, opts, ctHeader);
				if (jina && jina.text.replace(/\s+/g, " ").trim().length > text.replace(/\s+/g, " ").trim().length) {
					FETCH_CACHE.set(cacheKey, jina);
					return jina;
				}
			}
			const out: FetchResult = {
				text,
				status: res.status,
				finalUrl,
				contentType: ctHeader,
				source: "direct",
				truncated: truncated || capped,
				fromCache: false,
				notes,
			};
			FETCH_CACHE.set(cacheKey, out);
			return out;
		} catch (err) {
			lastErr = err;
			const msg = String((err as Error)?.message ?? err);
			// don't retry permanent errors
			if (/Blocked (protocol|host|URL)|Invalid URL|too large|Too many redirects|DNS lookup failed/.test(msg)) throw err;
			if (opts.signal?.aborted) throw err;
			await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
		}
	}
	// retry loop exhausted → jina as safety net (network errors, bot walls);
	// no response headers available, so only the header/param/path rules apply
	const jina = await jinaFetchText(safeUrl, opts);
	if (jina) return jina;
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export { decodeEntities };

/** Sync wrapper: run the async extractor synchronously via spawnSync for poppler, zlib for internal. */
import { spawnSync } from "node:child_process";
import { inflateSync as _is, inflateRawSync as _irs } from "node:zlib";

function extractPdfSync(bytes: Buffer): string | null {
	// poppler first (installed on this machine)
	const pdftotext = spawnSync("pdftotext", ["-", "-"], { input: bytes, maxBuffer: 20 * 1024 * 1024, timeout: 20_000 });
	if (pdftotext.status === 0 && pdftotext.stdout && pdftotext.stdout.toString().trim().length > 0) {
		return pdftotext.stdout.toString();
	}
	// internal: inflate FlateDecode streams + parse text operators (sync zlib)
	try {
		const streams = findStreamsInternal(bytes);
		const chunks: string[] = [];
		for (const st of streams) {
			if (/\/Filter\s*\[^\]]*FlateDecode/i.test(st.dict) || /\/Filter\s*\/Fl\b/i.test(st.dict)) {
				try {
					chunks.push(_is(bytes.subarray(st.start, st.end)).toString("latin1"));
				} catch {
					try { chunks.push(_irs(bytes.subarray(st.start, st.end)).toString("latin1")); } catch { /* skip */ }
				}
			} else if (!/\/Filter/.test(st.dict)) {
				chunks.push(bytes.subarray(st.start, st.end).toString("latin1"));
			}
		}
		if (chunks.length === 0) return null;
		// reuse operator parser from pdf.ts via dynamic import is async; inline a simple regex pass:
		const all = chunks.join("\n");
		const lines: string[] = [];
		for (const m of all.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\][]|\\.)*\]\s*TJ/g)) {
			for (const sm of m[0].matchAll(/\((?:\\.|[^\\()])*\)/g)) {
				lines.push(sm[0].slice(1, -1).replace(/\\([nrtbf])/g, (_x, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c).replace(/\\([0-7]{1,3})/g, (_x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1"));
			}
		}
		if (lines.length === 0) return null;
		return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	} catch {
		return null;
	}
}

function findStreamsInternal(data: Buffer): Array<{ dict: string; start: number; end: number }> {
	const streams: Array<{ dict: string; start: number; end: number }> = [];
	const latin = data.toString("latin1");
	let pos = 0;
	while (true) {
		const s = latin.indexOf("stream", pos);
		if (s === -1) break;
		if ((s === 0 || !/[a-zA-Z]/.test(latin[s - 1])) && !latin.startsWith("endstream", s)) {
			const dictStart = latin.lastIndexOf("<<", s);
			const dict = dictStart >= 0 ? latin.slice(Math.max(dictStart, s - 600), s) : "";
			let body = s + 6;
			if (latin[body] === "\r") body++;
			if (latin[body] === "\n") body++;
			const e = latin.indexOf("endstream", body);
			if (e === -1) break;
			streams.push({ dict, start: body, end: e });
			pos = e + 9;
		} else pos = s + 6;
	}
	return streams;
}
