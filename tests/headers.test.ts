import assert from "node:assert/strict";
import { test } from "node:test";
import { installFetchMocks, uninstallFetchMocks } from "./helpers.ts"; // MUST precede lib imports (sandboxes HOME)
import { smartFetch } from "../lib/fetcher.ts";
import { pickUA, browserHeaders, storeCookies, cookieHeaderFor } from "../lib/engine.ts";
import { safeConfig } from "../lib/safe.ts";

interface CapturedReq { url: string; headers: Record<string, string>; }
const captured: CapturedReq[] = [];
const realFetch = globalThis.fetch;

/** Serve a healthy (non-thin) page for any URL, capturing request headers. */
function installCapturingFetch() {
	safeConfig.lookup = async () => [{ address: "203.0.113.5", family: 4 }]; // public TEST-NET — passes resolveSafe
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const h = new Headers(init?.headers);
		captured.push({ url: String(input instanceof Request ? input.url : input), headers: Object.fromEntries(h) });
		const body = `<html><body>${"<p>plenty of body text so the thin-page and paywall detours never trigger. </p>".repeat(40)}</body></html>`;
		return new Response(body, { status: 200, headers: { "content-type": "text/html", "Set-Cookie": "pref=1; Path=/" } });
	}) as typeof fetch;
}

function uninstallCapturingFetch() {
	globalThis.fetch = realFetch;
}

test("headers: sticky per-host UA, Sec-Fetch-* everywhere, cookie jar across requests", async () => {
	installFetchMocks(); // just for the sandboxed HOME — our capturing fetch replaces it below
	uninstallFetchMocks();
	installCapturingFetch();
	try {
		captured.length = 0;
		const opts = { maxChars: 5000, waybackEnabled: false, timeoutMs: 5000 };
		await smartFetch(new URL("https://hygiene.test/a"), opts);
		await smartFetch(new URL(`https://hygiene.test/b?nocache=${Date.now()}`), opts);
		assert.ok(captured.length >= 2, `expected ≥2 requests, got ${captured.length}`);
		for (const req of captured) {
			assert.equal(req.headers["sec-fetch-dest"], "document");
			assert.equal(req.headers["sec-fetch-mode"], "navigate");
			assert.equal(req.headers["sec-fetch-site"], "none");
			assert.equal(req.headers["upgrade-insecure-requests"], "1");
			assert.match(req.headers["user-agent"] ?? "", /^Mozilla\/5\.0/);
		}
		// sticky UA: one pick per host for the process lifetime
		assert.equal(new Set(captured.map((r) => r.headers["user-agent"])).size, 1);
		// cookie from response 1 travels on request 2
		assert.ok(!captured[0]!.headers["cookie"]);
		assert.equal(captured[1]!.headers["cookie"], "pref=1");
	} finally {
		uninstallCapturingFetch();
	}
});

test("headers: unit shapes — pickUA stable, storeCookies parses, browserHeaders merges", () => {
	const ua1 = pickUA("unit.test");
	assert.equal(pickUA("unit.test"), ua1);
	assert.match(ua1, /^Mozilla\/5\.0/);
	storeCookies("unit.test", { headers: { getSetCookie: () => ["a=1; Path=/", "b=2"] } } as unknown as Response);
	assert.equal(cookieHeaderFor("unit.test"), "a=1; b=2");
	const h = browserHeaders("unit.test", { acceptLanguage: "es-ES,es;q=0.9,en;q=0.5" });
	assert.equal(h["Accept-Language"], "es-ES,es;q=0.9,en;q=0.5");
	assert.equal(h["Sec-Fetch-Site"], "none");
	assert.equal(h["Cookie"], "a=1; b=2");
});
