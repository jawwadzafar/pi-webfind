/**
 * WP-04 regression fixtures — search pipeline: parse fixtures, relevance gate,
 * normalizeUrl dedupe, RRF fusion.
 *
 * Fixtures are real captures: tests/fixtures/ddg-jina.md is a live r.jina.ai
 * relay of a DDG html query; tests/fixtures/search-r3.json holds the round-2
 * review's R3 query buckets captured per engine (q1 = "postgres create index
 * concurrently documentation", q3 = "postgres vacuum tuning").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fuse,
	multiSearch,
	normalizeUrl,
	parseDdgHtml,
	parseJinaDdg,
	relevanceGate,
	type SearchResult,
} from "../lib/engine.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// ---------------------------------------------------------- parse fixtures

test("parseJinaDdg: recovers snippets from the second same-URL link (8/8 rows)", () => {
	const md = readFileSync(join(FIX, "ddg-jina.md"), "utf8");
	const rows = parseJinaDdg(md);
	assert.ok(rows.length >= 8, `got ${rows.length}`);
	const withSnippet = rows.filter((r) => r.snippet.length > 0);
	assert.equal(withSnippet.length, rows.length, "every row gets real snippet prose");
	// the bare domain echo line (favicon-adjacent link) must not become a snippet
	for (const r of rows) {
		assert.ok(!/^(?:[a-z0-9-]+\.)+[a-z]{2,6}(?:\/\S*)?$/i.test(r.snippet), `url echo as snippet: ${r.snippet}`);
	}
	// titles and target URLs decode through the uddg param
	assert.ok(rows.some((r) => r.url === "https://www.postgresql.org/docs/current/runtime-config-vacuum.html"));
	assert.ok(rows[0].title.length > 10);
});

test("parseDdgHtml: challenge markup throws 'ddg challenge' instead of 0 rows", () => {
	const challenge = `<html><body><div class="anomaly-modal">unusual traffic</div><div class="g-recaptcha"></div></body></html>`;
	assert.throws(() => parseDdgHtml(challenge), /ddg challenge/);
	// normal page parses
	const page = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Title A</a>
<a class="result__snippet" href="">snippet text here</a>`;
	const rows = parseDdgHtml(page);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].url, "https://example.com/a");
	assert.equal(rows[0].snippet, "snippet text here");
});

test("searchRace: 202-challenge HTML body throws structured error, lite/POST skipped", async () => {
	// regression for the WP-04 offline challenge path: get() passes 202 HTML
	// bodies (DDG's anomaly wall) to the parser, ddgDirect rethrows the
	// structured error, searchRace skips the brave leg (challenged)
	const { installFetchMocks, mockText, uninstallFetchMocks, fetchCalls } = await import("./helpers.ts");
	installFetchMocks();
	try {
		mockText("https://html.duckduckgo.com/html/?q=ddg+challenge", `<html><div class="anomaly-modal"></div></html>`, "text/html", 202);
		const { searchRace } = await import("../lib/engine.ts");
		const r = await searchRace("ddg challenge", 5, undefined);
		assert.ok(r.errors.some((e) => e.startsWith("ddg: ddg challenge")), r.errors.join(" | "));
		// lite + POST + brave are all skipped: html GET, bing, jina relay only
		assert.ok(!fetchCalls().some((u) => u.includes("lite.duckduckgo")), "lite fetched despite challenge");
		assert.ok(!fetchCalls().some((u) => u.includes("search.brave.com")), "brave fetched despite challenge");
	} finally {
		uninstallFetchMocks();
	}
});

// ---------------------------------------------------------- relevance gate

test("relevanceGate: off-topic bucket collapses (R3 q1_bing 8 -> 0)", () => {
	const buckets = JSON.parse(readFileSync(join(FIX, "search-r3.json"), "utf8"));
	const rows: SearchResult[] = buckets.q1_bing.results;
	const kept = relevanceGate(buckets.q1_bing.query, rows);
	assert.equal(kept.length, 0, `expected 0, got ${kept.length}: ${kept.map((r) => r.url).join(", ")}`);
});

test("relevanceGate: on-topic bucket survives intact (q1_ddg 8 -> 8, q3_ddg 8 -> 8)", () => {
	const buckets = JSON.parse(readFileSync(join(FIX, "search-r3.json"), "utf8"));
	for (const key of ["q1_ddg", "q3_ddg"] as const) {
		const rows: SearchResult[] = buckets[key].results;
		const kept = relevanceGate(buckets[key].query, rows);
		assert.ok(kept.length >= 6, `${key}: kept ${kept.length}, want >= 6 of ${rows.length}`);
	}
});

test("relevanceGate: CJK query passes everything through (tokenizer yields bigrams)", () => {
	const rows: SearchResult[] = [
		{ title: "Node.js 入門", url: "https://example.com/a", snippet: "非同期処理の説明", engine: "ddg" },
		{ title: "Unrelated", url: "https://example.com/b", snippet: "nothing here", engine: "ddg" },
	];
	const kept = relevanceGate("非同期 イベント", rows);
	assert.equal(kept.length, 2, "non-Latin queries never drop rows");
});

test("relevanceGate: short/no-token queries pass through", () => {
	const rows: SearchResult[] = [{ title: "x", url: "https://e.com", snippet: "", engine: "ddg" }];
	assert.equal(relevanceGate("vs", rows).length, 1);
});

// ------------------------------------------------------------ normalizeUrl

test("normalizeUrl: all 11 dedupe.ts pairs merge", () => {
	const PAIRS: Array<[string, string]> = [
		["https://example.com/a", "https://example.com/a/"],
		["https://example.com/a", "https://www.example.com/a"],
		["https://example.com/a", "https://m.example.com/a"],
		["https://example.com/a", "https://amp.example.com/a"],
		["https://example.com/a", "https://example.com/amp/a"],
		["https://example.com/a?utm_source=x&utm_medium=y&id=1", "https://example.com/a?id=1"],
		["https://example.com/a?fbclid=123", "https://example.com/a"],
		["https://example.com/index.html", "https://example.com"],
		["http://example.com/a", "https://example.com/a"],
		["https://example.com/#!/a", "https://example.com/a"],
		["https://example.com/a?gclid=abc", "https://example.com/a"],
	];
	for (const [a, b] of PAIRS) {
		assert.equal(normalizeUrl(a), normalizeUrl(b), `${a} vs ${b}`);
	}
});

test("normalizeUrl: distinct URLs stay distinct", () => {
	assert.notEqual(normalizeUrl("https://example.com/a"), normalizeUrl("https://example.com/b"));
	assert.notEqual(normalizeUrl("https://example.com/a?page=1"), normalizeUrl("https://example.com/a?page=2"));
});

// -------------------------------------------------------------------- fuse

test("relevanceGate: prunes generic pg rows from the bing bucket (downloads, wikipedia, enterprisedb)", () => {
	const buckets = JSON.parse(readFileSync(join(FIX, "search-r3.json"), "utf8"));
	const rows: SearchResult[] = buckets.q3_bing.results;
	const kept = relevanceGate(buckets.q3_bing.query, rows);
	const urls = kept.map((r) => r.url);
	assert.ok(!urls.some((u) => u.includes("/download")), "downloads row kept");
	assert.ok(!urls.some((u) => u.includes("wikipedia")), "wikipedia row kept");
	assert.ok(!urls.some((u) => u.includes("enterprisedb")), "enterprisedb row kept");
	assert.ok(kept.length < rows.length, `gate did nothing: ${kept.length}/${rows.length}`);
});

test("fuse: merges rows sharing a normalized URL, keeps longest snippet, unions engines", () => {
	const mk = (engine: string, url: string, title: string, snippet: string): SearchResult =>
		({ title, url, snippet, engine } as SearchResult);
	const results = fuse(
		[
			{
				name: "ddg",
				rows: [
					mk("ddg", "https://www.postgresql.org/docs/current/sql-createindex.html", "PostgreSQL: Documentation: 18: CREATE INDEX", "short ddg snippet"),
					mk("ddg", "https://example.com/only-ddg", "Only on ddg", "ddg only row"),
				],
			},
			{
				name: "bing",
				rows: [
					mk("bing", "https://postgresql.org/docs/current/sql-createindex.html?utm_source=rss", "CREATE INDEX - PostgreSQL Documentation", "a much longer bing snippet that should win the field merge because it is longest"),
				],
			},
		],
		8,
	);
	assert.equal(results.length, 2);
	const merged = results.find((r) => r.url.includes("sql-createindex"))!;
	assert.deepEqual(merged.engines, ["ddg", "bing"]);
	assert.ok(merged.snippet.startsWith("a much longer bing snippet"), merged.snippet);
	assert.equal(merged.title, "CREATE INDEX - PostgreSQL Documentation");
	// ddg-weighted (1.0) row outranks the bing-only (0.5) row
	assert.ok(results[0].url.includes("sql-createindex"));
});
