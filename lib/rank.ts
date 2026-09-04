/**
 * Query-aware passage ranking — the keyless stand-in for Claude Code's
 * model-over-the-page pass. Splits extracted text into passages, scores
 * each against the query (BM25 + heading boost), returns the intro plus
 * top passages within a char budget, in original document order.
 * Zero dependencies, no model calls.
 */

const WORD_RE = /[a-z0-9_#+.-]+/g;

function stem(t: string): string {
	if (t.length > 4 && t.endsWith("ing")) return t.slice(0, -3);
	if (t.length > 3 && t.endsWith("ed")) return t.slice(0, -2);
	if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
	return t;
}

function tokenize(s: string): string[] {
	return (s.toLowerCase().match(WORD_RE) ?? []).map(stem).filter((t) => t.length > 0);
}

export interface Passage {
	text: string;
	/** nearest heading above this passage ("" if none) */
	heading: string;
	/** index in document order */
	pos: number;
}

const MIN_PASSAGE = 24;

/** Split extracted text into passages on blank lines, tracking the nearest heading. */
export function splitPassages(text: string): Passage[] {
	const passages: Passage[] = [];
	const lines = text.split("\n");
	let heading = "";
	let buf: string[] = [];
	for (const line of lines) {
		if (line.trim() === "") {
			push(buf.join("\n"));
			buf = [];
			continue;
		}
		const h = line.match(/^#{1,6}\s+(.{3,120})\s*$/);
		if (h) {
			push(buf.join("\n"));
			buf = [];
			heading = (h[1] ?? "").trim();
			continue;
		}
		buf.push(line);
	}
	push(buf.join("\n").trim());
	return passages;

	/** Long blobs (infoboxes, template junk, minified docs) split on sentence boundaries so scoring can discriminate. */
	function push(raw: string) {
		const t = raw.trim();
		if (t.length < MIN_PASSAGE) return;
		if (t.length <= 1200) {
			passages.push({ text: t, heading, pos: passages.length });
			return;
		}
		const sentences = t.match(/[^.!?\n]+[.!?]?\s*/g) ?? [t];
		let cur = "";
		for (const sen of sentences) {
			if (cur.length + sen.length > 900 && cur.length >= MIN_PASSAGE) {
				passages.push({ text: cur.trim(), heading, pos: passages.length });
				cur = sen;
			} else {
				cur += sen;
			}
		}
		if (cur.trim().length >= MIN_PASSAGE) passages.push({ text: cur.trim(), heading, pos: passages.length });
	}
}

/** Whether the query looks like it wants code (identifiers, signatures, errors). */
function queryCodeish(query: string): boolean {
	return /[(){}\[\];=.\\/>]|undefined|null|function|const|error|npm|import/i.test(query);
}

/**
 * BM25 (k1=1.5, b=0.75) of passages against query tokens.
 * ×1.5 if the passage's heading matches a query token;
 * ×1.2 if the passage is code-like and the query is code-ish.
 */
export function scorePassages(passages: Passage[], query: string): Array<{ p: Passage; score: number }> {
	const qTokens = [...new Set(tokenize(query))];
	if (qTokens.length === 0) return passages.map((p) => ({ p, score: 0 }));

	const tokenSets: Array<Set<string>> = passages.map((p) => new Set(tokenize(p.text)));
	const N = passages.length;
	const avgLen = passages.reduce((a, p) => a + p.text.length, 0) / Math.max(N, 1);
	const k1 = 1.5;
	const b = 0.75;
	const wantCode = queryCodeish(query);

	return passages.map((p, i) => {
		const tokens = tokenSets[i];
		const len = p.text.length;
		// junk penalty: template/URL soup — real prose has few of these per 100 chars
		const junk = (p.text.match(/\{\{|\}\}|\[\[|\]\]|https?:\/\//g) ?? []).length;
		const junkDensity = junk / Math.max(len / 100, 1);
		let score = 0;
		for (const q of qTokens) {
			if (!tokens.has(q)) continue;
			let dfq = 0;
			for (const ts of tokenSets) if (ts.has(q)) dfq++;
			const idf = Math.log(1 + (N - dfq + 0.5) / (dfq + 0.5));
			score += (idf * 1 * (k1 + 1)) / (1 + k1 * (1 - b + b * (len / avgLen)));
		}
		if (p.heading && qTokens.some((q) => p.heading.toLowerCase().includes(q))) score *= 1.5;
		if (wantCode && /```|\t|=>|function |const |def |class /.test(p.text)) score *= 1.2;
		if (junkDensity > 1) score *= 0.3;
		else if (junkDensity > 0.4) score *= 0.6;
		return { p, score };
	});
}

export interface PickedPassage {
	heading: string;
	text: string;
	score: number;
}

/**
 * Pick the passages worth showing for a query within a char budget:
 * document intro first, then top-scoring passages in original order.
 * `total` = passages in the full document (for the "N of M shown" footer).
 */
export function topPassages(
	text: string,
	query: string,
	budgetChars = 6000,
	introChars = 600,
): { picked: PickedPassage[]; total: number } {
	const all = splitPassages(text);
	if (all.length === 0) return { picked: [], total: 0 };
	if (!query.trim()) {
		return { picked: [{ heading: all[0].heading, text: text.slice(0, budgetChars), score: 0 }], total: all.length };
	}

	const scored = scorePassages(all, query);
	const intro = all[0];

	// top-scoring passages within budget
	const ranked = [...scored].sort((a, b) => b.score - a.score);
	const keep = new Map<number, PickedPassage>();
	let remaining = budgetChars;
	for (const { p, score } of ranked) {
		if (score <= 0 || remaining <= 0) break;
		const cost = Math.min(p.text.length, remaining);
		if (cost < 80 && p.text.length > cost) break;
		keep.set(p.pos, {
			heading: p.heading,
			text: p.text.length > cost ? `${p.text.slice(0, cost)}…` : p.text,
			score,
		});
		remaining -= cost + p.heading.length + 20;
	}
	// drop the intro from keep — we prepend it explicitly below
	keep.delete(0);
	const picked = [...keep.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, v]) => v);
	picked.unshift({ heading: intro.heading, text: intro.text.slice(0, introChars), score: 0 });
	return { picked, total: all.length };
}
