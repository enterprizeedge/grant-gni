// Review / Advisor: grounded, evaluator-style suggestions combining
//   - tenant-private exemplars (client's own uploads), prioritised
//   - shared global knowledge (template criteria + call strategic intent)
//   - shared skills methodology (how to review)

import { retrieve } from "./retriever.js";
import { selectSkillsForReview } from "./skills.js";

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

export async function gatherGrounding({ program, section, callId, tenantId }) {
  const winning = await retrieve(`exemplar ${section || ""} content for a strong proposal`, {
    topK: 3,
    tenantId,
    filter: { program: program || null, docType: "winning-proposal", section: section || null },
  }).catch(() => []);
  const template = await retrieve(`${section || ""} evaluation criteria and required elements`, {
    topK: 2,
    tenantId,
    filter: { program: program || null, docType: "template" },
  }).catch(() => []);
  const call = await retrieve("expected outcomes, scope and strategic intent of the call", {
    topK: 2,
    tenantId,
    filter: { program: program || null, docType: "call", callId: callId || null },
  }).catch(() => []);
  return { winning, template, call };
}

function buildPrompt({ sectionText, program, section, grounding, skillText }) {
  const block = (label, hits) =>
    hits.length
      ? `\n## ${label}\n` + hits.map((h, i) => `[${label[0]}${i + 1}] ${h.text}`).join("\n\n")
      : `\n## ${label}\n(none retrieved)`;

  return `You are reviewing the "${section || "selected"}" section of a ${program || "grant"} proposal.

Apply the following review methodology:
${skillText}

Critique the draft ONLY against the retrieved evaluation criteria, the funder's
strategic intent, and the exemplar passages below. Do not invent facts about the
applicant's project; focus on structure, evidence, alignment to the call, and what
evaluators reward.

Return ONLY a JSON array. Each item:
{
  "issue": "what is weak or missing (short)",
  "suggestion": "concrete, actionable fix",
  "rationale": "why this matters to an evaluator / how it aligns to the call"
}
Return 3-6 of the highest-value items, ordered by importance.
${block("CALL CONTEXT", grounding.call)}
${block("TEMPLATE CRITERIA", grounding.template)}
${block("EXEMPLARS", grounding.winning)}

## DRAFT TO REVIEW
"""${sectionText}"""`;
}

export async function advise({ provider, sectionText, program, section, callId, tenantId }) {
  const grounding = await gatherGrounding({ program, section, callId, tenantId });
  const skills = selectSkillsForReview({ section });
  const prompt = buildPrompt({ sectionText, program, section, grounding, skillText: skills.text });

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
    tenantId: tenantId || null,
    skillsApplied: skills.applied,
    suggestions,
    grounding: {
      private: grounding.winning.filter((h) => h.origin === "private").length,
      global:
        grounding.winning.filter((h) => h.origin === "global").length +
        grounding.template.length +
        grounding.call.length,
    },
  };
}
