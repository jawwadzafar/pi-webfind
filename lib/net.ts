// Host-level cooldown state shared by engines and the fetcher.
// WP-5 extends this with the offline flag and fetcher 429 handling.

const cooldowns = new Map<string, number>();

/** Put `host` on cooldown for `ms` milliseconds (e.g. after an HTTP 429). */
export function setHostCooldown(host: string, ms: number): void {
	cooldowns.set(host, Date.now() + ms);
}

/** Epoch ms until which `host` is cooling down (0 = not cooling). */
export function hostCooldownUntil(host: string): number {
	return cooldowns.get(host) ?? 0;
}
