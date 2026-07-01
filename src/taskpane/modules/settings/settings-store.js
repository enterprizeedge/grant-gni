/* global localStorage */

// Settings store — every localStorage-backed user preference in one module.
// Extracted from taskpane.js (CTO review Rec 8: decompose the monolith).
// Pure load/save logic only: no DOM, no Word API, no fetch.

export const DEFAULT_AUTHOR = "Gemini AI";
export const GLANCE_COLLAPSED_STORAGE_KEY = "glanceCollapsed";

// ── AI safety settings (CTO review Rec 7) ────────────────────────────────────
// Default is BLOCK_ONLY_HIGH: blocks only high-probability harmful content and
// almost never interferes with professional document editing. Users can opt
// into "off" (the previous hardcoded behaviour) in Advanced Settings — a
// deliberate, visible choice instead of a silent default.
export const SAFETY_SETTINGS_STANDARD = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

export const SAFETY_SETTINGS_OFF = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

export function loadSafetyMode() {
  return localStorage.getItem("geminiSafetyMode") === "off" ? "off" : "standard";
}

export function saveSafetyMode(mode) {
  localStorage.setItem("geminiSafetyMode", mode === "off" ? "off" : "standard");
}

// Returns the safetySettings array to put in a generateContent payload.
export function loadSafetySettings() {
  return loadSafetyMode() === "off" ? SAFETY_SETTINGS_OFF : SAFETY_SETTINGS_STANDARD;
}

// ── Models & system message ──────────────────────────────────────────────────
export function loadModel(type = "fast") {
  const key = type === "slow" ? "geminiModelSlow" : "geminiModelFast";
  const storedModel = localStorage.getItem(key);
  if (storedModel && storedModel.trim() !== "") {
    return storedModel;
  }
  // Defaults (valid Vertex model IDs)
  return type === "slow" ? "gemini-2.5-pro" : "gemini-2.5-flash";
}

export function saveModel(type, model) {
  const key = type === "slow" ? "geminiModelSlow" : "geminiModelFast";
  localStorage.setItem(key, model);
}

export function loadSystemMessage() {
  const storedMessage = localStorage.getItem("geminiSystemMessage");
  if (storedMessage && storedMessage.trim() !== "") {
    return storedMessage;
  }
  return "Example: You are assisting an undergraduate student with their academic paper. You must be specific, precise, and double-check all your advice and suggested changes. Maintain a cheerful and helpful tone.";
}

export function saveSystemMessage(message) {
  localStorage.setItem("geminiSystemMessage", message);
}

// ── Redline (track changes) preferences ──────────────────────────────────────
export function loadRedlineSetting() {
  const storedSetting = localStorage.getItem("redlineEnabled");
  return storedSetting !== null ? storedSetting === "true" : true; // Default to true (enabled)
}

export function saveRedlineSetting(enabled) {
  localStorage.setItem("redlineEnabled", enabled.toString());
}

export function loadRedlineAuthor() {
  const storedAuthor = localStorage.getItem("redlineAuthor");
  if (storedAuthor && storedAuthor.trim() !== "") {
    return storedAuthor;
  }
  return DEFAULT_AUTHOR; // Unified default fallback
}

export function saveRedlineAuthor(author) {
  if (author !== undefined && author !== null) {
    localStorage.setItem("redlineAuthor", author.toString());
  }
}

// ── Glance (Checklist) settings ──────────────────────────────────────────────
export function loadGlanceSettings() {
  const stored = localStorage.getItem("glanceSettings");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error("Error parsing glance settings", e);
    }
  }
  // Default fallback (unchanged from the original taskpane.js implementation)
  return [
    { id: "q1", title: "Grammar & Spelling", question: "Are there any glaring spelling or grammatical issues?" },
    { id: "q2", title: "Factual Accuracy", question: "Is this document factually accurate?" },
  ];
}

export function saveGlanceSettings(settings) {
  localStorage.setItem("glanceSettings", JSON.stringify(settings));
}

export function loadGlanceCollapsedState() {
  return localStorage.getItem(GLANCE_COLLAPSED_STORAGE_KEY) === "true";
}

export function saveGlanceCollapsedState(isCollapsed) {
  localStorage.setItem(GLANCE_COLLAPSED_STORAGE_KEY, isCollapsed.toString());
}
