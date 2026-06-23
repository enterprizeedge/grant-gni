// Shared skills layer (tier-2): reusable, client-agnostic methodology injected into
// the Review/Advisor prompt. Skills contain NO client data — they are "how to review"
// expertise, reused across all tenants.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, "../../skills");

let cache = null;

export function loadSkills() {
  if (cache) return cache;
  cache = {};
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR)) {
      if (!f.endsWith(".md")) continue;
      const key = f.replace(/_skill\.md$/, "").replace(/\.md$/, "");
      cache[key] = fs.readFileSync(path.join(SKILLS_DIR, f), "utf8");
    }
  }
  return cache;
}

// Select which skills to apply for a Review. expert_review is always on; section hints
// pull in a specialised skill. Returns concatenated skill text.
export function selectSkillsForReview({ section } = {}) {
  const skills = loadSkills();
  const picked = ["expert_review", "drafting"];
  const s = String(section || "").toLowerCase();
  if (/(implementation|work\s*plan|risk|consortium|reporting)/.test(s)) {
    picked.push("project_reporting");
  }
  if (/(budget|finance|cost|resource)/.test(s)) {
    picked.push("finance");
  }
  const seen = new Set();
  const texts = [];
  for (const key of picked) {
    if (skills[key] && !seen.has(key)) {
      seen.add(key);
      texts.push(skills[key]);
    }
  }
  return { applied: [...seen], text: texts.join("\n\n---\n\n") };
}
