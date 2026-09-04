/**
 * Specialized search APIs — all free, no API keys required.
 *   - Stack Exchange (Stack Overflow): 300 req/day per IP, no key
 *   - Wikipedia (MediaWiki OpenSearch): unlimited reasonable use
 *   - npm registry: unlimited, no key
 *   - GitHub search: 10 req/min unauthenticated
 *   - Hacker News (Algolia): unlimited, no key
 */
import { createDiskBackedCache } from "./cache.ts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
const CACHE = createDiskBackedCache({ name: "apis", maxEntries: 256, ttlMs: 10 * 60 * 1000 });

export interface ApiResult {
	title: string;
	url: string;
	snippet: string;
	meta?: string;
}

export async function getJson<T>(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "application/json", ...headers },
		signal: combined,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
	return (await res.json()) as T;
}

// ------------------------------------------------------------- stackoverflow

interface SeItem {
	title: string;
	link: string;
	score: number;
	answer_count: number;
	is_answered: boolean;
	is_accepted?: boolean;
	tags?: string[];
	excerpt?: string;
	creation_date: number;
}

export async function searchStackOverflow(
	query: string,
	max: number,
	signal?: AbortSignal,
): Promise<ApiResult[]> {
	const key = `so:${max}:${query}`;
	const cached = CACHE.get(key);
	if (cached) return cached as ApiResult[];
	const u = new URL("https://api.stackexchange.com/2.3/search/advanced");
	u.searchParams.set("order", "desc");
	u.searchParams.set("sort", "relevance");
	u.searchParams.set("q", query);
	u.searchParams.set("site", "stackoverflow");
	u.searchParams.set("pagesize", String(Math.min(Math.max(max, 1), 30)));
	u.searchParams.set("filter", "!nNPvSNdWme"); // includes excerpt
	const data = await getJson<{ items?: SeItem[]; quota_remaining?: number; error_message?: string }>(
		u.toString(),
		signal,
	);
	if (data.error_message) throw new Error(`stackexchange: ${data.error_message}`);
	const results = (data.items ?? []).map((it) => ({
		title: it.title.replace(/"/g, '"').replace(/&#39;/g, "'").replace(/&/g, "&"),
		url: `https://stackoverflow.com/questions/${it.question_id}`,
		snippet: (it.excerpt ?? "").trim(),
		meta: `▲${it.score} · ${it.answer_count} answers${it.is_accepted ? " · ✓accepted" : ""} · [${(it.tags ?? []).slice(0, 4).join(", ")}]`,
	}));
	CACHE.set(key, results);
	return results;
}

// ---------------------------------------------------------------- wikipedia

interface WikiSearchItem {
	title: string;
	snippet: string; // contains <span class="searchmatch"> html
	pageid: number;
}

export async function searchWikipedia(
	query: string,
	max: number,
	signal?: AbortSignal,
): Promise<ApiResult[]> {
	const key = `wiki:${max}:${query}`;
	const cached = CACHE.get(key);
	if (cached) return cached as ApiResult[];
	const u = new URL("https://en.wikipedia.org/w/api.php");
	u.searchParams.set("action", "query");
	u.searchParams.set("list", "search");
	u.searchParams.set("srsearch", query);
	u.searchParams.set("srlimit", String(Math.min(Math.max(max, 1), 30)));
	u.searchParams.set("format", "json");
	const data = await getJson<{ query?: { search?: WikiSearchItem[] } }>(u.toString(), signal);
	const results = (data.query?.search ?? []).map((it) => ({
		title: it.title,
		url: `https://en.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, "_"))}`,
		snippet: it.snippet.replace(/<[^>]+>/g, "").trim(),
		meta: "wikipedia",
	}));
	CACHE.set(key, results);
	return results;
}

// ---------------------------------------------------------------------- npm

interface NpmObject {
	package: {
		name: string;
		version: string;
		description?: string;
		links?: { npm?: string };
		publisher?: { username?: string };
		date?: string;
	};
	score?: { final: number; detail: { popularity: number; quality: number; maintenance: number } };
}

export async function searchNpm(query: string, max: number, signal?: AbortSignal): Promise<ApiResult[]> {
	const key = `npm:${max}:${query}`;
	const cached = CACHE.get(key);
	if (cached) return cached as ApiResult[];
	const u = new URL("https://registry.npmjs.org/-/v1/search");
	u.searchParams.set("text", query);
	u.searchParams.set("size", String(Math.min(Math.max(max, 1), 20)));
	const data = await getJson<{ objects?: NpmObject[] }>(u.toString(), signal);
	const results = (data.objects ?? []).map((o) => ({
		title: `${o.package.name} v${o.package.version}`,
		url: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
		snippet: o.package.description ?? "",
		meta: `⭐quality ${(100 * (o.score?.detail.quality ?? 0)).toFixed(0)} · pop ${(100 * (o.score?.detail.popularity ?? 0)).toFixed(0)}`,
	}));
	CACHE.set(key, results);
	return results;
}

// -------------------------------------------------------------------- github

interface GhRepo {
	full_name: string;
	html_url: string;
	description: string | null;
	stargazers_count: number;
	language: string | null;
	updated_at: string;
}

interface GhSearchResponse {
	items?: GhRepo[];
	message?: string;
}

export async function searchGithubRepos(
	query: string,
	max: number,
	signal?: AbortSignal,
	token?: string,
): Promise<ApiResult[]> {
	const key = `gh:${max}:${query}`;
	const cached = CACHE.get(key);
	if (cached) return cached as ApiResult[];
	const u = new URL("https://api.github.com/search/repositories");
	u.searchParams.set("q", query);
	u.searchParams.set("per_page", String(Math.min(Math.max(max, 1), 30)));
	u.searchParams.set("sort", "best-match");
	const data = await getJson<GhSearchResponse>(u.toString(), signal, token ? { Authorization: `Bearer ${token}` } : {});
	if (data.message) throw new Error(`github: ${data.message}`);
	const results = (data.items ?? []).map((r) => ({
		title: r.full_name,
		url: r.html_url,
		snippet: r.description ?? "",
		meta: `★${r.stargazers_count} · ${r.language ?? "?"} · updated ${new Date(r.updated_at).toISOString().slice(0, 10)}`,
	}));
	CACHE.set(key, results);
	return results;
}

// ---------------------------------------------------------------- hackernews

interface HnHit {
	title: string | null;
	url: string | null;
	objectID: string;
	points: number | null;
	num_comments: number | null;
	story_text?: string | null;
	comment_text?: string | null;
	created_at: string;
}

export async function searchHackerNews(
	query: string,
	max: number,
	signal?: AbortSignal,
): Promise<ApiResult[]> {
	const key = `hn:${max}:${query}`;
	const cached = CACHE.get(key);
	if (cached) return cached as ApiResult[];
	const u = new URL("https://hn.algolia.com/api/v1/search");
	u.searchParams.set("query", query);
	u.searchParams.set("hitsPerPage", String(Math.min(Math.max(max, 1), 30)));
	const data = await getJson<{ hits?: HnHit[] }>(u.toString(), signal);
	const results = (data.hits ?? [])
		.filter((h) => h.title || h.story_title)
		.map((h) => ({
			title: h.title ?? h.story_title ?? "(untitled)",
			url:
				h.url ??
				(h.story_text ? `https://news.ycombinator.com/item?id=${h.objectID}` : `https://news.ycombinator.com/item?id=${h.objectID}`),
			snippet: (h.story_text ? h.story_text.replace(/<[^>]+>/g, "").slice(0, 200) : "").trim(),
			meta: `▲${h.points ?? 0} · ${h.num_comments ?? 0} comments · ${h.created_at.slice(0, 10)}`,
		}));
	CACHE.set(key, results);
	return results;
}
