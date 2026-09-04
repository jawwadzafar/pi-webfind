/** Generic TTL + LRU cache used across engines, APIs and the fetcher. */
export function createTtlCache(maxEntries: number, ttlMs: number) {
	const map = new Map<string, { at: number; value: unknown }>();
	return {
		get(key: string): unknown | null {
			const hit = map.get(key);
			if (!hit) return null;
			if (Date.now() - hit.at > ttlMs) {
				map.delete(key);
				return null;
			}
			// LRU refresh
			map.delete(key);
			map.set(key, hit);
			return hit.value;
		},
		set(key: string, value: unknown) {
			if (map.size >= maxEntries) {
				const oldest = map.keys().next().value;
				if (oldest) map.delete(oldest);
			}
			map.set(key, { at: Date.now(), value });
		},
	};
}
