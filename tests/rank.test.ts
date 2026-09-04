import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPassages, scorePassages, topPassages } from "../lib/rank.ts";

const DOC = `# Guide

Intro paragraph about the subject matter at hand.

## Installation

The installation process copies files and registers the binary.

## Uninstallation

Removal wipes every trace of the tool from your disk.`;

test("splitPassages: blank-line splitting with heading tracking", () => {
	const ps = splitPassages(DOC);
	assert.ok(ps.length >= 3);
	assert.equal(ps[0].heading, "Guide");
	assert.equal(ps[1].heading, "Installation");
	assert.equal(ps[2].heading, "Uninstallation");
});

test("scorePassages: matching heading boosts the right passage to the top", () => {
	const ps = splitPassages(DOC);
	const scored = scorePassages(ps, "installation");
	scored.sort((a, b) => b.score - a.score);
	assert.equal(scored[0].p.heading, "Installation");
	assert.ok(scored[0].score > 0);
});

test("scorePassages: junk (URL soup) is penalized", () => {
	const clean = splitPassages("## T\n\nThe configuration guide explains every option in detail today.")[0];
	const junk = splitPassages("## T\n\nThe configuration guide https://a.com https://b.com https://c.com https://d.com explains options.")[0];
	const q = "configuration guide";
	const sClean = scorePassages([clean], q)[0].score;
	const sJunk = scorePassages([junk], q)[0].score;
	assert.ok(sJunk < sClean, `junk ${sJunk} should be < clean ${sClean}`);
});

test("topPassages: intro first (score 0), then scored in doc order", () => {
	const { picked } = topPassages(DOC, "installation", 6000, 200);
	assert.equal(picked[0].score, 0);
	assert.ok(picked[0].text.includes("Intro paragraph"));
	for (let i = 1; i < picked.length; i++) {
		assert.ok(picked[i].score > 0);
		const a = DOC.indexOf(picked[i - 1].text.slice(0, 30));
		const b = DOC.indexOf(picked[i].text.slice(0, 30));
		if (a >= 0 && b >= 0) assert.ok(a <= b, "document order preserved");
	}
});

test("topPassages: budget respected", () => {
	const long = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\nParagraph ${i} discussing topic ${i} with considerable detail and length.`).join("\n\n");
	const { picked } = topPassages(long, "topic 7 topic 23", 1200, 100);
	const total = picked.reduce((a, p) => a + p.text.length, 0);
	assert.ok(total <= 1200 + 200, `total ${total} over budget`);
});

test("topPassages: empty query returns the intro head", () => {
	const { picked, total } = topPassages(DOC, "", 800, 600);
	assert.equal(picked.length, 1);
	assert.ok(picked[0].text.length <= 800);
	assert.ok(total >= 3);
});

test("topPassages: exposes passages alias with scores (WP-1 contract)", () => {
	const { picked, passages } = topPassages(DOC, "installation", 6000, 200);
	assert.equal(passages.length, picked.length);
	assert.ok(passages.some((p) => p.score > 0));
});
