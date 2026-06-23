/* global Word, document, fetch, FileReader, navigator */

// Grant Gni — Review panel.
// Reviews the current section of the proposal against the client's own uploaded
// proposals (private KB), the shared program template/call context, and the shared
// review skills. Results open in a popup with a Copy button. Also lets the client
// upload documents into their own isolated knowledge base (upload-only, no connectors).

//let resolveBackendUrl = () => "https://localhost:3001";
let resolveBackendUrl = () => "https://grant-gni-backend-418969920062.europe-west1.run.app";
const el = (id) => document.getElementById(id);

function backendBase() {
  return resolveBackendUrl().replace(/\/+$/, "");
}

// --- tenant (client) identity -------------------------------------------------
// Until sign-in exists, the client id is stored locally. Auth will later bind this
// to the authenticated organisation so it cannot be spoofed.
function getTenantId() {
  return (localStorage.getItem("grantGniTenantId") || "demo").trim() || "demo";
}
function setTenantId(v) {
  if (v && v.trim()) localStorage.setItem("grantGniTenantId", v.trim());
}

function showReviewView() {
  const main = el("main-view");
  const settings = el("settings-view");
  const view = el("advisor-view");
  if (main) main.style.display = "none";
  if (settings) settings.style.display = "none";
  if (view) {
    // Clear any leftover transition class so the panel is fully opaque/clickable.
    view.classList.remove("view-hidden");
    view.classList.add("view-container");
    view.style.display = "block";
  }
  refreshKbStatus();
}
function hideReviewView() {
  const view = el("advisor-view");
  const main = el("main-view");
  if (view) view.style.display = "none";
  if (main) {
    main.style.display = "block";
    // CRITICAL: the main view may still carry the `view-hidden` class (opacity:0,
    // pointer-events:none) from an earlier view transition. Without removing it,
    // chat + checklist render invisibly and the pane looks blank after "Back".
    main.classList.remove("view-hidden");
    main.classList.add("view-container");
  }
  // Restore the floating top controls hidden when entering Settings/Review.
  const settingsBtn = el("settings-button");
  const refreshBtn = el("refresh-chat-button");
  if (settingsBtn) settingsBtn.style.display = "block";
  if (refreshBtn) refreshBtn.style.display = "block";
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- private knowledge base ---------------------------------------------------
async function refreshKbStatus() {
  const status = el("advisor-kb-status");
  if (!status) return;
  try {
    const res = await fetch(`${backendBase()}/api/tenant/${encodeURIComponent(getTenantId())}/status`);
    if (!res.ok) {
      status.textContent = "";
      return;
    }
    const d = await res.json();
    const size = d.tenant ? d.tenant.size : 0;
    const files = (d.uploads || []).length;
    status.textContent = `Your knowledge base: ${files} document(s), ${size} indexed passage(s).`;
  } catch {
    status.textContent = "";
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Could not read file"));
    fr.readAsDataURL(file);
  });
}

async function uploadDocument() {
  const input = el("advisor-file");
  const status = el("advisor-kb-status");
  const btn = el("advisor-upload");
  if (!input || !input.files || input.files.length === 0) {
    if (status) status.textContent = "Choose a .docx, .txt or .md file first.";
    return;
  }
  const file = input.files[0];
  const program = el("advisor-program") ? el("advisor-program").value : "horizon-europe";
  const docType = el("advisor-doctype") ? el("advisor-doctype").value : "winning-proposal";
  const section = el("advisor-section") ? el("advisor-section").value : "";
  if (btn) btn.disabled = true;
  if (status) status.textContent = `Uploading and indexing "${file.name}"…`;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const res = await fetch(`${backendBase()}/api/tenant/${encodeURIComponent(getTenantId())}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, contentBase64: dataUrl, program, docType, section: section || null }),
    });
    const d = await res.json();
    if (!res.ok) {
      if (status) status.textContent = `Upload failed: ${d.error ? d.error.message : res.status}`;
      return;
    }
    input.value = "";
    await refreshKbStatus();
  } catch (err) {
    if (status) status.textContent = `Upload error: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- review -------------------------------------------------------------------
async function readCurrentSection() {
  let text = "";
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
    }
  });
  if (text.length > 12000) text = text.slice(0, 12000);
  return text;
}

