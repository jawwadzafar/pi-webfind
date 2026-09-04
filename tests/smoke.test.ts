import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMocks, uninstallFetchMocks, mockText, mockJson, fetchCalls } from "./helpers.ts";
import { smartFetch } from "../lib/fetcher.ts";

beforeEach(() => {
	installFetchMocks();
});

const ARTICLE =
	"<html><head><title>Test Page</title></head><body><h1>Hello</h1>" +
	`<p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ".repeat(6)}</p>` +
	`<p>Among these words appears the rare term concertina exactly once, surrounded by ordinary prose for context.</p>` +
	`<p>${"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat."}</p>` +
	"</body></html>";

test("smartFetch: query view returns relevant passages with scores", async () => {
	mockText("https://test.example/page", ARTICLE);
	const r = await smartFetch("https://test.example/page", { maxChars: 3000, query: "concertina rare term" });
	assert.equal(r.source, "direct");
	assert.equal(r.status, 200);
	assert.ok(r.text.includes("concertina"));
	assert.ok(Array.isArray(r.passages));
	assert.ok(r.passages.some((p) => p.score > 0));
});

test("smartFetch: head view without query", async () => {
	mockText("https://test.example/head", ARTICLE);
	const r = await smartFetch("https://test.example/head", { maxChars: 2000 });
	assert.ok(r.text.includes("Hello"));
	assert.equal(r.passages, undefined); // no query → no passages attached
});

test("smartFetch: second identical call is served from cache", async () => {
	mockText("https://test.example/cached", ARTICLE);
	const before = fetchCalls().length;
	await smartFetch("https://test.example/cached", { maxChars: 2000 });
	const mid = fetchCalls().length;
	assert.ok(mid > before);
	const r2 = await smartFetch("https://test.example/cached", { maxChars: 2000 });
	assert.equal(r2.fromCache, true);
	assert.equal(fetchCalls().length, mid);
});

test("smartFetch: JSON is pretty-printed", async () => {
	mockJson("https://test.example/api", { ok: true, count: 3 });
	const r = await smartFetch("https://test.example/api", { maxChars: 2000 });
	assert.ok(r.text.includes('"ok": true'));
	assert.ok(r.text.includes('"count": 3'));
});

test("smartFetch: binary content-type returns metadata, not garbage", async () => {
	mockText("https://test.example/blob.bin", "PK-null-bytes", "application/zip");
	const r = await smartFetch("https://test.example/blob.bin", { maxChars: 2000 });
	assert.match(r.text, /\[binary content: application\/zip/);
});

test("smartFetch: 403 with wayback disabled rejects (retries then throws)", async () => {
	mockText("https://test.example/locked", "go away", "text/html", 403);
	await assert.rejects(smartFetch("https://test.example/locked", { maxChars: 500, waybackEnabled: false }), /HTTP 403/);
	const direct = fetchCalls().filter((u) => u.startsWith("https://test.example/locked"));
	assert.ok(direct.length >= 3, `expected >=3 direct attempts, got ${direct.length}`); // current retry policy (WP-05 tightens)
});

test("smartFetch: allowHttpErrors returns the error body instead of throwing", async () => {
	mockText("https://test.example/404", "not here", "text/html", 404);
	const r = await smartFetch("https://test.example/404", { maxChars: 500, allowHttpErrors: true });
	assert.equal(r.status, 404);
	assert.ok(r.text.includes("not here"));
});
