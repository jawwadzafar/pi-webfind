import assert from "node:assert/strict";
import { test } from "node:test";
import { braveApiSearch, tavilySearch, jinaSearchApi, multiSearch } from "../lib/engine.ts";
import { installFetchMocks, mockJson, uninstallFetchMocks } from "./helpers.ts";

test("accelerators: named errors when the env key is unset", async () => {
	const saved = { B: process.env.BRAVE_API_KEY, T: process.env.TAVILY_API_KEY, J: process.env.JINA_API_KEY };
	delete process.env.BRAVE_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.JINA_API_KEY;
	try {
		await assert.rejects(braveApiSearch("q", 5, undefined), /BRAVE_API_KEY not set/);
		await assert.rejects(tavilySearch("q", 5, undefined), /TAVILY_API_KEY not set/);
		await assert.rejects(jinaSearchApi("q", 5), /JINA_API_KEY not set/);
	} finally {
		if (saved.B) process.env.BRAVE_API_KEY = saved.B;
		if (saved.T) process.env.TAVILY_API_KEY = saved.T;
		if (saved.J) process.env.JINA_API_KEY = saved.J;
	}
});

test("accelerators: no keys → multiSearch attempts unchanged (ddg, brave, bing only)", async () => {
	const saved = { B: process.env.BRAVE_API_KEY, T: process.env.TAVILY_API_KEY, J: process.env.JINA_API_KEY };
	delete process.env.BRAVE_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.JINA_API_KEY;
	installFetchMocks();
	try {
		// every engine leg fails fast (599 unmatched) — engines/errors still report the names
		const r = await multiSearch("query", 5, undefined);
		assert.deepEqual(r.engines.filter((e) => !["ddg", "brave", "bing"].includes(e)), []);
		assert.ok(r.errors.some((e) => e.startsWith("ddg:")));
		assert.ok(r.errors.some((e) => e.startsWith("brave:")));
		assert.ok(r.errors.some((e) => e.startsWith("bing:")));
	} finally {
		uninstallFetchMocks();
		if (saved.B) process.env.BRAVE_API_KEY = saved.B;
		if (saved.T) process.env.TAVILY_API_KEY = saved.T;
		if (saved.J) process.env.JINA_API_KEY = saved.J;
	}
});

test("accelerators: BRAVE_API_KEY set → multiSearch includes brave-api ahead of ddg", async () => {
	const saved = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "test-key";
	installFetchMocks();
	try {
		// brave-api is attempted FIRST (Order in attempts) and its mocked payload succeeds
		mockJson("https://api.search.brave.com/res/v1/web/search?q=probe&count=15", {
			web: { results: [{ title: "probe reference and guide", url: "https://example.com/probe-guide", description: "probe setup notes" }] },
		});
		// braveApiSearch caps count at min(maxResults, 20) → count=15 request; multiSearch asks for 15
		const r = await multiSearch("probe", 5, undefined);
		const idxApi = r.engines.indexOf("brave-api");
		const idxDdg = r.engines.indexOf("ddg");
		assert.ok(idxApi !== -1, `brave-api missing from engines: ${r.engines}`);
		if (idxDdg !== -1) assert.ok(idxApi < idxDdg, "brave-api should precede ddg");
	} finally {
		uninstallFetchMocks();
		if (saved) process.env.BRAVE_API_KEY = saved;
		else delete process.env.BRAVE_API_KEY;
	}
});
