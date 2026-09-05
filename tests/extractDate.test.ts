import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDate } from "../lib/extract.ts";

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

test("extractDate: article:published_time wins", () => {
	const html = `<html><head><meta property="article:published_time" content="2026-03-15T09:30:00Z"><script type="application/ld+json">{"datePublished":"2025-01-01"}</script></head></html>`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2026, 3, 15));
});

test("extractDate: og:updated_time when no article meta", () => {
	const html = `<meta property="og:updated_time" content="2026-02-01T00:00:00Z">`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2026, 2, 1));
});

test("extractDate: JSON-LD top-level object", () => {
	const html = `<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-01-05T10:00:00+00:00"}</script>`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2026, 1, 5));
});

test("extractDate: JSON-LD @graph array", () => {
	const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Article","datePublished":"2025-12-24"}]}</script>`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2025, 12, 24));
});

test("extractDate: JSON-LD array of nodes", () => {
	const html = `<script type="application/ld+json">[{"dateModified":"2025-11-02"}]</script>`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2025, 11, 2));
});

test("extractDate: bare <time datetime>", () => {
	const html = `<article><time datetime="2026-04-18T08:00:00Z">April 18, 2026</time></article>`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2026, 4, 18));
});

test("extractDate: dc.date / pubdate metas", () => {
	assert.equal(extractDate(`<meta name="dc.date" content="2025-06-30">`, "https://x.com/a"), iso(2025, 6, 30));
	assert.equal(extractDate(`<meta name="pubdate" content="2025-06-30">`, "https://x.com/a"), iso(2025, 6, 30));
});

test("extractDate: dated URL path fallback", () => {
	assert.equal(extractDate("<html></html>", "https://blog.x.com/2026/08/10/hello-world"), iso(2026, 8, 10));
	assert.equal(extractDate("<html></html>", "https://blog.x.com/2026/08/hello-world"), undefined);
});

test("extractDate: no date anywhere", () => {
	assert.equal(extractDate("<html><body>nothing here</body></html>", "https://x.com/page"), undefined);
});

test("extractDate: malformed JSON-LD ignored, falls through", () => {
	const html = `<script type="application/ld+json">{broken</script><time datetime="2026-01-02">x</time>`;
	assert.equal(extractDate(html, "https://x.com/a"), iso(2026, 1, 2));
});

test("extractDate: citation_date meta (arxiv/journals)", () => {
	assert.equal(extractDate(`<meta name="citation_date" content="2025/05/12">`, "https://x.com/a"), iso(2025, 5, 12));
});

test("extractDate: plain-text 'Submitted on 12 Jun 2017' stamp", () => {
	const html = `<td class="dateline">[Submitted on 12 Jun 2017 (v1)]</td>`;
	assert.equal(extractDate(html, "https://arxiv.org/abs/1706.03762"), iso(2017, 6, 12));
});

test("extractDate: plain-text 'Published March 3, 2025'", () => {
	assert.equal(extractDate(`<div>Published March 3, 2025</div>`, "https://x.com/a"), iso(2025, 3, 3));
});

test("extractDate: bare header stamp 'Apr 24, 2024' in first 3000 chars", () => {
	const head = `<html><head><title>x</title></head><body><span>Apr 24, 2024</span>`.padEnd(120, " ") + `</body></html>`;
	assert.equal(extractDate(head, "https://nodejs.org/en/blog/announcements/v22-release-announce"), iso(2024, 4, 24));
});

test("extractDate: body-date beyond 3000 chars ignored (URL path wins instead)", () => {
	const body = "<p>filler</p>".repeat(400) + `<span>Apr 24, 2024</span>`;
	assert.equal(extractDate(body, "https://x.com/2026/01/02/post"), iso(2026, 1, 2));
});

test("extractDate: dt/dd 'Last Updated' metadata element", () => {
	const html = `<dl><dt>Last Updated</dt><dd>Apr 24, 2024</dd></dl>`;
	assert.equal(extractDate(html, "https://nodejs.org/en/blog/x"), iso(2024, 4, 24));
});
