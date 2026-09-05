/**
 * HTML → markdown extractor with density-scored article detection.
 *
 * Stage 1: score candidate blocks by text/link density (Readability-lite),
 * subtracting text inside junk-classed subtrees (comments, sidebars, navs)
 * so a container holding article + comments does not beat the article alone.
 * Docs-site profiles (PostgreSQL, Docusaurus, MDN, react.dev, Nextra) hint
 * the content root and fall back to density scoring when they miss.
 * Stage 2: convert the chosen block to markdown — headings, links, code
 * fences, lists, tables survive so the model can read structure.
 *
 * Falls back to the simple flattener (lib/engine.ts htmlToText) when the
 * output looks like junk. Zero dependencies.
 */

import { decodeEntities } from "./engine.ts";

interface Node {
	tag: string; // lowercase; "#text" for text, "#root" for root
	attrs: Record<string, string>;
	children: Node[];
	text?: string;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DROP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "form", "select", "button", "nav", "aside", "link", "meta", "base", "area", "track", "param", "annotation", "semantics"]);
// tags whose open implies closing an open <p> above (through inline wrappers)
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);
// elements that participate in inline formatting — p-close scans down through these only
const INLINE = new Set(["a", "b", "i", "em", "strong", "span", "code", "small", "sub", "sup", "u", "s", "mark", "abbr", "time", "cite", "q", "kbd", "label", "img", "br", "wbr"]);
// sibling auto-close: opening X closes an open Y above the nearest Z
const SIBLING: Record<string, { closes: string[]; within: string[] }> = {
	li: { closes: ["li"], within: ["ul", "ol", "menu"] },
	dt: { closes: ["dt", "dd"], within: ["dl"] },
	dd: { closes: ["dt", "dd"], within: ["dl"] },
	td: { closes: ["td", "th"], within: ["tr"] },
	th: { closes: ["td", "th"], within: ["tr"] },
	tr: { closes: ["tr"], within: ["table", "tbody", "thead", "tfoot"] },
	tbody: { closes: ["tbody", "thead", "tfoot"], within: ["table"] },
	thead: { closes: ["tbody", "thead", "tfoot"], within: ["table"] },
	tfoot: { closes: ["tbody", "thead", "tfoot"], within: ["table"] },
};
// block-level tags used by the whitespace-collapsing policy when rendering children
const BLOCK = new Set(["p", "div", "section", "article", "main", "ul", "ol", "li", "table", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "header", "footer", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "address", "fieldset"]);
// block containers that get blank-line separators between siblings when rendered
const SEP = new Set(["div", "section", "article", "main", "li", "dd", "dt", "figure", "figcaption", "details", "summary", "dl", "address", "fieldset"]);

/** HTML5-ish implicit close: unclosed <p>, <li>, <td>, <tr>, ... before a new block/row starts. */
function implicitClose(stack: Node[], tag: string): void {
	const sib = SIBLING[tag];
	if (sib) {
		for (let s = stack.length - 1; s > 0; s--) {
			const t = stack[s].tag;
			if (sib.closes.includes(t)) {
				stack.length = s;
				break;
			}
			if (sib.within.includes(t)) break;
		}
	}
	if (CLOSES_P.has(tag)) {
		for (let s = stack.length - 1; s > 0; s--) {
			const t = stack[s].tag;
			if (t === "p") {
				stack.length = s;
				break;
			}
			if (!INLINE.has(t)) break;
		}
	}
}

/** Index just past the matching close tag of a dropped element (depth-counted for nesting). */
function skipDropped(html: string, tagName: string, gt: number): number {
	const re = new RegExp(`<(/)${tagName}\\b[^>]*>`, "gi");
	re.lastIndex = gt;
	let depth = 1;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		depth += m[1] ? -1 : 1;
		if (depth === 0) return m.index + m[0].length;
	}
	return html.length;
}

