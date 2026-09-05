// Host-level state shared by engines and the fetcher: per-host cooldowns
// (HTTP 429), the process-wide offline flag (ENOTFOUND/ENETUNREACH), and the
// single rate-limit gap for the r.jina.ai relay.

const cooldowns = new Map<string, number>();

/** Put `host` on cooldown for `ms` milliseconds (e.g. after an HTTP 429). */
export function setHostCooldown(host: string, ms: number): void {
	cooldowns.set(host, Date.now() + ms);
}

/** Epoch ms until which `host` is cooling down (0 = not cooling). */
export function hostCooldownUntil(host: string): number {
	return cooldowns.get(host) ?? 0;
}

// ------------------------------------------------------------- offline flag

const OFFLINE_MS = 10_000;
let offlineUntil = 0;
let offlineCode = "";

/**
 * Mark the network as offline for 10 s. Called on ENOTFOUND/ENETUNREACH from
 * the search hosts (a typo'd target host must not black out the network —
 * `markOfflineIfSearchHost` guards the single-host case).
 */
export function markOffline(code: string): void {
	offlineUntil = Date.now() + OFFLINE_MS;
	offlineCode = code;
}

/** Any successful/answered request clears the flag. */
export function markOnline(): void {
	offlineUntil = 0;
}

/** Throws while the offline flag is set (called at the top of every network fn). */
export function assertOnline(): void {
	if (Date.now() < offlineUntil) throw new Error(`network unavailable (${offlineCode})`);
}

/** True while the offline flag is set (tools surface "Network appears offline"). */
export function isOffline(): boolean {
	return Date.now() < offlineUntil;
}

/**
 * ENOTFOUND from a single non-search host is usually a typo'd URL, not an
 * outage — only search/archive infrastructure trips the process-wide flag on
 * its own (or any two distinct hosts failing within 2 s).
 */
const SEARCH_HOSTS = /^(html|lite)\.duckduckgo\.com$|^(www\.)?bing\.com$|^search\.brave\.com$|^archive\.org$|^r\.jina\.ai$/;
const recentNotFound: Array<{ host: string; at: number }> = [];

export function noteNotFound(host: string): void {
	if (SEARCH_HOSTS.test(host)) {
		markOffline("ENOTFOUND");
		return;
	}
	const now = Date.now();
	recentNotFound.push({ host, at: now });
	while (recentNotFound.length > 0 && now - recentNotFound[0]!.at > 2_000) recentNotFound.shift();
	const distinct = new Set(recentNotFound.map((r) => r.host));
	if (distinct.size >= 2) markOffline("ENOTFOUND");
}

/** Wait so that consecutive r.jina.ai requests stay ≥ `JINA_RATE_MS` apart. Single shared gap. */
let lastJinaCall = 0;
export const JINA_RATE_MS = 3_500;
export async function jinaGap(signal?: AbortSignal): Promise<void> {
	const wait = lastJinaCall + JINA_RATE_MS - Date.now();
	if (wait > 0) await sleep(wait, signal);
	lastJinaCall = Date.now();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			resolve();
		}, { once: true });
	});
}
