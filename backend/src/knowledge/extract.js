// Extract plain text from an uploaded file buffer, by extension.
//   .txt / .md  -> utf8
//   .docx       -> unzip, read word/document.xml, strip tags to text
//   .pdf        -> not yet supported (clear message; add a parser next)

import AdmZip from "adm-zip";
import path from "node:path";

export function extractText(filename, buffer) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return buffer.toString("utf8");
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
  if (ext === ".pdf") {
    throw new Error("PDF is not supported yet — please upload .docx, .txt or .md.");
  }
  throw new Error(`Unsupported file type "${ext}". Use .docx, .txt or .md.`);
}
