/**
 * HTML → markdown extractor with density-scored article detection.
 *
 * Stage 1: score candidate blocks by text/link density (Readability-lite)
 * and pick the best content container.
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

/** Tolerant HTML parser → shallow node tree. Never throws. */
export function parseHtml(html: string): Node {
	const root: Node = { tag: "#root", attrs: {}, children: [] };
	const stack: Node[] = [root];
	let i = 0;
	const len = html.length;
	while (i < len) {
		const lt = html.indexOf("<", i);
		if (lt === -1) break;
		// text before this tag
		if (lt > i) {
			const t = html.slice(i, lt);
			if (/\S/.test(t)) stack[stack.length - 1].children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(t) });
		}
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt);
			i = end === -1 ? len : end + 3;
			continue;
		}
		if (html[lt + 1] === "/") {
			const gt = html.indexOf(">", lt);
			const tag = html.slice(lt + 2, gt === -1 ? len : gt).trim().toLowerCase();
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
		// raw-text elements: consume until the literal close tag
		if (tagName === "script" || tagName === "style") {
			const close = new RegExp(`</${tagName}\\s*>`, "i").exec(html.slice(gt));
			i = close ? gt + close.index + close[0].length : len;
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const m of tagSrc.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
			attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
		}
		const node: Node = { tag: tagName, attrs, children: [] };
		stack[stack.length - 1].children.push(node);
		const selfClosing = tagSrc.endsWith("/") || VOID_TAGS.has(tagName);
		// MediaWiki Parsoid annotation wrappers: drop the element AND its content
		if (/mw:Transclusion|mw:Param/.test(attrs["typeof"] ?? "")) {
			const close = new RegExp(`</${tagName}\s*>`, "i").exec(html.slice(gt));
			i = close ? gt + close.index + close[0].length : len;
			continue;
		}
		if (!selfClosing) stack.push(node);
		i = gt + 1;
	}
	// trailing text
	if (i < len && /\S/.test(html.slice(i))) {
		stack[stack.length - 1].children.push({ tag: "#text", attrs: {}, children: [], text: html.slice(i) });
	}
	return root;
}

// ------------------------------------------------------------------ stats

function collectStats(node: Node, inLink: boolean, stats: { textLen: number; linkTextLen: number }): void {
	if (node.tag === "#text") {
		const n = (node.text ?? "").replace(/\s+/g, " ").trim().length;
		stats.textLen += n;
		if (inLink) stats.linkTextLen += n;
		return;
	}
	for (const c of node.children) collectStats(c, inLink || node.tag === "a", stats);
}

function countTag(node: Node, tag: string): number {
	let n = node.tag === tag ? 1 : 0;
	for (const c of node.children) n += countTag(c, tag);
	return n;
}

function rawText(node: Node): string {
	let s = node.text ?? "";
	for (const c of node.children) s += rawText(c);
	return s;
}

const GOOD_CLASS = /content|article|post|entry|body|main|markdown|docs/i;
const BAD_CLASS = /comment|sidebar|footer|nav|related|share|promo|advert|ads?-|cookie|banner|menu|social|newsletter|widget|mw-portlet|vector-menu/i;

/** Pick the best content container (Readability-lite scoring). */
function pickBest(root: Node): Node {
	const candidates: Array<{ node: Node; score: number; textLenOf: number }> = [];
	const walk = (node: Node, depth: number) => {
		if (node.tag === "#text" || depth > 25) return;
		const stats = { textLen: 0, linkTextLen: 0 };
		collectStats(node, false, stats);
		if (stats.textLen > 200) {
			const linkDensity = stats.linkTextLen / stats.textLen;
			const cls = `${node.attrs.id ?? ""} ${node.attrs.class ?? ""}`.toLowerCase();
			let score =
				stats.textLen * (1 - linkDensity) + 25 * (countTag(node, "p") + countTag(node, "li") + countTag(node, "pre"));
			if (/^(article|main)$/.test(node.tag)) score *= 1.5;
			if (GOOD_CLASS.test(cls)) score *= 1.25;
			if (BAD_CLASS.test(cls)) score *= 0.4;
			if (linkDensity > 0.6) score *= 0.3;
			// MediaWiki parser output is a known content island — skip generic shells
			if (node.attrs.class?.includes("mw-parser-output")) score *= 4;
			candidates.push({ node, score, textLenOf: stats.textLen });
		}
		for (const c of node.children) if (c.tag !== "#text") walk(c, depth + 1);
	};
	walk(root, 0);
	if (candidates.length === 0) return root;
	let best = candidates[0];
	for (const c of candidates) if (c.score > best.score) best = c;
	// innermost candidate within 80% of the best score — trims sidebars/nav shells
	const nearBest = candidates.filter((c) => c.score >= best.score * 0.8);
	const innermost = nearBest.reduce((a, b) => (b.textLenOf < a.textLenOf ? b : a));
	return innermost.node;
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
		return `\n\`\`\`${lang}\n${rawText(codeEl).replace(/\n+$/, "")}\n\`\`\`\n`;
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
	if (tag === "header" || tag === "footer") {
		// keep header content (may hold the H1) but drop footer boilerplate
		return tag === "footer" ? "" : renderChildren(node, base, depth + 1);
	}
	return renderChildren(node, base, depth + 1);
}

function renderChildren(node: Node, base: URL, depth: number): string {
	if (depth > 40) return rawText(node);
	let s = "";
	for (const c of node.children) s += renderBlock(c, base, depth);
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
	const best = pickBest(root);
	let body = renderChildren(best, new URL(baseUrl), 0)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/([a-z,;)\"\]])\n(?=[a-z])/, "$1 ") // unwrap block elements that render run-on prose
		.trim();
	body = body
		.split("\n")
		.filter((l) => {
			const t = l.trim();
			if (/^(skip to (main )?content|toggle (the )?table of contents|jump to (content|nav)|advertisement|cookie (notice|settings)?|edit links|views|actions|print\/export|in other projects|appearance|move to sidebar|tools)\b/i.test(t)) return false;
			if (/^- [^\d][\w '’-]{1,25}$/.test(t) && isLanguageName(t.slice(2))) return false;
			if (/^\d+ languages$/i.test(t)) return false;
			return true;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const letters = (body.match(/[a-zA-Z]/g) ?? []).length;
	if (body.length < 120 || letters / body.length < 0.35) return { text: "", truncated: false };
	const head = title && !body.toLowerCase().startsWith(title.toLowerCase()) ? `# ${title}\n\n` : "";
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
