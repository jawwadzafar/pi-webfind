/**
 * Generic TTL + LRU cache used across engines, APIs and the fetcher.
 *
 * `createDiskBackedCache` adds a JSON file layer under `~/.pi/agent/cache/webfind`:
 * memory stays the hot path; disk survives restarts (search pages, fetched
 * article text). Writes are debounced and flushed on a timer + process exit.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

const DISK_LIMIT_BYTES = 8 * 1024 * 1024; // keep each snapshot small

export interface DiskBackedCache {
	get(key: string): unknown | null;
	set(key: string, value: unknown): void;
	/** Force a synchronous write (used on process exit). */
	flushSync(): void;
}

/**
 * Memory-first cache with a JSON disk snapshot. On first use, loads the disk
 * file (pruning expired entries). `set` updates memory and schedules a
 * debounced flush; process exit flushes synchronously.
 */
export function createDiskBackedCache(opts: {
	name: string; // file name without extension
	maxEntries: number;
	ttlMs: number;
	flushMs?: number;
}): DiskBackedCache {
	const map = new Map<string, { at: number; value: unknown }>();
	const dir = join(homedir(), ".pi", "agent", "cache", "webfind");
	const file = join(dir, `${opts.name}.json`);
	let loaded = false;
	let dirty = false;
	let maxAt = 0;

	const load = () => {
		if (loaded) return;
		loaded = true;
		try {
			if (!existsSync(file)) return;
			const entries = JSON.parse(readFileSync(file, "utf8")) as Array<[string, { at: number; value: unknown }]>;
			const now = Date.now();
			for (const [k, v] of entries) {
				if (typeof v?.at === "number" && typeof k === "string" && now - v.at <= opts.ttlMs) {
					map.set(k, v);
					if (v.at > maxAt) maxAt = v.at;
				}
			}
		} catch {
			// corrupt snapshot — ignore, start fresh
		}
	};

	const evict = () => {
		while (map.size >= opts.maxEntries) {
			// drop the oldest entry
			let oldestKey: string | null = null;
			let oldestAt = Infinity;
			for (const [k, v] of map) {
				if (v.at < oldestAt) {
					oldestAt = v.at;
					oldestKey = k;
				}
			}
			if (!oldestKey) break;
			map.delete(oldestKey);
		}
	};

	const flush = () => {
		if (!dirty) return;
		dirty = false;
		try {
			mkdirSync(dir, { recursive: true });
			const entries = [...map.entries()];
			const body = JSON.stringify(entries);
			if (body.length > DISK_LIMIT_BYTES) {
				// over budget: keep the newest half
				entries.sort((a, b) => b[1].at - a[1].at);
				writeFileSync(file, JSON.stringify(entries.slice(0, Math.ceil(entries.length / 2))));
			} else {
				writeFileSync(file, body);
			}
		} catch {
			// disk full/readonly — cache silently degrades to memory-only
		}
	};

	// debounced background flush
	let timer: ReturnType<typeof setTimeout> | null = null;
	const schedule = () => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			flush();
		}, opts.flushMs ?? 3_000);
		if (typeof timer === "object" && "unref" in (timer as any)) (timer as any).unref?.();
	};

	// flush on exit (best effort)
	process.on("exit", () => flush());
	try {
		process.on("SIGINT", () => {
			flush();
		});
	} catch {
		/* not always available */
	}

	return {
		get(key: string) {
			load();
			const hit = map.get(key);
			if (!hit) return null;
			if (Date.now() - hit.at > opts.ttlMs) {
				map.delete(key);
				return null;
			}
			return hit.value;
		},
		set(key: string, value: unknown) {
			load();
			evict();
			const at = Math.max(Date.now(), maxAt + 1); // strictly increasing → stable eviction order
			maxAt = at;
			map.set(key, { at, value });
			dirty = true;
			schedule();
		},
		flushSync: flush,
	};
}
