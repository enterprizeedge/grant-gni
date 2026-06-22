// Markdown chunking + frontmatter parsing for the knowledge corpus.
// Splits on headings, keeps chunks reasonably sized, and propagates frontmatter
// metadata plus the nearest "[section: x]" tag onto every chunk.

const MAX_CHARS = 1200;

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: m[2] };
}

function splitLongBlock(text) {
  if (text.length <= MAX_CHARS) return [text];
  const paras = text.split(/\n{2,}/);
  const out = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > MAX_CHARS && buf) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Returns array of { text, metadata }
export function chunkDocument(raw, fileId) {
  const { meta, body } = parseFrontmatter(raw);
  const lines = body.split("\n");
  const blocks = [];
  let current = { heading: meta.title || fileId, lines: [] };
  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (current.lines.join("").trim()) blocks.push(current);
      current = { heading: line.replace(/^#{1,3}\s+/, "").trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join("").trim()) blocks.push(current);

  const chunks = [];
  let order = 0;
  for (const block of blocks) {
    const blockText = block.lines.join("\n").trim();
    if (!blockText) continue;
    const sectionTag = blockText.match(/\[section:\s*([a-z-]+)\]/i);
    const section = sectionTag ? sectionTag[1].toLowerCase() : meta.section || null;
    for (const piece of splitLongBlock(blockText)) {
      chunks.push({
        text: `${block.heading}\n${piece}`.trim(),
        metadata: {
          program: meta.program || null,
          docType: meta.docType || null,
          section,
          callId: meta.callId || null,
          title: meta.title || null,
          heading: block.heading,
          source: meta.source || fileId,
          fileId,
          chunkIndex: order++,
        },
      });
    }
  }
  return chunks;
}
