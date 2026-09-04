/**
 * Minimal zero-dependency PDF text extraction.
 * Handles: FlateDecode streams (zlib), raw streams, literal/hex strings,
 * Tj/TJ/'/" operators, UTF-16BE strings, octal escapes.
 * Limitations: no ToUnicode CMap parsing (subset fonts may extract imperfectly),
 * no encrypted-PDF decryption (fails gracefully).
 */
import { inflateSync, inflateRawSync } from "node:zlib";

function findStreams(data: Buffer): Array<{ dict: string; start: number; end: number }> {
	const streams: Array<{ dict: string; start: number; end: number }> = [];
	const latin = data.toString("latin1");
	let pos = 0;
	while (true) {
		const s = latin.indexOf("stream", pos);
		if (s === -1) break;
		// must be the keyword (preceded by dict end >>), not inside a word
		if ((s === 0 || !/[a-zA-Z]/.test(latin[s - 1])) && !latin.startsWith("endstream", s)) {
			const dictStart = latin.lastIndexOf("<<", s);
			const dict = dictStart >= 0 ? latin.slice(Math.max(dictStart, s - 600), s) : "";
			let body = s + 6;
			if (latin[body] === "\r") body++;
			if (latin[body] === "\n") body++;
			const e = latin.indexOf("endstream", body);
			if (e === -1) break;
			streams.push({ dict, start: body, end: e });
			pos = e + 9;
		} else {
			pos = s + 6;
		}
	}
	return streams;
}

function inflateStream(data: Buffer, start: number, end: number): Buffer | null {
	const slice = data.subarray(start, end);
	for (const fn of [inflateSync, inflateRawSync]) {
		try {
			return fn(slice);
		} catch {
			/* try next */
		}
	}
	return null;
}

function decodePdfString(raw: string): string {
	// UTF-16BE BOM
	if (raw.startsWith("\xFE\xFF")) {
		let out = "";
		for (let i = 2; i + 1 < raw.length; i += 2) {
			out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
		}
		return out;
	}
	return raw;
}

function unescapePdfString(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c !== "\\") {
			out += c;
			continue;
		}
		const n = s[++i];
		if (n === undefined) break;
		if (n === "n") out += "\n";
		else if (n === "r") out += "\r";
		else if (n === "t") out += "\t";
		else if (n === "b") out += "\b";
		else if (n === "f") out += "\f";
		else if (n >= "0" && n <= "7") {
			// up to 3 octal digits
			let oct = n;
			while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
			out += String.fromCharCode(parseInt(oct, 8));
		} else out += n; // \( \\ \) and any other escaped char
	}
	return out;
}

/** Extract readable text from decoded PDF content-stream operators. */
function extractFromContent(content: string): string[] {
	const lines: string[] = [];
	let current = "";
	// token scan
	const re =
		/\((?:\\.|[^\\()])*\)\s*Tj|\<[0-9A-Fa-f\s]+\>\s*Tj|\[(?:[^\][]|\\.)*\]\s*TJ|T\*|Td|TD|Tm|ET|'(?:\s*(?:\\.|[^\\()])*\))?|"(?:\s*(?:\\.|[^\\()])*\s*(?:\\.|[^\\()])*\s*(?:\\.|[^\\()])*)?|BT/g;
	let m: RegExpExecArray | null;
	const flush = () => {
		const t = current.trim();
		if (t) lines.push(t);
		current = "";
	};
	while ((m = re.exec(content))) {
		const tok = m[0];
		if (tok === "T*" || tok === "Td" || tok === "TD" || tok === "Tm" || tok === "ET" || tok === "BT") {
			flush();
			continue;
		}
		let text = "";
		if (tok.startsWith("(")) {
			// find the raw string inside ( ... ) including escapes up to Tj
			const inner = tok.slice(1, tok.lastIndexOf(")"));
			text = decodePdfString(unescapePdfString(inner));
		} else if (tok.startsWith("<")) {
			const hex = tok.slice(1, tok.lastIndexOf(">")).replace(/[^0-9A-Fa-f]/g, "");
			let s = "";
			for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
			text = decodePdfString(s);
		} else if (tok.startsWith("[")) {
			// TJ array: concatenate literal strings; large negative offsets = spacing
			const inner = tok.slice(1, tok.lastIndexOf("]"));
			for (const sm of inner.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
				const raw = sm[0].slice(1, -1);
				text += decodePdfString(unescapePdfString(raw));
			}
		} else if (tok.startsWith("'") || tok.startsWith('"')) {
			flush();
			// strings in '/" handled by following Tj tokens; treat as newline
			continue;
		}
		if (text) current += text;
	}
	flush();
	return lines;
}

/** Extract PDF text: poppler's pdftotext if installed (best quality), else internal extractor. */
export async function extractPdf(bytes: Buffer): Promise<string> {
	if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
	const viaPoppler = await extractPdfViaPoppler(bytes);
	if (viaPoppler) return viaPoppler;

	const streams = findStreams(bytes);
	const chunks: string[] = [];
	for (const st of streams) {
		if (/\/Filter\s*\[^\]]*FlateDecode/i.test(st.dict) || /\/Filter\s*\/Fl\b/i.test(st.dict)) {
			const inflated = inflateStream(bytes, st.start, st.end);
			if (inflated) chunks.push(inflated.toString("latin1"));
		} else if (!/\/Filter/.test(st.dict)) {
			chunks.push(bytes.subarray(st.start, st.end).toString("latin1"));
		}
	}
	if (chunks.length === 0) throw new Error("no readable PDF content streams (encrypted or image-only PDF?)");
	const all = chunks.join("\n");
	const lines = extractFromContent(all);
	if (lines.length === 0) throw new Error("PDF parsed but no text found (scanned/image PDF?)");
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** pdftotext with stdin — used when poppler is installed (best quality). */
export async function extractPdfViaPoppler(bytes: Buffer): Promise<string | null> {
	try {
		const { spawn } = await import("node:child_process");
		return await new Promise<string>((resolve, reject) => {
			const child = spawn("pdftotext", ["-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
			let out = "";
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("pdftotext timeout"));
			}, 20_000);
			child.stdout.on("data", (d) => (out += d.toString()));
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && out.trim().length > 0) resolve(out);
				else reject(new Error(`pdftotext exited ${code}`));
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.stdin.write(bytes);
			child.stdin.end();
		});
	} catch {
		return null;
	}
}
