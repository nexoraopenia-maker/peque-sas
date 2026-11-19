// Generador mínimo de PDF (sin dependencias): texto monoespaciado Courier, A4 vertical, paginado. Codificación WinAnsi (acentos y ñ).
export type PdfLine = { text: string; bold?: boolean };
const W = 595, H = 842, MARGIN = 40, SIZE = 9, LEAD = 12, PER_PAGE = Math.floor((H - 2 * MARGIN) / LEAD);
export const PDF_COLS = Math.floor((W - 2 * MARGIN) / (SIZE * 0.6)); // 95 caracteres por línea

const winAnsi = (s: string): number[] => {
  const out: number[] = [];
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "(" || ch === ")") out.push(0x5c, c);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (c === 0x2014 || c === 0x2013) out.push(0x2d);
    else out.push(0x3f);
  }
  return out;
};

export function wrap(text: string, cols = PDF_COLS): string[] {
  if (text.length <= cols) return [text];
  const out: string[] = []; let rest = text;
  while (rest.length > cols) { let cut = rest.lastIndexOf(" ", cols); if (cut < cols / 2) cut = cols; out.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); }
  return [...out, rest];
}

export function renderPdf(title: string, input: PdfLine[]): Buffer {
  const lines = input.flatMap((l) => wrap(l.text).map((t) => ({ text: t, bold: l.bold })));
  const pages: PdfLine[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += PER_PAGE) pages.push(lines.slice(i, i + PER_PAGE));
  const objs: Buffer[] = []; // objeto n = objs[n-1]
  const add = (b: Buffer | string) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1")); return objs.length; };
  const fontReg = 3, fontBold = 4;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const kidsStart = 5;
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${kidsStart + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((pg, pi) => {
    const parts: Buffer[] = [];
    let y = H - MARGIN - SIZE;
    for (const l of pg) {
      parts.push(Buffer.from(`BT /${l.bold ? "F2" : "F1"} ${SIZE} Tf ${MARGIN} ${y} Td (`, "latin1"), Buffer.from(winAnsi(l.text)), Buffer.from(") Tj ET\n", "latin1"));
      y -= LEAD;
    }
    parts.push(Buffer.from(`BT /F1 7 Tf ${MARGIN} 22 Td (${Buffer.from(winAnsi(`${title} - pagina ${pi + 1} de ${pages.length}`)).toString("latin1")}) Tj ET\n`, "latin1"));
    const content = Buffer.concat(parts);
    const pageNo = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${objs.length + 2} 0 R >>`);
    void pageNo;
    add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]));
  });
  const infoNo = add(`<< /Title (${Buffer.from(winAnsi(title)).toString("latin1")}) /Producer (PequesSaaS) >>`);
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = []; let pos = chunks[0]!.length;
  objs.forEach((o, i) => { offsets.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), o, Buffer.from("\nendobj\n", "latin1")]); chunks.push(b); pos += b.length; });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}