/** Tolerant HTML parser → shallow node tree. Never throws. */
export function parseHtml(html: string): Node {
	const root: Node = { tag: "#root", attrs: {}, children: [] };
	const stack: Node[] = [root];
	let preDepth = 0;
	let i = 0;
	const len = html.length;
	while (i < len) {
		const lt = html.indexOf("<", i);
		if (lt === -1) break;
		// text before this tag — kept even when whitespace-only (token spans, inline gaps);
		// collapsing to one space happens at render time
		if (lt > i) {
			const t = html.slice(i, lt);
			if (t.length) stack[stack.length - 1].children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(t) });
		}
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt);
			i = end === -1 ? len : end + 3;
			continue;
		}
		if (html[lt + 1] === "/") {
			const gt = html.indexOf(">", lt);
			const tag = html.slice(lt + 2, gt === -1 ? len : gt).trim().toLowerCase();
			if (tag === "pre") preDepth = Math.max(0, preDepth - 1);
			for (let s = stack.length - 1; s > 0; s--) {
				if (stack[s].tag === tag) {
					stack.length = s;
					break;
				}
			}
			i = gt === -1 ? len : gt + 1;
			continue;
		}
		if (html[lt + 1] === "!" || html[lt + 1] === "?") {
			const gt = html.indexOf(">", lt);
			i = gt === -1 ? len : gt + 1;
			continue;
		}
		const gt = html.indexOf(">", lt);
		if (gt === -1) break;
		const tagSrc = html.slice(lt + 1, gt);
		const tagName = (tagSrc.match(/^[a-zA-Z][a-zA-Z0-9-]*/) ?? [""])[0].toLowerCase();
		if (!tagName) {
			i = gt + 1;
			continue;
		}
		// dropped elements never enter the tree (and never reach content statistics);
		// void members and self-closing forms just skip the tag itself
		if (DROP_TAGS.has(tagName)) {
			const selfClosed = /\/\s*$/.test(tagSrc);
			i = VOID_TAGS.has(tagName) || selfClosed ? gt + 1 : skipDropped(html, tagName, gt);
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const m of tagSrc.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))|(?=[\s\/]|$))/g)) {
			attrs[m[1].toLowerCase()] = m[2] === undefined ? "" : decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
		}
		// hidden subtrees never enter the tree — display:none blocks (search overlays,
		// dropdown panels, hidden dialogs) are not part of the readable page
		if (attrs.hidden !== undefined || /display:\s*none/.test(attrs.style ?? "")) {
			const selfClosed = /\/\s*$/.test(tagSrc) || VOID_TAGS.has(tagName);
			i = selfClosed ? gt + 1 : skipDropped(html, tagName, gt);
			continue;
		}
		// MediaWiki Parsoid annotation wrappers: drop the element AND its content.
		// Covers mw:Transclusion/mw:Param and extension content like mw:Extension/math
		// (the <math> markup lives inside those wrappers on Parsoid pages).
		if (/mw:Transclusion|mw:Param|mw:Extension/.test(attrs["typeof"] ?? "")) {
			const close = new RegExp(`</${tagName}\\s*>`, "i").exec(html.slice(gt));
			i = close ? gt + close.index + close[0].length : len;
			continue;
		}
		implicitClose(stack, tagName);
		const node: Node = { tag: tagName, attrs, children: [] };
		stack[stack.length - 1].children.push(node);
		// `<a href=/>` is an unquoted value, not self-closing; `<br/>`, `<img src="x"/>`, `<div />` are
		const selfClosing = /(^[a-zA-Z][a-zA-Z0-9-]*|["'\s])\/$/.test(tagSrc) || VOID_TAGS.has(tagName);
		if (tagName === "pre" && !selfClosing) preDepth++;
		if (!selfClosing) stack.push(node);
		i = gt + 1;
	}
	// trailing text — verbatim inside pre, otherwise only when non-whitespace
	if (i < len) {
		const t = html.slice(i);
		if (preDepth > 0 || /\S/.test(t)) {
			stack[stack.length - 1].children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(t) });
		}
	}
	return root;
}

// ------------------------------------------------------------------ stats

interface NodeStats {
	/** collapsed visible text length of the subtree */
	text: number;
	/** portion of that text which sits inside <a> */
	link: number;
	/** text inside BAD_CLASS / footer subtrees (subtracted from text when scoring) */
	bad: number;
	p: number;
	li: number;
	pre: number;
	/** raw (uncollapsed) text length — proxy for subtree size in the innermost rule */
	raw: number;
}

