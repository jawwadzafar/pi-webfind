import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl } from "../lib/fetcher.ts";

const BLOCKED = [
	"ftp://x.com/",
	"file:///etc/passwd",
];
const BLOCKED_HOSTS = [
	"localhost",
	"127.0.0.1",
	"10.0.0.1",
	"192.168.1.1",
	"172.16.0.1",
	"172.31.255.255",
	"169.254.1.1",
	"0.0.0.0",
	"foo.local",
	"[::1]",
	"[fc00::1]",
	"[fe80::1]",
	"100.64.0.1",
];
const ALLOWED = ["https://example.com/", "http://8.8.8.8/", "http://172.32.0.1/", "http://[2606:4700::1111]/"];

for (const url of BLOCKED) {
	test(`blocked protocol: ${url}`, () => {
		assert.throws(() => assertSafeUrl(url), /Blocked protocol/);
	});
}
for (const h of BLOCKED_HOSTS) {
	test(`blocked host: ${h}`, () => {
		assert.throws(() => assertSafeUrl(`http://${h}/x`), /Blocked host/);
	});
}
for (const url of ALLOWED) {
	test(`allowed: ${url}`, () => {
		const u = assertSafeUrl(url);
		assert.ok(u instanceof URL);
	});
}

test("loopback http server is reachable in tests (sanity)", async () => {
	const { createServer } = await import("node:http");
	const srv = createServer((_req, res) => {
		res.end("pong");
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(await res.text(), "pong");
	} finally {
		srv.close();
	}
});
