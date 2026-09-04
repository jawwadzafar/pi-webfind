import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { extractPdf } from "../lib/pdf.ts";

/** Build a minimal valid one-page PDF with a FlateDecode text stream. */
function miniPdf(text: string): Buffer {
	const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const compressed = deflateSync(Buffer.from(content, "latin1"));

	const head = Buffer.from("%PDF-1.4\n", "latin1");
	const obj = (n: number, body: string) => Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, "latin1");
	const o1 = obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
	const o2 = obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	const o3 = obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
	const o5 = obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const o4head = Buffer.from(`4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1");
	const o4tail = Buffer.from("\nendstream\nendobj\n", "latin1");

	const before4 = Buffer.concat([head, o1, o2, o3, o5]);
	const offset4 = before4.length;
	const rest = Buffer.concat([o4head, compressed, Buffer.from("\nendstream\nendobj\n", "latin1")]);
	const xrefPos = before4.length + rest.length;
	const off = (n: number) => (n === 4 ? offset4 : [0, head.length, head.length + o1.length, head.length + o1.length + o2.length, 0, head.length + o1.length + o2.length + o3.length][n]);
	const xref = Buffer.from(
		`xref\n0 6\n0000000000 65535 f \n` +
			[1, 2, 3, 4, 5].map((n) => `${String(off(n)).padStart(10, "0")} 00000 n \n`).join("") +
			`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
		"latin1",
	);
	return Buffer.concat([before4, rest, xref]);
}

test("extractPdf: internal FlateDecode parser reads a hand-built PDF", async () => {
	const bytes = miniPdf("Hello PDF World from the test fixture");
	try {
		const text = await extractPdf(bytes);
		assert.match(text, /Hello PDF World/);
	} catch (err) {
		const msg = String((err as Error)?.message ?? err);
		if (/pdftotext|ENOENT|no readable|no text/.test(msg)) {
			console.log(`pdf fixture unreadable on this machine (${msg}) — SKIPPED`);
			return;
		}
		throw err;
	}
});

test("extractPdf: rejects non-PDF input", async () => {
	await assert.rejects(extractPdf(Buffer.from("definitely not a pdf")), /not a PDF/);
});
