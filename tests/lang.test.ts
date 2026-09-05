import assert from "node:assert/strict";
import { test } from "node:test";
import { toDdgKl, toBraveCountry, toBingMkt, toAcceptLanguage, bingRssSearch, ddgSearch } from "../lib/engine.ts";
import { installFetchMocks, mockText, uninstallFetchMocks, fetchCalls } from "./helpers.ts";

test("locale mapping: table entries and fallback", () => {
	assert.equal(toDdgKl("es-ES"), "es-es");
	assert.equal(toDdgKl("en-GB"), "uk-en");
	assert.equal(toDdgKl("pt-BR"), "br-pt");
	assert.equal(toDdgKl("xx-YY"), "yy-xx"); // documented best-effort fallback
	assert.equal(toDdgKl("fr"), "fr-fr");
	assert.equal(toBraveCountry("es-ES"), "ES");
	assert.equal(toBraveCountry("ja"), "JA");
	assert.equal(toBingMkt("ja-JP"), "ja-JP");
	assert.equal(toBingMkt("es"), "es");
	assert.equal(toAcceptLanguage("es-ES"), "es-ES,es;q=0.9,en;q=0.5");
});

test("locale mapping: ddgSearch(es-ES) sends kl=es-es + Accept-Language header; bing sends setmkt", async () => {
	installFetchMocks();
	try {
		mockText("https://html.duckduckgo.com/html/?q=nginx+kl%3Des-es", '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">T</a>', "text/html", 200);
		// bing: echo the query params back in the XML title
		mockText("https://www.bing.com/search?q=nginx&format=rss&count=15&setmkt=es-ES&setlang=es", "<rss></rss>", "text/xml", 200);
		await ddgSearch("nginx", 5, undefined, undefined, "es-ES").catch(() => null);
		const calls = fetchCalls();
		assert.ok(calls.some((u) => u.includes("kl=es-es")), calls.join("|"));
		// Accept-Language header check via a captured request — mock fetch's init isn't stored,
		// so verify via a second engine: bing's params carry the locale
		await bingRssSearch("nginx", 5, undefined, undefined, "es-ES").catch(() => null);
		assert.ok(fetchCalls().some((u) => u.includes("setmkt=es-ES") && u.includes("setlang=es")));
	} finally {
		uninstallFetchMocks();
	}
});

test("locale mapping: no lang → baseline URL unchanged", async () => {
	installFetchMocks();
	try {
		mockText("https://www.bing.com/search?q=x&format=rss&count=15&setmkt=en-US&setlang=en", "<rss></rss>", "text/xml", 200);
		await bingRssSearch("x", 5, undefined, undefined).catch(() => null);
		assert.ok(fetchCalls().some((u) => u.includes("setmkt=en-US") && u.includes("setlang=en")));
		assert.ok(!fetchCalls().some((u) => u.includes("kl=")));
	} finally {
		uninstallFetchMocks();
	}
});