/** One bottom-up pass: per-node text/link/bad lengths + p/li/pre counts. */
function statsOf(root: Node): Map<Node, NodeStats> {
	const map = new Map<Node, NodeStats>();
	const walk = (node: Node, inBad: boolean): NodeStats => {
		const st: NodeStats = { text: 0, link: 0, bad: 0, p: 0, li: 0, pre: 0, raw: 0 };
		if (node.tag === "#text") {
			const t = node.text ?? "";
			st.raw = t.length;
			const n = t.replace(/\s+/g, " ").trim().length;
			st.text = n;
			if (inBad) st.bad = n;
		} else {
			const cls = `${node.attrs.id ?? ""} ${node.attrs.class ?? ""}`.toLowerCase();
			const selfBad = inBad || node.tag === "footer" || BAD_CLASS.test(cls);
			for (const c of node.children) {
				const cs = walk(c, selfBad);
				st.text += cs.text;
				st.link += cs.link;
				st.bad += cs.bad;
				st.p += cs.p;
				st.li += cs.li;
				st.pre += cs.pre;
				st.raw += cs.raw;
				if (c.tag === "a") st.link += cs.text;
				else if (c.tag === "p") st.p += 1;
				else if (c.tag === "li") st.li += 1;
				else if (c.tag === "pre") st.pre += 1;
			}
			if (selfBad) {
				st.bad = st.text;
				// junk subtrees contribute no structure bonuses either — otherwise a
				// container wrapping article + N comments still beats the article alone
				st.p = 0;
				st.li = 0;
				st.pre = 0;
			}
		}
		map.set(node, st);
		return st;
	};
	walk(root, false);
	return map;
}

function rawText(node: Node): string {
	let s = node.text ?? "";
	for (const c of node.children) s += rawText(c);
	return s;
}

const GOOD_CLASS = /content|article|post|entry|body|main|markdown|docs/i;
// bare "menu" only when it reads as a menu container — NOT when embedded in
// feature-flag classes like "vector-feature-main-menu-pref-enabled" (which would
// mark the whole <html> subtree bad on Vector 2022 skins)
const BAD_CLASS = /comment|sidebar|footer|nav|related|share|promo|advert|ads?-|cookie|banner|social|newsletter|widget|mw-portlet|vector-menu|(^|[-_])menu(s)?($|[-_](item|container|list|bar|wrapper|toggle))/i;

/** Pick the best content container (Readability-lite scoring). */
function pickBest(root: Node): Node {
	const stats = statsOf(root);
	const candidates: Array<{ node: Node; score: number; eff: number; size: number }> = [];
	const walk = (node: Node, depth: number) => {
		if (node.tag === "#text" || depth > 25) return;
		const st = stats.get(node);
		if (st) {
			const eff = st.text - st.bad;
			if (eff > 200) {
				const linkDensity = st.link / Math.max(st.text, 1);
				const cls = `${node.attrs.id ?? ""} ${node.attrs.class ?? ""}`.toLowerCase();
				let score = eff * (1 - linkDensity) + 25 * (st.p + st.li + st.pre);
				if (/^(article|main)$/.test(node.tag)) score *= 1.5;
				if (GOOD_CLASS.test(cls)) score *= 1.25;
				if (BAD_CLASS.test(cls)) score *= 0.4;
				if (linkDensity > 0.6) score *= 0.3;
				// MediaWiki parser output is a known content island — skip generic shells
				if (node.attrs.class?.includes("mw-parser-output")) score *= 4;
				candidates.push({ node, score, eff, size: st.raw });
			}
		}
		for (const c of node.children) if (c.tag !== "#text") walk(c, depth + 1);
	};
	walk(root, 0);
	if (candidates.length === 0) return root;
	let best = candidates[0];
	for (const c of candidates) if (c.score > best.score) best = c;
	// innermost candidate scoring near the best AND holding ≥ 90 % of its effective
	// text — trims shells (comments under main) without dropping header/lede siblings
	const nearBest = candidates.filter((c) => c.score >= best.score * 0.8 && c.eff >= best.eff * 0.9);
	if (nearBest.length === 0) return best.node;
	return nearBest.reduce((a, b) => (b.size < a.size ? b : a)).node;
}

// ------------------------------------------------------- docs-site profiles

interface Profile {
	match: (url: URL | null, root: Node) => boolean;
	root: (root: Node) => Node | null;
}
const hasGenerator = (root: Node, re: RegExp) =>
	!!findFirst(root, (n) => n.tag === "meta" && (n.attrs.name ?? "") === "generator" && re.test(n.attrs.content ?? ""));
