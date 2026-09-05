import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { safeConfig, resolveSafe, isPrivateAddress } from "../lib/safe.ts";
import { installFetchMocks, resetFetchMocks, uninstallFetchMocks, mockText, mockJson, fetchCalls } from "./helpers.ts";
import { smartFetch } from "../lib/fetcher.ts";

beforeEach(() => {
	installFetchMocks(); // clears routes + call log on re-install
	// deterministic lookup table; unknown hosts → ENOTFOUND-ish throw
	const table: Record<string, Array<{ address: string; family: number }>> = {
		"public.test": [{ address: "203.0.113.5", family: 4 }],
		"7f000001.nip.io": [{ address: "127.0.0.1", family: 4 }],
		"lvh.me": [{ address: "127.0.0.1", family: 4 }],
		"localtest.me": [{ address: "127.0.0.1", family: 4 }],
		"dual.test": [
			{ address: "203.0.113.6", family: 4 },
			{ address: "fd00::1", family: 6 },
		],
		"meta.internal.test": [{ address: "169.254.169.254", family: 4 }],
		"metadata.google.internal": [{ address: "169.254.169.254", family: 4 }],
	};
	safeConfig.lookup = async (host: string) => {
		const hit = table[host];
		if (hit) return hit;
		if (host === "missing.test") {
			const err = new Error(`lookup ${host}`);
			(err as NodeJS.ErrnoException).code = "ENOTFOUND";
			throw err;
		}
		// default: every other test host resolves public (fetch itself is mocked)
		return [{ address: "203.0.113.5", family: 4 }];
	};
});

// The 30-URL table from evidence/r1/ssrf.test.ts: everything that used to be
// ALLOWED must now reject; the public controls must resolve.
const MUST_BLOCK: Array<[string, string?]> = [
	["http://localhost/x"],
	["http://localhost./x"],
	["http://127.0.0.1/x"],
	["http://10.0.0.1/x"],
	["http://192.168.1.1/x"],
	["http://172.16.0.1/x"],
	["http://172.31.255.255/x"],
	["http://169.254.169.254/latest/meta-data/"],
	["http://0.0.0.0/x"],
	["http://[::1]/x"],
	["http://[::]/x"],
	["http://[fd00::1]/x"],
	["http://[fe80::1]/x"],
	["http://[::ffff:127.0.0.1]/x"],
	["http://[::ffff:7f00:1]/x"],
	["http://[::ffff:a9fe:a9fe]/x"], // ::ffff:169.254.169.254
	["http://[64:ff9b::7f00:1]/x"],
	["http://100.64.0.1/x"],
	["http://metadata.google.internal/x"],
	["http://7f000001.nip.io/secret"],
	["http://lvh.me/secret"],
	["http://localtest.me/secret"],
	["http://user:pass@public.test/x", "credentials in URL"],
	["ftp://public.test/", "protocol"],
	["file:///etc/passwd", "protocol"],
];
const MUST_ALLOW = ["https://example.com/", "http://8.8.8.8/", "http://172.32.0.1/", "http://[2606:4700::1111]/", "http://public.test/a"];

for (const [url, why] of MUST_BLOCK) {
	test(`blocked: ${url}`, async () => {
		await assert.rejects(resolveSafe(url), new RegExp(why ?? "Blocked host|Blocked URL"));
	});
}
for (const url of MUST_ALLOW) {
	test(`allowed: ${url}`, async () => {
		const u = await resolveSafe(url);
		assert.equal(u.href, url);
	});
}