function suggestionsToHtml(suggestions) {
  if (!suggestions.length) {
    return `<p>No suggestions returned. Try selecting a specific section.</p>`;
  }
  return suggestions
    .map(
      (s, i) => `
      <div class="review-card">
        <div class="review-issue">${i + 1}. ${escapeHtml(s.issue)}</div>
        <div class="review-suggestion">${escapeHtml(s.suggestion)}</div>
        <div class="review-rationale">${escapeHtml(s.rationale)}</div>
      </div>`
    )
    .join("");
}

function suggestionsToPlainText(result) {
  const header = `Grant Gni review${result.section ? " — " + result.section : ""}${
    result.program ? " (" + result.program + ")" : ""
  }\n\n`;
  const body = (result.suggestions || [])
    .map(
      (s, i) =>
        `${i + 1}. ${s.issue}\n   Suggestion: ${s.suggestion}\n   Why it matters: ${s.rationale}`
    )
    .join("\n\n");
  return header + body;
}

function openModal(result) {
  const modal = el("advisor-modal");
  const body = el("advisor-modal-body");
  if (!modal || !body) return;
  body.innerHTML = suggestionsToHtml(result.suggestions || []);
  modal.dataset.plain = suggestionsToPlainText(result);
  modal.style.display = "flex";
}
function closeModal() {
  const modal = el("advisor-modal");
  if (modal) modal.style.display = "none";
}

async function copyResults() {
  const modal = el("advisor-modal");
  const btn = el("advisor-modal-copy");
  const text = modal ? modal.dataset.plain || "" : "";
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = old), 1500);
    }
  } catch {
    if (btn) btn.textContent = "Copy failed";
  }
}

async function runReview() {
  const runBtn = el("advisor-run");
  const status = el("advisor-run-status");
  const program = el("advisor-program") ? el("advisor-program").value : "horizon-europe";
  const section = el("advisor-section") ? el("advisor-section").value : "";
  const callId = el("advisor-call") ? el("advisor-call").value.trim() : "";

  if (runBtn) runBtn.disabled = true;
  if (status) status.textContent = "Reading your section and consulting winning proposals…";
  try {
    const text = await readCurrentSection();
    if (!text || !text.trim()) {
      if (status) status.textContent = "No text found. Type or select some content first.";
      return;
    }
    const res = await fetch(`${backendBase()}/api/advise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sectionText: text,
        program,
        section: section || null,
        callId: callId || null,
        tenantId: getTenantId(),
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Keep client-facing wording friendly; never leak raw provider 5xx text.
      if (status) {
        status.textContent =
          res.status >= 500
            ? "The review service is busy right now. Please try again in a moment."
            : `We couldn't complete the review${d.error && d.error.message ? ": " + d.error.message : "."}`;
      }
      return;
    }
    if (status) status.textContent = "";
    openModal(d);
  } catch (err) {
    if (status)
      status.textContent =
        "Couldn't reach the review service. Please check your connection and try again.";
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

export function initAdvisorPanel(config = {}) {
  if (typeof config.resolveBackendUrl === "function") resolveBackendUrl = config.resolveBackendUrl;

  const clientInput = el("advisor-client");
  if (clientInput) {
    clientInput.value = getTenantId();
    clientInput.onchange = () => {
      setTenantId(clientInput.value);
      refreshKbStatus();
    };
  }
  if (el("advisor-open")) el("advisor-open").onclick = showReviewView;
  if (el("advisor-back")) el("advisor-back").onclick = hideReviewView;
  if (el("advisor-upload")) el("advisor-upload").onclick = uploadDocument;
  if (el("advisor-run")) el("advisor-run").onclick = runReview;
  if (el("advisor-modal-close")) el("advisor-modal-close").onclick = closeModal;
  if (el("advisor-modal-copy")) el("advisor-modal-copy").onclick = copyResults;
}
