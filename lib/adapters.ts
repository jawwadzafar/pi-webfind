/**
 * Site adapters — route known URL shapes to a cheaper, cleaner source
 * instead of scraping HTML. Each adapter returns markdown or null
 * (null = no adapter / adapter failed → caller falls back to generic fetch).
 *
 * All free, no keys (GitHub optionally honours GITHUB_TOKEN for rate limits).
 */
import { getJson } from "./apis.ts";

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
}

type Adapter = (url: URL, signal?: AbortSignal) => Promise<AdapterResult | null>;

// ------------------------------------------------------------------- github

function ghHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	return token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" };
}

const githubAdapter: Adapter = async (url, signal) => {
	const parts = url.pathname.split("/").filter(Boolean); // [o, r, (blob|tree|issues|pull), ...]
	if (parts.length < 2) return null;
	const [owner, repo, kind, ...rest] = parts;

	// raw file: /blob/{ref}/{path...} or /raw/{ref}/{path...}
	if ((kind === "blob" || kind === "raw") && rest.length >= 2) {
		const [, ref, ...path] = [kind, rest[0], ...rest.slice(1)];
		const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`;
		const text = await getText(raw, signal);
		return { text: text.slice(0, 200_000), source: "github-raw" };
	}

	// issue / pull: API → markdown
	if (kind === "issues" || kind === "pull") {
		const num = Number(rest[0]);
		if (!num) return null;
		const isPr = kind === "pull";
		const base = `https://api.github.com/repos/${owner}/${repo}/${isPr ? "pulls" : "issues"}/${num}`;
		const item = await getJson<any>(base, signal, ghHeaders());
		let md = `# ${item.title ?? `${owner}/${repo}#${num}`}\n\n${isPr && item.message ? "" : ""}${item.body ?? "(no body)"}\n`;
		md = md.replace(/^(# .*\n\n)+/, `# ${item.title}\n\n`); // collapse stray dupes
		const comments = await getJson<any[]>(`https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments?per_page=30`, signal, ghHeaders()).catch(() => []);
		if (Array.isArray(comments) && comments.length > 0) {
			md += `\n---\n\n## Comments\n\n` + comments
				.map((c) => `**${c.user?.login ?? "?"}** (${(c.created_at ?? "").slice(0, 10)}):\n\n${c.body ?? ""}`)
				.join("\n\n---\n\n");
		}
		return { text: md.slice(0, 100_000), source: isPr ? "github-pr-api" : "github-issue-api" };
	}

	// repo root: metadata + README
	if (parts.length === 2) {
		const meta = await getJson<any>(`https://api.github.com/repos/${owner}/${repo}`, signal, ghHeaders());
		let md = `# ${meta.full_name}\n\n${meta.description ?? ""}\n\n`;
		md += `★ ${meta.stargazers_count} · ${meta.language ?? "?"} · updated ${(meta.updated_at ?? "").slice(0, 10)}\n`;
		if (meta.license?.spdx_id) md += `License: ${meta.license.spdx_id}\n`;
		if (Array.isArray(meta.topics) && meta.topics.length) md += `Tags: ${meta.topics.slice(0, 8).join(", ")}\n`;
		const branches = ["HEAD", meta.default_branch ?? "main"];
		for (const b of branches) {
			try {
				const readme = await getText(`https://raw.githubusercontent.com/${owner}/${repo}/${b}/README.md`, signal);
				md += `\n---\n\n${readme}`;
				break;
			} catch {
				/* try next branch name */
			}
		}
		return { text: md.slice(0, 120_000), source: "github-api" };
	}

	return null;
};

// ------------------------------------------------------- stackoverflow

function stripHtml(s: string): string {
	return s
		.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, c) => `\n\`\`\`\n${c.replace(/</g, "<").replace(/>/g, ">").replace(/&/g, "&")}\n\`\`\`\n`)
		.replace(/<code>([\s\S]*?)<\/code>/g, (_, c) => `\`${c.replace(/</g, "<").replace(/>/g, ">").replace(/&/g, "&")}\``)
		.replace(/<(p|br|div|li|h[1-6])[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/</g, "<")
		.replace(/>/g, ">")
		.replace(/"/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&/g, "&")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const stackOverflowAdapter: Adapter = async (url, signal) => {
	const m = url.pathname.match(/\/questions\/(\d+)/);
	if (!m) return null;
	const id = m[1];
	const q = await getJson<any>(
		`https://api.stackexchange.com/2.3/questions/${id}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=5`,
		signal,
	);
	const qData = await getJson<any>(`https://api.stackexchange.com/2.3/questions/${id}?site=stackoverflow&filter=!9Z(-wwYGT`, signal).catch(() => null);
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
};

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ----------------------------------------------------------------- hackernews

const hnAdapter: Adapter = async (url, signal) => {
	if (!/(^|\.)news\.ycombinator\.com$/.test(url.hostname)) return null;
	const id = url.searchParams.get("id");
	if (!id) return null;
	const item = await getJson<any>(`https://hn.algolia.com/api/v1/items/${id}`, signal);
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

const redditAdapter: Adapter = async (url, signal) => {
	if (!/(^|\.)reddit\.com$/.test(url.hostname) || !url.pathname.includes("/comments/")) return null;
	const data = (await getJson<any>(url.protocol + "//" + url.host + url.pathname.replace(/\/$/, "") + ".json?limit=30", signal)) as any;
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

const wikipediaAdapter: Adapter = async (url, signal) => {
	if (!/(^|\.)wikipedia\.org$/.test(url.hostname)) return null;
	const m = url.pathname.match(/^\/wiki\/([^/:#]+)$/);
	if (!m) return null;
	const title = decodeURIComponent(m[1]);
	const summary = await getJson<any>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, signal).catch(() => null);
	const apiHost = url.hostname.startsWith("en.") ? url.hostname : "en.wikipedia.org";
	const raw = await getText(`https://${apiHost}/api/rest_v1/page/html/${encodeURIComponent(title)}`, signal).catch(() => "");
	if (!raw) return null;
	// reuse the extractor's markdown conversion
	const { htmlToMarkdown } = await import("./extract.ts");
	const converted = htmlToMarkdown(raw, url.href, 200_000);
	let md = converted.text;
	if (summary?.extract && !md.includes(summary.extract.slice(0, 80))) {
		md = `${summary.extract}\n\n${md}`;
	}
	return { text: md.slice(0, 200_000), source: "wikipedia-rest" };
};

// ------------------------------------------------------------------ router

const ADAPTERS: Array<[RegExp, Adapter]> = [
	[/^github\.com$/, githubAdapter],
	[/^(www\.)?stackoverflow\.com$/, stackOverflowAdapter],
	[/^(www\.)?reddit\.com$/, redditAdapter],
	[/^news\.ycombinator\.com$/, hnAdapter],
	[/^(en\.)?wikipedia\.org$/, wikipediaAdapter],
];

/**
 * Try site adapters for a URL. Returns null when no adapter matches or all
 * fail — caller falls back to the generic HTML pipeline.
 */
export async function trySiteAdapter(url: string, signal?: AbortSignal): Promise<AdapterResult | null> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return null;
	for (const [hostRe, adapter] of ADAPTERS) {
		if (!hostRe.test(u.hostname)) continue;
		try {
			const r = await adapter(u, signal);
			if (r && r.text.length > 80) return r;
		} catch {
			return null; // adapter exists but failed — generic path is more honest than an error
		}
	}
	return null;
}
