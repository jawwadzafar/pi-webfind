import assert from "node:assert/strict";
import { test } from "node:test";
import { installFetchMocks, uninstallFetchMocks } from "./helpers.ts"; // MUST precede lib imports (sandboxes HOME)
import { smartFetch } from "../lib/fetcher.ts";
import { safeConfig } from "../lib/safe.ts";

const realFetch = globalThis.fetch;

function serve(status: number, body: string, contentType = "text/html") {
	safeConfig.lookup = async () => [{ address: "203.0.113.5", family: 4 }];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://archive.ph/") || url.startsWith("https://web.archive.org/")) {
			return new Response("no mirror", { status: 404 }); // keep the mirror legs dead
		}
		return new Response(body, { status, headers: { "content-type": contentType } });
	}) as typeof fetch;
}

function restore() {
	globalThis.fetch = realFetch;
}

const opts = { maxChars: 3000, timeoutMs: 5000 };
// note: no_wayback (waybackEnabled:false) disables the Wayback AND archive.ph mirror legs
// by design — paywall tests that exercise the mirror path keep wayback enabled.

/** Point the disk caches at a fresh sandboxed HOME (helpers.ts does this at import time). */
function sandboxHome() {
	installFetchMocks(); // just for the sandboxed HOME — our mock replaces it right after
	uninstallFetchMocks();
}

test("paywall: short 'sign in to read' wall falls back honestly when both mirrors are dead", async () => {
	sandboxHome();
	serve(200, "<html><body><div>Subscribe to continue. Sign in to read the full article.</div></body></html>");
	try {
		const r = await smartFetch(new URL("https://paywall-a.test/a"), opts);
		// wayback API answers "no snapshot" and archive.ph 404s → wall comes back as-is
		assert.match(r.text, /Sign in to read/);
		assert.equal(r.source, "direct");
	} finally {
		restore();
	}
});

test("paywall: mirror success replaces the wall body and tags the note", async () => {
	sandboxHome();
	safeConfig.lookup = async () => [{ address: "203.0.113.5", family: 4 }];
	let sawMirror = false;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://archive.ph/newest/")) {
			sawMirror = true;
			return new Response(
				`<html><body>${"<p>Full article text recovered from the archive mirror. </p>".repeat(30)}</body></html>`,
				{ status: 200, headers: { "content-type": "text/html" } },
			);
		}
		return new Response("<html><body>Subscribe. Sign in to read the full article.</body></html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		});
	}) as typeof fetch;
	try {
		const r = await smartFetch(new URL("https://paywall-b.test/b"), opts);
		assert.ok(sawMirror, "archive-ph leg was not attempted");
		assert.match(r.text, /recovered from the archive mirror/);
		assert.ok((r.notes ?? []).some((n) => /paywall/i.test(n)), JSON.stringify(r.notes));
	} finally {
		restore();
	}
});

test("paywall: normal long page and 'sign in'-less short page are left untouched", async () => {
	sandboxHome();
	// long normal page — no mirror attempt
	safeConfig.lookup = async () => [{ address: "203.0.113.5", family: 4 }];
	let mirrorHits = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://archive.ph/")) mirrorHits++;
		return new Response(`<html><body>${"<p>Normal long article content. </p>".repeat(200)}</body></html>`, {
			status: 200,
			headers: { "content-type": "text/html" },
		});
	}) as typeof fetch;
	try {
		await smartFetch(new URL(`https://paywall-c.test/c?x=${Date.now()}`), opts);
		// short page WITHOUT the wall phrases — must not detour either
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.startsWith("https://archive.ph/")) mirrorHits++;
			return new Response("<html><body><p>sign in</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
		}) as typeof fetch;
		await smartFetch(new URL(`https://paywall-d.test/d?x=${Date.now()}`), opts);
		assert.equal(mirrorHits, 0, "mirror must not be attempted for non-paywalled pages");
	} finally {
		restore();
	}
});
