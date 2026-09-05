/**
 * Site adapters — route known URL shapes to a cheaper, cleaner source
 * instead of scraping HTML. Each adapter returns markdown or null
 * (null = no adapter / adapter failed → caller falls back to generic fetch).
 *
 * All free, no keys (GitHub optionally honours GITHUB_TOKEN for rate limits).
 */
import { getJson } from "./apis.ts";
import { decodeEntities } from "./engine.ts";

import { TOOL_UA as UA } from "./version.ts";

async function getText(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
	const timeout = AbortSignal.timeout(20_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/plain, text/markdown, */*", ...headers },
		signal: combined,
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
	return res.text();
}

export interface AdapterResult {
	text: string;
	source: string; // e.g. "github-api"
	/** publication date (YYYY-MM-DD) when the API provides one */
	date?: string;
}

type Adapter = (url: URL, signal?: AbortSignal) => Promise<AdapterResult | null>;

// -------------------------------------------------------------- pure router

/**
 * Pure, I/O-free routing decision: `name` keys the RUN table below, `upstream`
 * names the exact URL(s) the runner will fetch (used by fetch_page's pre-flight
 * status line and by tests — matchAdapter never touches the network).
 */
export interface AdapterMatch {
	name: string;
	upstream: string[];
}

const GH_RESERVED = new Set([
	"features", "topics", "marketplace", "orgs", "sponsors", "login", "settings",
	"explore", "trending", "collections", "events", "about", "pricing", "apps",
	"enterprise", "customer-stories", "security", "readme", "site", "team",
]);

function hasTraversal(segs: string[]): boolean {
	return segs.some((s) => {
		try {
			return decodeURIComponent(s) === "..";
		} catch {
			return true; // malformed encoding — treat as blocked
		}
	});
}

function matchGithub(url: URL): AdapterMatch | null {
	if (!/^(www\.)?github\.com$/.test(url.hostname)) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	const [owner, repo, kind, ...rest] = parts;
	if (!owner || GH_RESERVED.has(owner) || !repo) return null;
	if ((kind === "blob" || kind === "raw") && rest.length >= 2 && !hasTraversal(rest)) {
		const [ref, ...path] = rest;
		return { name: "github-raw", upstream: [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`] };
	}
	if (kind === "tree" && rest.length >= 2 && !hasTraversal(rest)) {
		const [ref, ...dir] = rest;
		return { name: "github-tree-api", upstream: [`https://api.github.com/repos/${owner}/${repo}/contents/${dir.join("/")}?ref=${encodeURIComponent(ref!)}`] };
	}
	if (kind === "issues" || kind === "pull") {
		const num = Number(rest[0]);
		if (!num) return null;
		const isPr = kind === "pull";
		return {
			name: isPr ? "github-pr-api" : "github-issue-api",
			upstream: [
				`https://api.github.com/repos/${owner}/${repo}/${isPr ? "pulls" : "issues"}/${num}`,
				`https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments?per_page=30`,
			],
		};
	}
	if (parts.length === 2) {
		return {
			name: "github-api",
			upstream: [
				`https://api.github.com/repos/${owner}/${repo}`,
				`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
			],
		};
	}
	return null;
}

const SE_SITES = /^(stackoverflow|superuser|serverfault)\.com$|^([a-z0-9-]+)\.stackexchange\.com$/i;

function matchStackExchange(url: URL): AdapterMatch | null {
	const m = url.hostname.match(SE_SITES);
	if (!m) return null;
	const site = (m[1] ?? m[2] ?? "stackoverflow").toLowerCase();
	const p = url.pathname;
	let qm = p.match(/\/(?:questions|q)\/(\d+)/);
	const am = p.match(/\/a\/(\d+)/);
	if (qm) {
		return {
			name: "stackexchange-api",
			upstream: [
				`https://api.stackexchange.com/2.3/questions/${qm[1]}/answers?order=desc&sort=votes&site=${site}&filter=withbody&pagesize=5`,
				`https://api.stackexchange.com/2.3/questions/${qm[1]}?site=${site}&filter=!9Z(-wwYGT`,
			],
		};
	}
	if (am) {
		// answer permalink: one hop — the answer body carries question_id, so the
		// runner links back to the question instead of fetching its title
		return {
			name: "stackexchange-api",
			upstream: [`https://api.stackexchange.com/2.3/answers/${am[1]}?order=desc&sort=votes&site=${site}&filter=withbody`],
		};
	}
	return null;
}

function matchReddit(url: URL): AdapterMatch | null {
	if (!/^(www\.|old\.|new\.|np\.)?reddit\.com$/.test(url.hostname)) return null;
	if (!url.pathname.includes("/comments/")) return null;
	return { name: "reddit-json", upstream: [url.protocol + "//" + url.host + url.pathname.replace(/\/$/, "") + ".json?limit=30"] };
}

function matchHn(url: URL): AdapterMatch | null {
	if (!/^news\.ycombinator\.com$/.test(url.hostname)) return null;
	const id = url.searchParams.get("id");
	if (!id || !/^\d+$/.test(id)) return null;
	return { name: "hn-algolia", upstream: [`https://hn.algolia.com/api/v1/items/${id}`] };
}

function matchWikipedia(url: URL): AdapterMatch | null {
	const m = url.hostname.match(/^([a-z-]+)\.(m\.)?wikipedia\.org$/i);
	if (!m) return null;
	const lang = m[1]!;
	if (!lang || lang === "www") return null;
	const pm = url.pathname.match(/^\/wiki\/([^/:#]+)$/);
	if (!pm) return null;
	const title = encodeURIComponent(decodeURIComponent(pm[1]!));
	return {
		name: "wikipedia-rest",
		upstream: [
			`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`,
			`https://${lang}.wikipedia.org/api/rest_v1/page/html/${title}`,
		],
	};
}

function matchArxiv(url: URL): AdapterMatch | null {
	if (!/^(www\.)?arxiv\.org$/.test(url.hostname)) return null;
	const m = url.pathname.match(/^\/abs\/([^?#]+)$/);
	if (!m) return null; // /pdf/{id} deliberately unrouted: the generic PDF path handles it
	return { name: "arxiv-api", upstream: [`https://export.arxiv.org/api/query?id_list=${m[1]}&max_results=1`] };
}

const MATCHERS: Array<(u: URL) => AdapterMatch | null> = [
	matchGithub,
	matchStackExchange,
	matchReddit,
	matchHn,
	matchWikipedia,
	matchArxiv,
];

/** Route a URL to an adapter without any I/O. null = generic fetch path. */
export function matchAdapter(url: URL): AdapterMatch | null {
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	for (const fn of MATCHERS) {
		const m = fn(url);
		if (m) return m;
	}
	return null;
}

// ------------------------------------------------------------------- github

function ghHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	return token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" };
}

async function runGithubRepo(url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const [owner, repo] = url.pathname.split("/").filter(Boolean);
	if (!owner || !repo) return null;
	const meta = await getJson<any>(`https://api.github.com/repos/${owner}/${repo}`, signal, ghHeaders());
	let md = `# ${meta.full_name}\n\n${meta.description ?? ""}\n\n`;
	md += `★ ${meta.stargazers_count} · ${meta.language ?? "?"} · updated ${(meta.updated_at ?? "").slice(0, 10)}\n`;
	if (meta.license?.spdx_id) md += `License: ${meta.license.spdx_id}\n`;
	if (Array.isArray(meta.topics) && meta.topics.length) md += `Tags: ${meta.topics.slice(0, 8).join(", ")}\n`;
	// raw.githubusercontent.com resolves the literal ref HEAD to the default branch —
	// no metadata round trip for the branch name
	try {
		const readme = await getText(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`, signal);
		md += `\n---\n\n${readme}`;
	} catch {
		/* repo without a root README: metadata only */
	}
	return { text: md.slice(0, 120_000), source: "github-api" };
}

async function runGithubRaw(url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	// /{owner}/{repo}/(blob|raw)/{ref}/{path...}
	const [, , , , ref, ...path] = url.pathname.split("/").filter(Boolean);
	if (!ref || path.length === 0) return null;
	const raw = `https://raw.githubusercontent.com/${url.pathname.split("/").filter(Boolean)[0]}/${url.pathname.split("/").filter(Boolean)[1]}/${ref}/${path.join("/")}`;
	const text = await getText(raw, signal);
	return { text: text.slice(0, 200_000), source: "github-raw" };
}

async function runGithubTree(m: AdapterMatch, _url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	// upstream[0] = contents API for the directory
	const items = await getJson<any[]>(m.upstream[0]!, signal, ghHeaders());
	if (!Array.isArray(items)) return null;
	const lines = items.map((f) => `${f.type === "dir" ? "- d " : "- f "}${f.name}${f.type === "file" && f.size != null ? ` (${f.size}B)` : ""}`);
	const dirName = decodeURIComponent(m.upstream[0]!.split("contents/")[1]?.split("?")[0] ?? "");
	return { text: `# ${dirName || "repository root"}\n\n${lines.join("\n")}\n`, source: "github-tree-api" };
}

async function runGithubIssue(url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const segs = url.pathname.split("/").filter(Boolean);
	const [owner, repo, kind, numStr] = segs;
	const num = Number(numStr);
	if (!owner || !repo || !num) return null;
	const isPr = kind === "pull";
	const base = `https://api.github.com/repos/${owner}/${repo}/${isPr ? "pulls" : "issues"}/${num}`;
	const item = await getJson<any>(base, signal, ghHeaders());
	let md = `# ${item.title ?? `${owner}/${repo}#${num}`}\n\n${item.body ?? "(no body)"}\n`;
	const comments = await getJson<any[]>(`https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments?per_page=30`, signal, ghHeaders()).catch(() => []);
	if (Array.isArray(comments) && comments.length > 0) {
		md += `\n---\n\n## Comments\n\n` + comments
			.map((c) => `**${c.user?.login ?? "?"}** (${(c.created_at ?? "").slice(0, 10)}):\n\n${c.body ?? ""}`)
			.join("\n\n---\n\n");
	}
	return { text: md.slice(0, 100_000), source: isPr ? "github-pr-api" : "github-issue-api" };
}

// ------------------------------------------------------- stackoverflow

function stripHtml(s: string): string {
	// keep <pre><code>/<code> bodies verbatim (still entity-encoded), strip the
	// surrounding tags, then decode entities exactly once over the whole result —
	// code and prose decode identically and already-decoded text can't re-mangle
	// (decodeEntities' named-entity pattern requires the trailing semicolon)
	const out = s
		.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, c) => `\n\`\`\`\n${c}\n\`\`\`\n`)
		.replace(/<code>([\s\S]*?)<\/code>/g, (_, c) => `\`${c}\``)
		.replace(/<(p|br|div|li|h[1-6])[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	return decodeEntities(out).replace(/\n{3,}/g, "\n\n").trim();
}

async function runStackExchange(m: AdapterMatch, _url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const site = new URL(m.upstream[0]!).searchParams.get("site") ?? "stackoverflow";
	const qm = m.upstream[0]!.match(/\/questions\/(\d+)\//);
	if (qm) {
		// question page: answers + question body
		const id = qm[1]!;
		const q = await getJson<any>(m.upstream[0]!, signal);
		const qData = await getJson<any>(`https://api.stackexchange.com/2.3/questions/${id}?site=${site}&filter=!9Z(-wwYGT`, signal).catch(() => null);
		const question = qData?.items?.[0];
		let md = question ? `# ${question.title}\n\n${stripHtml(question.body ?? "")}\n` : "";
		const answers = (q.items ?? []) as any[];
		if (answers.length > 0) {
			md += `\n---\n\n## Answers\n\n` + answers
				.map((a) => `${a.is_accepted ? "**Accepted answer**\n\n" : ""}${stripHtml(a.body ?? "")}`)
				.join("\n\n---\n\n");
		} else {
			md += "\n(no answers yet)\n";
		}
		return { text: md.slice(0, 100_000), source: "stackexchange-api" };
	}
	// /a/{id} answer permalink: one hop, link back to the question
	const am = m.upstream[0]!.match(/\/answers\/(\d+)/);
	if (!am) return null;
	const data = await getJson<any>(m.upstream[0]!, signal).catch(() => null);
	const a = data?.items?.[0];
	if (!a) return null;
	const md = `${a.is_accepted ? "**Accepted answer**\n\n" : ""}${stripHtml(a.body ?? "")}\n\n[question ${a.question_id}](https://${site === "stackoverflow" ? "stackoverflow.com" : site + ".stackexchange.com"}/questions/${a.question_id})`;
	return { text: md.slice(0, 100_000), source: "stackexchange-api" };
}

// ----------------------------------------------------------------- hackernews

async function runHn(m: AdapterMatch, _url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const item = await getJson<any>(m.upstream[0]!, signal);
	const flat = (n: any, depth: number): string => {
		let s = "";
		if (n.text) s += `${"  ".repeat(depth)}- ${String(n.text).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}\n`;
		for (const c of n.children ?? []) s += flat(c, depth + 1);
		return s;
	};
	const md = `# ${item.title ?? "HN thread " + (item.id ?? "")}\n\n${item.points ? `${item.points} points · u/${item.author ?? "?"}\n\n` : ""}${flat(item, 0)}`;
	return { text: md.slice(0, 100_000), source: "hn-algolia" };
};

// ------------------------------------------------------------------ reddit

async function runReddit(m: AdapterMatch, _url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const data = (await getJson<any>(m.upstream[0]!, signal)) as any;
	const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : null;
	if (!post) return null;
	let md = `# ${post.title}\n\nr/${post.subreddit} · ↑${post.ups} · u/${post.author}\n\n${post.selftext ?? ""}\n`;
	const comments = Array.isArray(data) ? data[1]?.data?.children ?? [] : [];
	const flat = (children: any[], depth = 0): string => {
		let s = "";
		for (const c of children) {
			const d = c.data;
			if (!d || d.kind === "more") continue;
			s += `${"  ".repeat(depth)}- **u/${d.author}** (↑${d.ups}): ${String(d.body ?? "").replace(/\n+/g, " ").slice(0, 500)}\n`;
			if (d.replies?.data?.children) s += flat(d.replies.data.children, depth + 1);
		}
		return s;
	};
	md += `\n## Top comments\n\n` + flat(comments);
	return { text: md.slice(0, 80_000), source: "reddit-json" };
};

// ------------------------------------------------------------- wikipedia

async function runWikipedia(m: AdapterMatch, _url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const [summaryUrl, htmlUrl] = m.upstream as [string, string];
	const summary = await getJson<any>(summaryUrl, signal).catch(() => null);
	// 404 page: summary 404s AND the action=raw fetch 404s (with an error body) —
	// bail so the caller's generic path reports HTTP 404 instead of error text
	const raw = await getText(htmlUrl, signal).catch(() => "");
	if (!summary || !raw) return null;
	// reuse the extractor's markdown conversion
	const url = new URL(htmlUrl);
	const { htmlToMarkdown } = await import("./extract.ts");
	const converted = htmlToMarkdown(raw, url.href, 200_000);
	let md = converted.text;
	// lede dedupe: compare the summary extract against the markdown lede with
	// decoration stripped (was a raw includes() that always failed on **bold**)
	const stripMd = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
	const lede = stripMd(md.split(/\n#{1,6}\s/)[0] ?? "").slice(0, 300).toLowerCase();
	if (summary?.extract && !lede.includes(stripMd(summary.extract).slice(0, 60).toLowerCase())) {
		md = `${summary.extract}\n\n${md}`;
	}
	return { text: md.slice(0, 200_000), source: "wikipedia-rest" };
}

async function runArxiv(m: AdapterMatch, _url: URL, signal?: AbortSignal): Promise<AdapterResult | null> {
	const atom = await getText(m.upstream[0]!, signal);
	const entry = atom.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
	if (!entry) return null;
	const pick = (tag: string) => entry.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim();
	const dec = (s?: string) => decodeEntities(s ?? "").replace(/\s+/g, " ").trim();
	const [title, summary] = [dec(pick("title")), dec(pick("summary"))];
	if (!title || !summary) return null;
	const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => decodeEntities(a[1]!));
	const id = pick("id")?.replace("http://arxiv.org/abs/", "") ?? "";
	const [published, updated] = [pick("published")?.slice(0, 10), pick("updated")?.slice(0, 10)];
	const md = `# ${title}\n\n${authors.join(", ")}\n\nPublished ${published ?? "?"}` +
		(updated && updated !== published ? ` · updated ${updated}` : "") +
		`\n\n## Abstract\n\n${summary}\n\n[PDF](https://arxiv.org/pdf/${id})\n`;
	return { text: md.slice(0, 60_000), source: "arxiv-api", date: published };
}

// ------------------------------------------------------------------ router

type AdapterFn = (m: AdapterMatch, url: URL, signal?: AbortSignal) => Promise<AdapterResult | null>;

const RUN: Record<string, AdapterFn> = {
	"github-api": (_, url, signal) => runGithubRepo(url, signal),
	"github-raw": (_, url, signal) => runGithubRaw(url, signal),
	"github-tree-api": runGithubTree,
	"github-issue-api": (_, url, signal) => runGithubIssue(url, signal),
	"github-pr-api": (_, url, signal) => runGithubIssue(url, signal),
	"stackexchange-api": runStackExchange,
	"reddit-json": runReddit,
	"hn-algolia": runHn,
	"wikipedia-rest": runWikipedia,
	"arxiv-api": runArxiv,
};

/**
 * Try site adapters for a URL. matchAdapter is pure; dispatch goes through the
 * RUN table with the original URL. Returns null when no adapter matches or all
 * fail — caller falls back to the generic HTML pipeline.
 */
export async function trySiteAdapter(url: string, signal?: AbortSignal): Promise<AdapterResult | null> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	const m = matchAdapter(u);
	if (!m) return null;
	try {
		const r = await (RUN[m.name] ?? (async () => null))(m, u, signal);
		if (r && r.text.length > 80) return r;
	} catch {
		return null; // adapter exists but failed — generic path is more honest than an error
	}
	return null;
}
