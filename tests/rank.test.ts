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

// ---------------------------------------------------------------- WP-07

import { tokenize, termFreq, type Passage } from "../lib/rank.ts";

test("tokenize: unicode letters stay whole (Größe)", () => {
	assert.deepEqual(tokenize("Die Größe der Datei"), ["die", "größe", "der", "datei"]);
});

test("tokenize: dotted identifiers emit the last segment", () => {
	assert.ok(tokenize("React.useEffect").includes("useeffect"));
	assert.ok(tokenize("x.y.z").includes("z"));
	// version-like tokens do not split
	assert.deepEqual(tokenize("v1.2.3"), ["v1.2.3"]);
});

test("tokenize: sentence-final dot does not glue the next word", () => {
	const toks = tokenize("Enable strip-types. Then run.");
	assert.ok(!toks.some((t) => t.includes("then") && t.includes("strip")), JSON.stringify(toks));
});

test("tokenize: CJK emits character bigrams", () => {
	assert.deepEqual(tokenize("日本語 設定"), ["日本", "本語", "設定"]);
});

test("termFreq: counts occurrences", () => {
	const tf = termFreq(tokenize("abort abort retry abort"));
	assert.equal(tf.get("abort"), 3);
});

test("scorePassages: tf discriminates repeat mentions", () => {
	const mk = (text: string): Passage => ({ text, heading: "", pos: 0, kind: "prose" });
	const one = mk("We abort the mission when the signal drops and the crew ejects safely out.");
	const four = mk("We abort early. Then abort again. Operators abort a third time, then abort once more today.");
	const scored = scorePassages([one, four], "abort");
	assert.ok(scored[1].score > scored[0].score, `${scored[1].score} should beat ${scored[0].score}`);
});

test("scorePassages: verbatim phrase outranks scattered tokens", () => {
	const mk = (text: string): Passage => ({ text, heading: "", pos: 0, kind: "prose" });
	const scattered = mk("The dependency list is an array. Clean the array of dependency entries now.");
	const verbatim = mk("Pass a dependency array to control when the effect re-runs its body.");
	const scored = scorePassages([scattered, verbatim], "dependency array");
	assert.ok(scored[1].score > scored[0].score, `${scored[1].score} should beat ${scored[0].score}`);
});

test("splitPassages: fenced code block stays whole, kind code, no # heading leak", () => {
	const doc = "## Enabling the flag\n\nPass the flag on the command line to start.\n\n```bash\n# install deps first\nnpm install\n\nnode index.ts\n```\n\nDone.";
	const ps = splitPassages(doc);
	const fence = ps.find((p) => p.text.startsWith("```bash"));
	assert.ok(fence, "fence passage exists");
	assert.equal(fence.kind, "code");
	assert.equal(fence.heading, "Enabling the flag");
	assert.ok(fence.text.endsWith("```"));
	assert.ok(!ps.some((p) => p.heading === "install deps first"), "no # heading inside fence");
	// the tiny 'npm install' body survives (exempt from MIN_PASSAGE)
	assert.ok(ps.some((p) => p.text.includes("npm install")));
});

test("splitPassages: unterminated fence at EOF is closed", () => {
	const ps = splitPassages("Prose intro that is long enough to be kept around.\n\n```js\nconst x = 1;");
	const fence = ps.find((p) => p.text.startsWith("```js"));
	assert.ok(fence);
	assert.equal((fence.text.match(/```/g) ?? []).length, 2);
});

test("splitPassages: oversized fence splits into re-wrapped chunks", () => {
	const body = Array.from({ length: 100 }, (_, i) => `line ${i} with some content to pad the length out nicely`).join("\n");
	const ps = splitPassages("```txt\n" + body + "\n```");
	const fences = ps.filter((p) => p.kind === "code");
	assert.ok(fences.length >= 2, `got ${fences.length}`);
	for (const f of fences) {
		assert.ok(f.text.startsWith("```txt"));
		assert.ok(f.text.endsWith("```"));
		assert.ok(f.text.length <= 1100, `chunk ${f.text.length}`);
		assert.equal((f.text.match(/```/g) ?? []).length, 2);
	}
});

test("topPassages: every picked fence passage has balanced backticks", () => {
	const doc = "```bash\nnpm install deps\n```\n\nProse about installing the dependencies here.\n\n```js\nuseEffect(fn, []);\n```";
	const { picked } = topPassages(doc, "npm install deps", 300, 60);
	for (const p of picked) {
		const n = (p.text.match(/```/g) ?? []).length;
		assert.equal(n % 2, 0, `unbalanced fences in ${JSON.stringify(p.text)}`);
	}
});
