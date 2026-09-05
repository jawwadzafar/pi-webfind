/**
 * SSRF-safe URL validation: protocol/credential/name checks plus DNS
 * resolution — a public-looking name that resolves to a private address is
 * rejected (nip.io / lvh.me style bypasses), and redirect hops are re-checked
 * by the fetcher before each new connection.
 *
 * Residual risk (documented, deferred to WP-10): the address is validated at
 * lookup time, not pinned into the TCP connection, so a DNS-rebinding race
 * between resolveSafe() and connect() remains theoretically open. Node's
 * global fetch exposes no supported way to inject a custom dns.lookup.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** Test seam: tests replace `lookup` with a table; production leaves it alone. */
export const safeConfig: { lookup: Lookup } = { lookup: (h) => dnsLookup(h, { all: true, verbatim: true }) };

const PRIVATE = new BlockList();
for (const [net, bits] of [
	["127.0.0.0", 8],
	["10.0.0.0", 8],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["169.254.0.0", 16],
	["100.64.0.0", 10],
	["0.0.0.0", 8],
] as const)
	PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
	["::1", 128],
	["::", 128],
	["fc00::", 7],
	["fe80::", 10],
	["64:ff9b::", 96],
] as const)
	PRIVATE.addSubnet(net, bits, "ipv6");
// NOTE: deliberately NOT adding ::ffff:0:0/96 — Node compares v4-mapped IPv6
// against the v4 rules above (8.8.8.8 stays allowed, ::ffff:127.0.0.1 blocked).

const BLOCKED_NAME = /^(localhost|localhost\.localdomain)$|\.(local|internal|localhost|home\.arpa)$/i;

export function isPrivateAddress(addr: string): boolean {
	const fam = isIP(addr);
	if (fam === 0) return true; // unparseable addresses fail closed
	return PRIVATE.check(addr, fam === 6 ? "ipv6" : "ipv4");
}

/** Protocol, credentials, name and *resolved address* check. Throws `Blocked …`; returns the parsed URL. */
export async function resolveSafe(input: string | URL, lookup: Lookup = safeConfig.lookup): Promise<URL> {
	let url: URL;
	try {
		url = typeof input === "string" ? new URL(input) : input;
	} catch {
		throw new Error(`Invalid URL: ${String(input)}`);
	}
	if (!/^https?:$/.test(url.protocol)) throw new Error(`Blocked protocol: ${url.protocol} (use http/https)`);
	if (url.username || url.password) throw new Error("Blocked URL: credentials in URL");
	const host = url.hostname.replace(/\.$/, "").toLowerCase();
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (BLOCKED_NAME.test(host)) throw new Error(`Blocked host (SSRF protection): ${host}`);
	if (isIP(literal)) {
		if (isPrivateAddress(literal)) throw new Error(`Blocked host (SSRF protection): ${host}`);
		return url;
	}
	let addrs: Array<{ address: string; family: number }>;
	try {
		addrs = await lookup(host);
	} catch (e) {
		throw new Error(`DNS lookup failed for ${host} (${(e as NodeJS.ErrnoException)?.code ?? "unknown"})`);
	}
	if (addrs.length === 0) throw new Error(`DNS lookup failed for ${host} (no addresses)`);
	const bad = addrs.find((a) => isPrivateAddress(a.address));
	if (bad) throw new Error(`Blocked host (SSRF protection): ${host} resolves to ${bad.address}`);
	return url;
}

/** Synchronous subset (protocol, credentials, blocked names, literal IPs) — used for cache keys and adapter routing. */
export function assertSafeUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (!/^https?:$/.test(url.protocol)) throw new Error(`Blocked protocol: ${url.protocol} (use http/https)`);
	if (url.username || url.password) throw new Error("Blocked URL: credentials in URL");
	const host = url.hostname.replace(/\.$/, "").toLowerCase();
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (BLOCKED_NAME.test(host)) throw new Error(`Blocked host (SSRF protection): ${host}`);
	if (isIP(literal) && isPrivateAddress(literal)) throw new Error(`Blocked host (SSRF protection): ${host}`);
	return url;
}
