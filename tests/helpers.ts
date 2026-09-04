/**
 * Offline test harness (WP-02): a routing mock for globalThis.fetch plus a
 * sandboxed HOME so disk caches never touch the user's real cache dir.
 * Zero dependencies — plain Node builtins.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;

// Sandbox HOME at module-load time — lib modules construct their disk caches
// when first imported, which happens during test-file static imports, BEFORE
// any beforeEach runs. Import this module first in every test file.
process.env.HOME = mkdtempSync(join(tmpdir(), "piwf-home-"));

type Route = { body: string; contentType: string; status: number };
const routes = new Map<string, Route>();
const calls: string[] = [];
let mocking = false;

export function installFetchMocks(): void {
	if (mocking) return;
	mocking = true;
	routes.clear();
	calls.length = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		const r = routes.get(url);
		if (r) return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } });
		return new Response("no mock for " + url, { status: 599 });
	}) as typeof fetch;
}

export function uninstallFetchMocks(): void {
	if (!mocking) return;
	mocking = false;
	routes.clear();
	globalThis.fetch = realFetch;
	process.env.HOME = realHome;
}

/** Register a response for an exact URL (any method). */
export function mockJson(urlMatch: string, payload: unknown, status = 200): void {
	installFetchMocks();
	routes.set(urlMatch, { body: JSON.stringify(payload), contentType: "application/json", status });
}

/** Register a text response for an exact URL (any method). */
export function mockText(urlMatch: string, body: string, contentType = "text/html", status = 200): void {
	installFetchMocks();
	routes.set(urlMatch, { body, contentType, status });
}

/** URLs seen by the mocked fetch, in order. */
export function fetchCalls(): string[] {
	return [...calls];
}

/** Restore real networking for one call (live probes). */
export async function withRealFetch<T>(fn: () => Promise<T>): Promise<T> {
	const was = mocking;
	uninstallFetchMocks();
	try {
		return await fn();
	} finally {
		if (was) installFetchMocks();
	}
}