const byId =
	(id: string) =>
	(root: Node): Node | null =>
		findFirst(root, (n) => (n.attrs.id ?? "") === id);
const byClass =
	(cls: string) =>
	(root: Node): Node | null =>
		findFirst(root, (n) => (n.attrs.class ?? "").split(/\s+/).includes(cls));

/** Hints for known docs hosts — a hint that misses falls back to density scoring. */
const PROFILES: Profile[] = [
	{ match: (u) => !!u && /(^|\.)postgresql\.org$/.test(u.hostname), root: byId("docContent") },
	{ match: (_u, r) => hasGenerator(r, /docusaurus/i), root: (r) => byClass("theme-doc-markdown")(r) ?? findFirst(r, (n) => n.tag === "article") },
	{ match: (_u, r) => hasGenerator(r, /nextra/i), root: (r) => findFirst(r, (n) => n.tag === "main")?.children.find((c) => c.tag === "article") ?? null },
	{ match: (u) => !!u && /(^|\.)developer\.mozilla\.org$/.test(u.hostname), root: byClass("main-page-content") },
	{ match: (u) => !!u && /(^|\.)react\.dev$/.test(u.hostname), root: (r) => findFirst(r, (n) => n.tag === "article") },
];

function profileRoot(url: URL | null, root: Node): Node | null {
	for (const p of PROFILES) {
		if (!p.match(url, root)) continue;
		const r = p.root(root);
		if (r && rawText(r).replace(/\s+/g, " ").trim().length >= 200) return r;
	}
	return null;
}

// ------------------------------------------------------ markdown rendering

function absUrl(href: string | undefined, base: URL): string | null {
	const t = (href ?? "").trim();
	if (!t || t.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(t)) return null;
	try {
		return new URL(t, base).href;
	} catch {
		return null;
	}
}

function inlineToMd(node: Node, base: URL): string {
	if (node.tag === "#text") return (node.text ?? "").replace(/\s+/g, " ");
	let kids = "";
	for (const c of node.children) kids += inlineToMd(c, base);
	switch (node.tag) {
		case "br":
			return "\n";
		case "b":
		case "strong":
			return `**${kids.trim()}**`;
		case "em":
		case "i":
			return `_${kids.trim()}_`;
		case "code":
			return `\`${kids.trim()}\``;
		case "a": {
			const href = absUrl(node.attrs.href, base);
			const text = kids.trim();
			if (!href || !text) return text;
			return `[${text}](${href})`;
		}
		case "img": {
			const alt = (node.attrs.alt ?? "").trim();
			const src = absUrl(node.attrs.src, base);
			return alt && src ? `![${alt}](${src})` : "";
		}
		default:
			return kids;
	}
}