test("isPrivateAddress: unparseable fails closed", () => {
	assert.equal(isPrivateAddress("not-an-ip"), true);
	assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("dual-homing (public + private A/AAAA) is blocked", async () => {
	await assert.rejects(resolveSafe("http://dual.test/"), /resolves to fd00::1/);
});

test("DNS failure produces a typed, non-retried error", async () => {
	await assert.rejects(resolveSafe("http://missing.test/"), /DNS lookup failed for missing.test \(ENOTFOUND\)/);
});

// --- redirect re-check through smartFetch (offline, mocked fetch) ---

test("redirect to a private address is blocked, exactly one request made", async () => {
	let calls = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		calls++;
		return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/admin" } });
	}) as typeof fetch;
	try {
		await assert.rejects(
			smartFetch("http://public.test/go", { maxChars: 200, noCache: true, waybackEnabled: false, jinaEnabled: false }),
			/Blocked host/,
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("relative redirect resolves against the current URL and is re-checked", async () => {
	const realFetch = globalThis.fetch;
	const hops: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		const u = String(input);
		hops.push(u);
		if (u.endsWith("/next")) return new Response("<html><body>fine</body></html>", { status: 200, headers: { "content-type": "text/html" } });
		return new Response(null, { status: 301, headers: { location: "/next" } });
	}) as typeof fetch;
	try {
		const r = await smartFetch("http://public.test/start", { maxChars: 2000, noCache: true, waybackEnabled: false, jinaEnabled: false });
		assert.equal(r.finalUrl, "http://public.test/next");
		assert.ok(r.notes?.some((n) => n.includes("redirected 1")));
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("cross-host redirect drops custom headers", async () => {
	const realFetch = globalThis.fetch;
	const seenHeaders: Array<Record<string, string>> = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const u = String(input);
		seenHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
		if (u === "http://public.test/auth") return new Response(null, { status: 302, headers: { location: "http://other.test/cdn" } });
		return new Response("ok", { status: 200, headers: { "content-type": "text/html" } });
	}) as typeof fetch;
	try {
		await smartFetch("http://public.test/auth", {
			maxChars: 1000,
			noCache: true,
			waybackEnabled: false,
			jinaEnabled: false,
			headers: { Authorization: "Bearer x" },
		});
		assert.equal(seenHeaders.length, 2);
		assert.equal(seenHeaders[0]!["authorization"], "Bearer x");
		assert.equal(seenHeaders[1]!["authorization"], undefined);
	} finally {
		globalThis.fetch = realFetch;
	}
});

// --- jina policy ---

test("JSON under 400 chars is NOT promoted to jina (before: source=jina)", async () => {
	mockJson("https://test.example/api-thin", { ok: true, count: 3 });
	const r = await smartFetch("https://test.example/api-thin", { maxChars: 500, noCache: true, waybackEnabled: false });
	assert.equal(r.source, "direct");
	assert.ok(r.text.includes('"ok": true'));
	assert.equal(fetchCalls().filter((u) => u.includes("r.jina.ai")).length, 0);
});

test("secret-looking query param + custom headers → jina skipped with reason", async () => {
	mockText("https://test.example/secure?token=SECRET", "tiny", "text/html");
	const r = await smartFetch("https://test.example/secure?token=SECRET", {
		maxChars: 500,
		noCache: true,
		waybackEnabled: false,
		headers: { Authorization: "Bearer x" },
	});
	assert.equal(r.source, "direct");
	assert.equal(fetchCalls().filter((u) => u.includes("r.jina.ai")).length, 0);
	// thin html + custom headers: the reason is recorded (custom headers fires first)
	assert.ok(r.notes?.some((n) => n.startsWith("jina skipped: ")), `notes: ${JSON.stringify(r.notes)}`);
});

test("plain text under 400 chars is not jina-promoted", async () => {
	mockText("https://test.example/plain.txt", "OK", "text/plain");
	const r = await smartFetch("https://test.example/plain.txt", { maxChars: 500, noCache: true, waybackEnabled: false });
	assert.equal(r.source, "direct");
	assert.equal(fetchCalls().filter((u) => u.includes("r.jina.ai")).length, 0);
});

test("thin HTML with no headers still promotes to jina (control)", async () => {
	mockText("https://test.example/thin", "<html><body>hi</body></html>", "text/html");
	// first call consumes the direct mock; jina request gets a mock too
	mockText("https://r.jina.ai/https://test.example/thin", "Markdown Content:\n\n# Real page\n\n" + "substantial rendered content. ".repeat(60), "text/plain");
	const r = await smartFetch("https://test.example/thin", { maxChars: 4000, noCache: true, waybackEnabled: false });
	assert.equal(r.source, "jina");
	assert.equal(fetchCalls().filter((u) => u.includes("r.jina.ai")).length, 1);
});

test("no_jina option disables the fallback entirely", async () => {
	mockText("https://test.example/nojina", "<html><body>hi</body></html>", "text/html");
	const r = await smartFetch("https://test.example/nojina", { maxChars: 500, noCache: true, waybackEnabled: false, jinaEnabled: false });
	assert.equal(r.source, "direct");
	assert.equal(fetchCalls().filter((u) => u.includes("r.jina.ai")).length, 0);
	assert.equal(r.notes?.some((n) => n.startsWith("jina skipped")), false); // disabled is not shown
});

// --- streaming cap ---

test("chunked oversized body is capped at MAX_BYTES with truncated=true", async () => {
	const realFetch = globalThis.fetch;
	const chunk = Buffer.alloc(64 * 1024, 0x61); // 64KB 'a's
	let pulled = 0;
	const stream = new ReadableStream({
		pull(controller) {
			pulled += chunk.length;
			controller.enqueue(chunk);
		},
	});
	globalThis.fetch = (async () =>
		new Response(stream, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
	try {
		const r = await smartFetch("http://public.test/flood", { maxChars: 2000, noCache: true, waybackEnabled: false, jinaEnabled: false });
		assert.equal(r.truncated, true);
		assert.ok(r.notes?.includes("body capped at 3MB"), `notes: ${JSON.stringify(r.notes)}`);
		assert.ok(pulled <= 3.2 * 1024 * 1024, `pulled ${pulled}`);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("binary content-type: not read (≤1 speculative chunk), metadata message with Content-Length", async () => {
	const realFetch = globalThis.fetch;
	let pulled = 0;
	const stream = new ReadableStream({
		pull(controller) {
			pulled += 1024;
			controller.enqueue(Buffer.alloc(1024));
		},
	});
	globalThis.fetch = (async () =>
		// NOTE: Response construction itself speculatively pulls ≤1 chunk under the
		// mocked fetch; the assertion below tolerates that artifact. What matters:
		// our reader never streams the body.
		new Response(stream, {
			status: 200,
			headers: { "content-type": "application/zip", "content-length": "12345678" },
		})) as typeof fetch;
	try {
		const r = await smartFetch("http://public.test/blob.bin", { maxChars: 2000, noCache: true, waybackEnabled: false, jinaEnabled: false });
		assert.ok(pulled <= 1024, `pulled ${pulled} — binary body was streamed`);
		assert.match(r.text, /\[binary content: application\/zip — Content-Length 12\.3MB, not downloaded\]/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

// --- wayback isolation ---

test("wayback: custom headers → no archive.org requests at all", async () => {
	mockText("https://test.example/locked", "denied", "text/html", 403);
	await smartFetch("https://test.example/locked", {
		maxChars: 300,
		noCache: true,
		headers: { Authorization: "x" },
	}).catch(() => {});
	assert.equal(fetchCalls().filter((u) => u.includes("archive.org")).length, 0);
});

test("wayback: snapshot request carries no Authorization", async () => {
	mockText("https://test.example/wb", "denied", "text/html", 403);
	const snapCalls: string[] = [];
	// availability API + snapshot via rawFetch (routed through our mock; HOME sandbox keeps cache out)
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const u = String(input);
		if (u.includes("archive.org/wayback/available")) {
			return new Response(JSON.stringify({ archived_snapshots: { closest: { url: "https://web.archive.org/web/2024/https://test.example/wb", timestamp: "20240101" } } }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (u.includes("web.archive.org")) {
			assert.equal(new Headers(init?.headers).get("authorization"), null); // snapshot never sees auth
			snapCalls.push(u);
		}
		return new Response("<html><body>archived copy</body></html>", { status: 200, headers: { "content-type": "text/html" } });
	}) as typeof fetch;
	try {
		const r = await smartFetch("https://test.example/wb", { maxChars: 1000, noCache: true, headers: { Authorization: "x" } });
		// wayback path requires headers unset — with headers set wayback bails, so run the assertion differently:
		assert.equal(r.source, "direct"); // headers set → wayback skipped entirely
		assert.equal(snapCalls.length, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("wayback without custom headers: availability call + snapshot, no Authorization anywhere", async () => {
	const urls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const u = String(input);
		urls.push(u);
		if (u.includes("archive.org/wayback/available")) {
			assert.equal(new Headers(init?.headers).get("authorization"), null);
			return new Response(JSON.stringify({ archived_snapshots: { closest: { url: "https://web.archive.org/web/2024/https://test.example/wb2", timestamp: "20240101" } } }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (u.includes("web.archive.org")) {
			assert.equal(new Headers(init?.headers).get("authorization"), null);
			return new Response("<html><body>archived copy</body></html>", { status: 200, headers: { "content-type": "text/html" } });
		}
		// direct target: 403 so the wayback fallback triggers
		assert.equal(u, "https://test.example/wb2");
		return new Response("denied", { status: 403, headers: { "content-type": "text/html" } });
	}) as typeof fetch;
	try {
		const r = await smartFetch("https://test.example/wb2", { maxChars: 1000, noCache: true });
		assert.equal(r.source, "wayback");
		assert.ok(urls.some((u) => u.includes("archive.org/wayback/available")));
	} finally {
		globalThis.fetch = realFetch;
	}
});
