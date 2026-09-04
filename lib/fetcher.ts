/**
 * Smart page fetcher: content-type aware, SSRF-guarded, with automatic
 * Wayback Machine fallback when a site blocks us (401/403/429/503).
 */
import { createTtlCache } from "./cache.ts";
import { htmlToText } from "./engine.ts";

export const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_CACHE = createTtlCache(64, 60 * 60 * 1000); // 1h
const lastHitByHost = new Map<string, number>();
const MAX_BYTES = 3 * 1024 * 1024; // read at most 3MB
const DEFAULT_TIMEOUT = 15_000;

export interface FetchOptions {
	maxChars: number;
	raw?: boolean;
	timeoutMs?: number;
	headers?: Record<string, string>;
	waybackEnabled?: boolean;
	noCache?: boolean;
	signal?: AbortSignal;
}

export interface FetchResult {
	text: string;
	status: number;
	finalUrl: string;
	contentType: string;
	source: "direct" | "wayback";
	waybackDate?: string;
	truncated: boolean;
	fromCache: boolean;
}

// ------------------------------------------------------------- SSRF guard

const BLOCKED_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^0\./,
	/\.local$/i,
	/^\[?::1\]?$/,
	/^\[?fc00:/i,
	/^\[?fe80:/i,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

export function assertSafeUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (!/^https?:$/.test(url.protocol)) throw new Error(`Blocked protocol: ${url.protocol} (use http/https)`);
	const host = url.hostname;
	for (const p of BLOCKED_HOST_PATTERNS) if (p.test(host)) throw new Error(`Blocked host (SSRF protection): ${host}`);
	return url;
}

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
): Promise<{ res: Response; bodyText: string }> {
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT);
	const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	await politeDelay(url.host, opts.signal);
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
			"Accept-Language": "en-US,en;q=0.9",
			...extraHeaders,
			...(opts.headers ?? {}),
		},
		redirect: "follow",
		signal: combined,
	});
	const len = Number(res.headers.get("content-length") ?? 0);
	if (len > MAX_BYTES) throw new Error(`Response too large: ${(len / 1e6).toFixed(1)}MB`);
	const buf = await res.arrayBuffer();
	const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, MAX_BYTES));
	return { res, bodyText };
}

// -------------------------------------------------------------- wayback

async function waybackFetch(
	url: URL,
	opts: FetchOptions,
): Promise<FetchResult | null> {
	if (opts.waybackEnabled === false) return null;
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
		const { res: sres, bodyText } = await rawFetch(snapUrl, opts);
		if (!sres.ok) return null;
		const { text, truncated } = extract(snapUrl, sres.headers.get("content-type") ?? "", bodyText, opts);
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

// -------------------------------------------------------------- extraction

const BINARY_TYPES = /^(image\/|video\/|audio\/|application\/(zip|gzip|x-tar|pdf|octet-stream|wasm|sqlite))/;

function extract(
	url: URL,
	contentType: string,
	body: string,
	opts: FetchOptions,
): { text: string; truncated: boolean } {
	const ct = contentType.split(";")[0].trim().toLowerCase();

	// Binary content: metadata only
	if (BINARY_TYPES.test(ct)) {
		return {
			text: `[binary content: ${ct} — ${body.length} bytes received, not text-extractable]`,
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

export async function smartFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
	const safeUrl = assertSafeUrl(url);
	const cacheKey = `f:${opts.raw ? "raw" : opts.maxChars}:${opts.headers ? JSON.stringify(opts.headers) : ""}:${safeUrl.href}`;
	const cached = opts.noCache ? null : (FETCH_CACHE.get(cacheKey) as FetchResult | null);
	if (cached) return { ...cached, fromCache: true };

	// retry with exponential backoff on transient failures
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const { res, bodyText } = await rawFetch(safeUrl, opts);
			if ([401, 403, 429, 503].includes(res.status)) {
				const wb = await waybackFetch(safeUrl, opts);
				if (wb) {
					FETCH_CACHE.set(cacheKey, wb);
					return wb;
				}
				throw new Error(`HTTP ${res.status}${res.status === 403 ? " (bot protection?)" : ""}`);
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { text, truncated } = extract(safeUrl, res.headers.get("content-type") ?? "", bodyText, opts);
			const out: FetchResult = {
				text,
				status: res.status,
				finalUrl: res.url || safeUrl.href,
				contentType: res.headers.get("content-type") ?? "",
				source: "direct",
				truncated,
				fromCache: false,
			};
			FETCH_CACHE.set(cacheKey, out);
			return out;
		} catch (err) {
			lastErr = err;
			const msg = String((err as Error)?.message ?? err);
			// don't retry permanent errors
			if (/Blocked (protocol|host)|Invalid URL|too large/.test(msg)) throw err;
			if (opts.signal?.aborted) throw err;
			await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export { decodeEntities };
