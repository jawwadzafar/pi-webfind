/**
 * WP-01 regression fixtures — deep-mode excerpt selection.
 *
 * Bug (round-2 review #1): deep:true always showed the page intro because
 * (a) rank.ts unshifted the intro into `picked` with score 0 and the extension
 * took the first paragraph, and (b) the search cache key omitted `deep`, so a
 * deep rerun returned the cached non-deep result.
 *
 * Fix under test:
 *  - topPassages() now also returns `passages` (the picked set incl. scores)
 *  - the deep picker takes the top-scored passage (heading-prefixed), intro
 *    only as fallback — mirrored expression in extensions/web-search.ts
 *  - cache key carries :deep${deepN}
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topPassages } from "../lib/rank.ts";

const DOC = `# Postgres CREATE INDEX

CREATE INDEX builds a B-tree index on one or more columns.

## CONCURRENTLY

When CREATE INDEX is run with the CONCURRENTLY option, PostgreSQL builds the
index without taking a lock that blocks writes. This matters in production:
plain CREATE INDEX blocks all INSERTs and UPDATEs for the duration of the
build, which on a large table can be minutes to hours.

## Invalid indexes

If the build fails midway the index is left INVALID and must be dropped.`;

test("topPassages: intro stays first in picked (smartFetch contract unchanged)", () => {
	const { picked, total } = topPassages(DOC, "create index concurrently blocking writes", 6000, 600);
	assert.equal(picked[0].score, 0);
	assert.ok(picked[0].text.includes("B-tree index"));
	assert.equal(total, 3);
});

test("topPassages: passages alias exposes scores so deep mode can re-rank", () => {
	const { picked, passages } = topPassages(DOC, "create index concurrently blocking writes", 6000, 600);
	assert.ok(Array.isArray(passages));
	assert.equal(passages.length, picked.length);
	const best = passages.filter((p) => p.score > 0).sort((a, b) => b.score - a.score)[0];
	assert.ok(best, "at least one passage scores above zero");
	assert.equal(best.heading, "CONCURRENTLY");
	assert.ok(best.text.includes("without taking a lock"));
	assert.notEqual(best.text, picked[0].text);
});

test("deep picker: best-scored passage wins over intro (mirror of web-search.ts)", () => {
	const { passages } = topPassages(DOC, "create index concurrently blocking writes", 6000, 600);
	// same expression as extensions/web-search.ts deep block
	const best = passages.filter((p) => p.score > 0).sort((a, b) => b.score - a.score)[0];
	const first = best ? (best.heading ? `${best.heading}\n${best.text}` : best.text) : null;
	assert.ok(first);
	assert.ok(first.includes("CONCURRENTLY"));
	assert.ok(!first.startsWith("CREATE INDEX builds a B-tree"));
});

test("deep picker fallback: query with zero scoring passages falls back to intro", () => {
	const { passages, picked } = topPassages(DOC, "zzzqqq unrelated xyzzy", 6000, 600);
	const best = passages.filter((p) => p.score > 0).sort((a, b) => b.score - a.score)[0];
	assert.equal(best, undefined);
	// fallback path in web-search.ts uses picked[0] (the intro)
	assert.ok(picked[0].text.length > 0);
});

test("no-query call still works and exposes passages", () => {
	const { picked, passages, total } = topPassages(DOC, "", 6000, 600);
	assert.equal(picked.length, 1);
	assert.equal(passages.length, 1);
	assert.ok(total >= 1);
});

// ---- source tripwires: the two silent-regression risks --------------------

test("tripwire: search cache key includes the deep factor", () => {
	const src = readFileSync(new URL("../extensions/web-search.ts", import.meta.url), "utf8");
	assert.match(src, /cacheKey = `s:\$\{engine\}[^`]*:deep\$\{deepN\}`/);
});

test("tripwire: deep block prefers page.passages over the first-paragraph hack", () => {
	const src = readFileSync(new URL("../extensions/web-search.ts", import.meta.url), "utf8");
	const deepBlock = src.slice(src.indexOf("deep mode: read top results"), src.indexOf("if (results.length > 0) cacheSet"));
	assert.match(deepBlock, /page\.passages/);
	assert.match(deepBlock, /p\.score > 0/);
	assert.match(deepBlock, /sort\(\(a, b\) => b\.score - a\.score\)/);
});

test("tripwire: smartFetch attaches passages to FetchResult", () => {
	const src = readFileSync(new URL("../lib/fetcher.ts", import.meta.url), "utf8");
	assert.match(src, /passages\?: PickedPassage\[\]/);
	assert.match(src, /text: body \+ footer, truncated, totalChars, .*passages \}/);
});
