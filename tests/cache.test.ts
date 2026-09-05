import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { installFetchMocks } from "./helpers.ts";
import { createDiskBackedCache } from "../lib/cache.ts";

beforeEach(() => {
	installFetchMocks(); // HOME sandbox side effect; no fetch needed here
});

test("disk cache: set/get roundtrip", () => {
	const c = createDiskBackedCache({ name: `t-roundtrip-${Date.now()}`, maxEntries: 8, ttlMs: 60_000 });
	c.set("k1", { a: 1 });
	assert.deepEqual(c.get("k1"), { a: 1 });
});

test("disk cache: same-key overwrite", () => {
	const c = createDiskBackedCache({ name: `t-overwrite-${Date.now()}`, maxEntries: 8, ttlMs: 60_000 });
	c.set("k", "v1");
	c.set("k", "v2");
	assert.equal(c.get("k"), "v2");
});

test("disk cache: ttl expiry", async () => {
	const c = createDiskBackedCache({ name: `t-ttl-${Date.now()}`, maxEntries: 8, ttlMs: 30 });
	c.set("k", "v");
	assert.equal(c.get("k"), "v");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(c.get("k"), null);
});

test("disk cache: maxEntries eviction drops the oldest", () => {
	const c = createDiskBackedCache({ name: `t-evict-${Date.now()}`, maxEntries: 3, ttlMs: 60_000 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("c", 3);
	c.set("d", 4); // evicts "a" (strictly increasing at-stamps make order stable)
	assert.equal(c.get("a"), null);
	assert.equal(c.get("d"), 4);
	assert.equal(c.get("c"), 3);
});

test("disk cache: persistence across instances on the same name", () => {
	const name = `t-persist-${Date.now()}`;
	const c1 = createDiskBackedCache({ name, maxEntries: 8, ttlMs: 60_000 });
	c1.set("pk", { persisted: true });
	c1.flushSync();
	const c2 = createDiskBackedCache({ name, maxEntries: 8, ttlMs: 60_000 });
	assert.deepEqual(c2.get("pk"), { persisted: true });
});

test("disk cache: corrupt snapshot file starts fresh, does not throw", () => {
	// write garbage directly into the snapshot path via a second instance's file
	const name = `t-corrupt-${Date.now()}`;
	const c1 = createDiskBackedCache({ name, maxEntries: 8, ttlMs: 60_000 });
	c1.set("x", 1);
	c1.flushSync();
	// corrupt it
	const file = join(homedir(), ".pi", "agent", "cache", "webfind", `${name}.json`);
	writeFileSync(file, '[["a",{"at":1,"value":2}], BROKEN');
	const c2 = createDiskBackedCache({ name, maxEntries: 8, ttlMs: 60_000 });
	assert.equal(c2.get("x"), null); // discarded, no throw
	c2.set("y", 2); // and still usable
	assert.equal(c2.get("y"), 2);
});

test("disk cache: one process-level exit handler for any number of instances", () => {
	const before = process.listenerCount("exit");
	const made = Array.from({ length: 5 }, (_, i) =>
		createDiskBackedCache({ name: `t-listeners-${Date.now()}-${i}`, maxEntries: 4, ttlMs: 60_000 }));
	// the exit-handler registry means N instances add ZERO extra listeners
	assert.equal(process.listenerCount("exit"), before);
});

test("disk cache: flush is atomic via .tmp rename (no orphan, load ignores .tmp)", async () => {
	const { readdirSync, existsSync, writeFileSync } = await import("node:fs");
	const name = `t-atomic-${Date.now()}`;
	const c = createDiskBackedCache({ name, maxEntries: 4, ttlMs: 60_000 });
	c.set("gk", "gv");
	c.flushSync();
	const file = join(homedir(), ".pi", "agent", "cache", "webfind", `${name}.json`);
	assert.ok(existsSync(file), "flushed file exists");
	assert.ok(!existsSync(`${file}.tmp`), "no .tmp orphan after rename");
	// a stale/garbage .tmp is never read by a fresh instance
	writeFileSync(`${file}.tmp`, "GARBAGE");
	const c2 = createDiskBackedCache({ name, maxEntries: 4, ttlMs: 60_000 });
	assert.equal(c2.get("gk"), "gv"); // last good value survives the orphaned .tmp
});