function renderTable(node: Node, base: URL): string {
	const trs: Node[] = [];
	const walk = (n: Node) => {
		if (n.tag === "tr") trs.push(n);
		for (const c of n.children) walk(c);
	};
	walk(node);
	const rows = trs
		.map((tr) =>
			tr.children
				.filter((c) => c.tag === "td" || c.tag === "th")
				.map((cell) => inlineToMd(cell, base).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim().slice(0, 120)),
		)
		.filter((r) => r.length > 0);
	if (rows.length === 0) return "";
	const width = Math.min(Math.max(...rows.map((r) => r.length)), 8);
	const pad = (cells: string[]) => {
		const fixed = cells.slice(0, width);
		while (fixed.length < width) fixed.push("");
		return `| ${fixed.join(" | ")} |`;
	};
	const out = [pad(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`];
	for (const r of rows.slice(1, 30)) out.push(pad(r));
	return `\n${out.join("\n")}\n`;
}

function renderBlock(node: Node, base: URL, depth: number): string {
	const tag = node.tag;
	if (tag === "#text") return (node.text ?? "").replace(/\s+/g, " ");
	if (tag === "sup" && /reference|noprint|cite/i.test(node.attrs.class ?? "")) return ""; // [n] ref markers
	if (tag === "table" && /infobox|vertical-navbox|metadata|sidebar|toc|ambox/i.test(node.attrs.class ?? "")) return "";
	if (tag === "style" || tag === "script") return "";
	if (/^h[1-6]$/.test(tag)) {
		const text = inlineToMd(node, base).replace(/\s*\[(\d+)\]\s*/g, "").trim();
		return text ? `\n${"#".repeat(Number(tag[1]))} ${text}\n` : "";
	}
	if (tag === "p") {
		const text = inlineToMd(node, base).trim();
		return text ? `\n${text}\n` : "";
	}
	if (tag === "pre") {
		const codeEl = node.children.find((c) => c.tag === "code") ?? node;
		const lang = /language-([\w+-]+)/.exec(`${node.attrs.class ?? ""} ${codeEl.attrs.class ?? ""}`)?.[1] ?? "";
		let code: string;
		if (codeEl.children.some((c) => c.tag === "div" || c.tag === "br")) {
			// markup-based code blocks (react.dev sandpack cm-line divs): every block
			// child is a line, every <br> a line break — rawText would fuse them.
			// A div whose content already ends with <br> adds no extra newline.
			const line = (n: Node, last: boolean): string => {
				if (n.tag === "#text") return n.text ?? "";
				if (n.tag === "br") return "\n";
				if (n.tag === "div") {
					let inner = "";
					for (const c of n.children) inner += line(c, false);
					return inner.endsWith("\n") ? inner : inner + (last ? "" : "\n");
				}
				let out = "";
				for (const c of n.children) out += line(c, last);
				return out;
			};
			code = codeEl.children.map((c, i) => line(c, i === codeEl.children.length - 1)).join("");
		} else {
			code = rawText(codeEl);
		}
		return `\n\`\`\`${lang}\n${code.replace(/^\n/, "").replace(/\n+$/, "")}\n\`\`\`\n`;
	}
	if (tag === "blockquote") {
		const inner = renderChildren(node, base, depth + 1).trim();
		return inner ? `\n${inner.split("\n").map((l) => `> ${l}`).join("\n")}\n` : "";
	}
	if (tag === "ul" || tag === "ol") {
		const items: string[] = [];
		let idx = 1;
		for (const c of node.children) {
			if (c.tag !== "li") continue;
			const inner = renderChildren(c, base, depth + 1).trim();
			if (!inner) continue;
			const b = tag === "ol" ? `${idx++}. ` : "- ";
			const lines = inner.split("\n");
			items.push([`${b}${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)].join("\n"));
		}
		return items.length ? `\n${items.join("\n")}\n` : "";
	}
	if (tag === "table") return renderTable(node, base);
	if (tag === "hr") return "\n---\n";
	if (tag === "footer") return ""; // boilerplate
	if (tag === "header") return renderChildren(node, base, depth + 1); // may hold the H1
	// block containers get paragraph separators so sibling divs don't run together
	if (SEP.has(tag)) {
		const inner = renderChildren(node, base, depth + 1);
		return inner.trim() ? `\n${inner}\n` : "";
	}
	return renderChildren(node, base, depth + 1);
}

function renderChildren(node: Node, base: URL, depth: number): string {
	if (depth > 40) return rawText(node);
	let s = "";
	const kids = node.children;
	for (let i = 0; i < kids.length; i++) {
		const c = kids[i];
		// whitespace-only text between block siblings (or at either end) is layout
		// noise; between inline siblings it is the word separator and survives
		if (c.tag === "#text" && !/\S/.test(c.text ?? "")) {
			const prev = kids[i - 1];
			const next = kids[i + 1];
			if (!prev || !next || BLOCK.has(prev.tag) || BLOCK.has(next.tag)) continue;
			s += " ";
			continue;
		}
		s += renderBlock(c, base, depth);
	}
	return s;
}

const LANG_RE = /^(afrikaans|albanian|amharic|arabic|armenian|asturian|assamese|avaric|aymara|azerbaijani|bashkir|basque|belarusian|bengali|bosnian|breton|bulgarian|burmese|catalan|cebuano|chamorro|cherokee|chichewa|chinese|corsican|cree|croatian|czech|danish|dutch|dzongkha|english|esperanto|estonian|ewe|faroese|fijian|filipino|finnish|french|fula|galician|georgian|german|greek|guarani|gujarati|haitian|hausa|hausa|hebrew|herero|hindi|hiri motu|hungarian|icelandic|ido|igbo|indonesian|interlingua|inuktitut|irish|italian|japanese|javanese|kannada|kanuri|kazakh|khmer|kikuyu|kinyarwanda|kirundi|korean|kurdish|kyrgyz|lao|latin|latvian|limburgish|lingala|lithuanian|luxembourgish|macedonian|malagasy|malay|malayalam|maltese|manx|maori|marathi|mongolian|nauru|navajo|ndonga|nepali|norwegian|occitan|ojibwe|oromo|ossetian|pashto|persian|polish|portuguese|punjabi|quechua|romanian|russian|samoan|sango|sanskrit|sardinian|scots|serbian|sesotho|shona|sindhi|sinhala|slovak|slovenian|somali|spanish|sundanese|swahili|swedish|tagalog|tahitian|tajik|tamil|tatar|telugu|thai|tigrinya|tok pisin|tongan|tsonga|tswana|turkish|turkmen|twi|ukrainian|urdu|uyghur|uzbek|vietnamese|walloon|welsh|wolof|xhosa|yiddish|yoruba|zulu)$/i;

function isLanguageName(word: string): boolean {
	return LANG_RE.test(word.trim());
}

/** Extract the best content block as markdown. Returns "" when output looks like junk. */
export function htmlToMarkdown(page: string, baseUrl: string, maxChars: number): { text: string; truncated: boolean } {
	const root = parseHtml(page);
	const title = decodeEntities(rawText(findFirst(root, (n) => n.tag === "title") ?? { tag: "#text", attrs: {}, children: [] })).trim();
	let url: URL | null = null;
	try {
		url = new URL(baseUrl);
	} catch {
		/* profile matching just skips host checks */
	}
	const best = profileRoot(url, root) ?? pickBest(root);
	let body = renderChildren(best, new URL(baseUrl), 0)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
	body = body
		.split("\n")
		.filter((l) => {
			const t = l.trim();
			if (/^(skip to (main )?content|toggle (the )?table of contents|jump to (content|nav)|advertisement|cookie (notice|settings)?|edit links|views|actions|print\/export|in other projects|appearance|move to sidebar|tools)\b/i.test(t)) return false;
			// arXiv subject classification chip and its breadcrumb sibling — page chrome,
			// not paper content (the real title follows immediately)
			if (/^# Computer Science >/.test(t)) return false;
			if (/^arXiv:\d{4}\.\d{4,5}( \(cs\))?$/.test(t)) return false;
			if (/^- [^\d][\w '’-]{1,25}$/.test(t) && isLanguageName(t.slice(2))) return false;
			if (/^\d+ languages$/i.test(t)) return false;
			return true;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	// junk gate: unicode-letter aware (Latin, Cyrillic, CJK, …); CJK pages carry
	// wide punctuation and Latin link markup, so their bar is lower
	const letters = (body.match(/\p{L}/gu) ?? []).length;
	const cjk = (body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
	const minRatio = cjk / Math.max(letters, 1) > 0.3 ? 0.25 : 0.35;
	if (body.length < 120 || letters / body.length < minRatio) return { text: "", truncated: false };
	// title H1: emit only when the body has no heading of its own and nothing that
	// duplicates the title; the site suffix ("— Example Blog") is redundant with the URL header
	const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	const siteless = title.replace(/\s+[-–—|·»:]\s+[^-–—|·»:]{2,60}$/, "").trim();
	const window = body.slice(0, 300);
	const firstHeading = window.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? "";
	const hasOwnH1 = /^# |\n# /.test(window);
	const dup = !!firstHeading && (norm(firstHeading) === norm(siteless) || norm(firstHeading) === norm(title));
	const head = title && !hasOwnH1 && !dup ? `# ${siteless}\n\n` : "";
	const full = `${head}${body}`;
	return { text: full.slice(0, maxChars), truncated: full.length > maxChars };
}

function findFirst(node: Node, pred: (n: Node) => boolean): Node | null {
	if (pred(node)) return node;
	for (const c of node.children) {
		const hit = findFirst(c, pred);
		if (hit) return hit;
	}
	return null;
}

// ------------------------------------------------------------------ dates

function attrValue(tag: string, name: string): string | undefined {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
	return m ? (m[2] ?? m[3]) : undefined;
}

const toIsoDate = (raw?: string): string | undefined => {
	if (!raw) return undefined;
	const s = raw.trim();
	// date-only strings (2025-05-12, 2025/05/12) carry no time zone — use them
	// as-is instead of shifting through a local-midnight Date
	const dateOnly = s.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (dateOnly) {
		return `${dateOnly[1]}-${dateOnly[2]!.padStart(2, "0")}-${dateOnly[3]!.padStart(2, "0")}`;
	}
	const ts = Date.parse(s);
	return Number.isNaN(ts) ? undefined : new Date(ts).toISOString().slice(0, 10);
};

function jsonLdDate(json: string): string | undefined {
	try {
		const data = JSON.parse(json);
		for (const n of Array.isArray(data) ? data : (data["@graph"] ?? [data])) {
			const iso = toIsoDate(n?.datePublished) ?? toIsoDate(n?.dateModified);
			if (iso) return iso;
		}
	} catch {
		/* malformed JSON-LD is common; ignore */
	}
	return undefined;
}

/**
 * Best-effort page publication date (YYYY-MM-DD). Priority:
 * article:published_time / og:updated_time → JSON-LD datePublished/dateModified
 * → <time datetime> → date/dc.date/pubdate metas → /2026/08/10/ URL path.
 */
export function extractDate(html: string, pageUrl: string): string | undefined {
	const metas = new Map<string, string>();
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const key = (attrValue(tag, "property") ?? attrValue(tag, "name"))?.toLowerCase();
		const content = attrValue(tag, "content");
		if (key && content && !metas.has(key)) metas.set(key, content);
	}
	for (const k of ["article:published_time", "og:updated_time"]) {
		const iso = toIsoDate(metas.get(k));
		if (iso) return iso;
	}
	for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		const iso = jsonLdDate(m[1]!);
		if (iso) return iso;
	}
	const timeIso = toIsoDate(html.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1]);
	if (timeIso) return timeIso;
	for (const k of ["date", "dc.date", "pubdate"]) {
		const iso = toIsoDate(metas.get(k));
		if (iso) return iso;
	}
	const path = pageUrl.match(/\/(20\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/);
	if (path) return `${path[1]}-${path[2]}-${path[3]}`;
	// citation_date / citation_publication_date (arxiv, journals, CMS blogs)
	for (const k of ["citation_publication_date", "citation_date"]) {
		const iso = toIsoDate(metas.get(k));
		if (iso) return iso;
	}
	// plain-text stamps: "[Submitted on 12 Jun 2017" (day-first) and
	// "Published March 3, 2025" (US month-first)
	const MONTHS: Record<string, string> = {
		jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
		jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
	};
	const dayFirst = html.match(/(?:Submitted on|Published on|posted on)\s+(\d{1,2})\s+(\w{3,9})\.?,?\s+(20\d{2})/i);
	if (dayFirst) {
		const mo = MONTHS[dayFirst[2]!.slice(0, 3).toLowerCase()];
		if (mo) return `${dayFirst[3]}-${mo}-${dayFirst[1]!.padStart(2, "0")}`;
	}
	const usFirst = html.match(/(?:Submitted on|Published on|Published|posted on)\s+(\w{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})/i);
	if (usFirst) {
		const mo = MONTHS[usFirst[1]!.slice(0, 3).toLowerCase()];
		if (mo) return `${usFirst[3]}-${mo}-${usFirst[2]!.padStart(2, "0")}`;
	}
	// bare "Apr 24, 2024" — either in the page-header zone (first 3000 chars) or in
	// a structural metadata element (dt/dd "Last Updated"/"Published")
	const metadata = html.match(/(?:Last [Uu]pdated|[Dd]ate|[Pp]ublished)<\/dt>\s*<dd>\s*(\w{3})\s+(\d{1,2}),\s+(20\d{2})/);
	if (metadata && MONTHS[metadata[1]!.toLowerCase()]) {
		return `${metadata[3]}-${MONTHS[metadata[1]!.toLowerCase()]}-${metadata[2]!.padStart(2, "0")}`;
	}
	const head = html.slice(0, 3000);
	const bare = head.match(/\b(\w{3})\s+(\d{1,2}),\s+(20\d{2})\b/);
	if (bare && MONTHS[bare[1]!.toLowerCase()]) {
		return `${bare[3]}-${MONTHS[bare[1]!.toLowerCase()]}-${bare[2]!.padStart(2, "0")}`;
	}
	return undefined;
}
