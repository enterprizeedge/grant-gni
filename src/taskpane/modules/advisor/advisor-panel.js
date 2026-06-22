/* global Word, document, fetch */

// Grant Gni — Advisor panel.
// A dedicated view that reviews the current section of the proposal against
// retrieved winning-proposal exemplars, the program template criteria, and the
// active call's strategic context (backend /api/advise). Self-contained: it only
// needs a way to resolve the backend base URL.

let resolveBackendUrl = () => "https://localhost:3001";

function el(id) {
  return document.getElementById(id);
}

function showAdvisorView() {
  const main = el("main-view");
  const settings = el("settings-view");
  const advisor = el("advisor-view");
  if (main) main.style.display = "none";
  if (settings) settings.style.display = "none";
  if (advisor) advisor.style.display = "block";
}

function hideAdvisorView() {
  const advisor = el("advisor-view");
  const main = el("main-view");
  if (advisor) advisor.style.display = "none";
  if (main) main.style.display = "block";
}

// Reads the user's current selection; falls back to the whole document body.
async function readCurrentSection() {
  let text = "";
  let scope = "selection";
  await Word.run(async (context) => {
    const sel = context.document.getSelection();
    sel.load("text");
    await context.sync();
    if (sel.text && sel.text.trim().length > 0) {
      text = sel.text;
    } else {
      const body = context.document.body;
      body.load("text");
      await context.sync();
      text = body.text || "";
      scope = "document";
    }
  });
  // cap very large inputs for the first slice
  if (text.length > 12000) text = text.slice(0, 12000);
  return { text, scope };
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderResults(result) {
  const out = el("advisor-results");
  if (!out) return;
  const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
  if (suggestions.length === 0) {
    out.innerHTML = `<p class="advisor-empty">No suggestions returned. Try selecting a specific section, or check that the knowledge base has been ingested.</p>`;
    return;
  }
  const items = suggestions
    .map(
      (s) => `
      <div class="advisor-card">
        <div class="advisor-issue">${escapeHtml(s.issue)}</div>
        <div class="advisor-suggestion">${escapeHtml(s.suggestion)}</div>
        <div class="advisor-rationale">${escapeHtml(s.rationale)}</div>
        ${s.basedOn ? `<div class="advisor-basedon">Based on: ${escapeHtml(s.basedOn)}</div>` : ""}
      </div>`
    )
    .join("");
  const sources = (result.sources || [])
    .map((src) => `${escapeHtml(src.ref)}: ${escapeHtml(src.docType)}${src.section ? "/" + escapeHtml(src.section) : ""} — ${escapeHtml(src.heading)}`)
    .join("<br>");
  out.innerHTML =
    items +
    (sources
      ? `<details class="advisor-sources"><summary>Grounded in ${result.sources.length} source(s)</summary><div>${sources}</div></details>`
      : "");
}

async function runAdvice() {
  const runBtn = el("advisor-run");
  const out = el("advisor-results");
  const program = el("advisor-program") ? el("advisor-program").value : "horizon-europe";
  const section = el("advisor-section") ? el("advisor-section").value : "";
  const callId = el("advisor-call") ? el("advisor-call").value.trim() : "";

  if (runBtn) runBtn.disabled = true;
  if (out) out.innerHTML = `<p class="advisor-loading">Reading your section and consulting winning proposals…</p>`;

  try {
    const { text, scope } = await readCurrentSection();
    if (!text || !text.trim()) {
      if (out) out.innerHTML = `<p class="advisor-empty">No text found. Type or select some content first.</p>`;
      return;
    }
    const url = `${resolveBackendUrl().replace(/\/+$/, "")}/api/advise`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sectionText: text,
        program,
        section: section || null,
        callId: callId || null,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (out) out.innerHTML = `<p class="advisor-error">Advisor error (${res.status}). ${escapeHtml(errText)}</p>`;
      return;
    }
    const result = await res.json();
    if (scope === "document" && out) {
      // small note that we reviewed the whole doc
      result._scopeNote = true;
    }
    renderResults(result);
  } catch (err) {
    if (out) out.innerHTML = `<p class="advisor-error">Could not reach the Advisor. Is the backend running? (${escapeHtml(err.message)})</p>`;
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

export function initAdvisorPanel(config = {}) {
  if (typeof config.resolveBackendUrl === "function") {
    resolveBackendUrl = config.resolveBackendUrl;
  }
  const openBtn = el("advisor-open");
  const backBtn = el("advisor-back");
  const runBtn = el("advisor-run");
  if (openBtn) openBtn.onclick = showAdvisorView;
  if (backBtn) backBtn.onclick = hideAdvisorView;
  if (runBtn) runBtn.onclick = runAdvice;
}
