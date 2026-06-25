// Extract plain text from an uploaded file buffer, by extension.
//   .txt / .md  -> utf8
//   .docx       -> unzip, read word/document.xml, strip tags to text
//   .pdf        -> digital PDF text via pdf-parse (no OCR; scanned PDFs unsupported)

import AdmZip from "adm-zip";
import path from "node:path";

export async function extractText(filename, buffer) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return buffer.toString("utf8");
  }
  if (ext === ".pdf") {
    // Digital PDFs only. Dynamic import so the module isn't required unless used.
    let pdfParse;
    try {
      pdfParse = (await import("pdf-parse")).default;
    } catch {
      throw new Error("PDF support needs the 'pdf-parse' package. Run npm install in backend/.");
    }
    const data = await pdfParse(buffer);
    const text = (data.text || "").trim();
    if (!text) {
      throw new Error("No selectable text in this PDF (it may be scanned — OCR is not enabled).");
    }
    return text;
  }
  if (ext === ".docx") {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("word/document.xml");
    if (!entry) throw new Error("Not a valid .docx (missing word/document.xml).");
    const xml = zip.readAsText(entry);
    return xml
      .replace(/<\/w:p>/g, "\n") // paragraph breaks
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<[^>]+>/g, "") // strip remaining tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  throw new Error(`Unsupported file type "${ext}". Use .pdf, .docx, .txt or .md.`);
}
