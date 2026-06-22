// Advisor: turns a section of the user's proposal into grounded, evaluator-style
// suggestions. It retrieves (a) exemplar winning passages, (b) the relevant template
// criteria, and (c) the call's strategic context, then asks the LLM to critique the
// draft against them and return structured JSON.

import { retrieve } from "./retriever.js";

const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "gemini-flash-latest";

function extractJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const arr = t.match(/\[[\s\S]*\]/);
  const obj = t.match(/\{[\s\S]*\}/);
  const candidate = arr ? arr[0] : obj ? obj[0] : t;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export async function gatherGrounding({ program, section, callId }) {
  const winning = await retrieve(`exemplar ${section || ""} content for a strong proposal`, {
    topK: 3,
    filter: { program: program || null, docType: "winning-proposal", section: section || null },
  }).catch(() => []);
  const template = await retrieve(`${section || ""} evaluation criteria and required elements`, {
    topK: 2,
    filter: { program: program || null, docType: "template" },
  }).catch(() => []);
  const call = await retrieve("expected outcomes, scope and strategic intent of the call", {
    topK: 2,
    filter: { program: program || null, docType: "call", callId: callId || null },
  }).catch(() => []);
  return { winning, template, call };
}

function buildPrompt({ sectionText, program, section, grounding }) {
  const block = (label, hits) =>
    hits.length
      ? `\n## ${label}\n` + hits.map((h, i) => `[${label[0]}${i + 1}] ${h.text}`).join("\n\n")
      : `\n## ${label}\n(none retrieved)`;

  return `You are an experienced ${program || "grant"} proposal evaluator and writing coach.
A grant writer is drafting the "${section || "selected"}" section. Critique their draft
ONLY against the retrieved evaluation criteria, the funder's strategic intent, and the
exemplar passages from funded proposals below. Be specific and constructive. Do not
invent facts about their project; focus on structure, evidence, alignment to the call,
and what evaluators reward.

Return ONLY a JSON array. Each item:
{
  "issue": "what is weak or missing (short)",
  "suggestion": "concrete, actionable fix",
  "rationale": "why this matters to an evaluator / how it aligns to the call",
  "basedOn": "which retrieved source informed this (e.g. T1, W2, C1)"
}
Return 3-6 of the highest-value items, ordered by importance.
${block("CALL CONTEXT", grounding.call)}
${block("TEMPLATE CRITERIA", grounding.template)}
${block("WINNING EXEMPLARS", grounding.winning)}

## DRAFT TO REVIEW
"""${sectionText}"""`;
}

function sourcesFrom(grounding) {
  const flat = [];
  const push = (tag, hits) =>
    hits.forEach((h, i) =>
      flat.push({
        ref: `${tag}${i + 1}`,
        docType: h.metadata.docType,
        section: h.metadata.section,
        heading: h.metadata.heading,
        source: h.metadata.source,
        score: h.score,
      })
    );
  push("C", grounding.call);
  push("T", grounding.template);
  push("W", grounding.winning);
  return flat;
}

// provider: the LLM gateway provider (has generateContent(model, payload))
export async function advise({ provider, sectionText, program, section, callId }) {
  const grounding = await gatherGrounding({ program, section, callId });
  const prompt = buildPrompt({ sectionText, program, section, grounding });

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
  };
  const { status, body } = await provider.generateContent(ADVISOR_MODEL, payload);
  if (status < 200 || status >= 300) {
    throw new Error(`LLM error (${status}): ${body}`);
  }
  let suggestions = [];
  try {
    const parsed = JSON.parse(body);
    const text = parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    suggestions = extractJson(text) || [];
  } catch {
    suggestions = [];
  }
  if (!Array.isArray(suggestions)) suggestions = [];

  return {
    program: program || null,
    section: section || null,
    callId: callId || null,
    suggestions,
    sources: sourcesFrom(grounding),
  };
}
