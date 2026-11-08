// Vercel serverless function: keeps the Gemini API key on the server.
// POST /api/coach  { mode: "setup", text }            -> group settings from plain Taglish
// POST /api/coach  { mode: "status", group }          -> short Taglish status + advice

import { askGemini } from "./_gemini.js";

const SETUP_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short group name, max 32 characters" },
    contributionPhp: { type: "number", description: "Contribution per member per round, in pesos" },
    members: { type: "integer", description: "Number of members, 2 to 10" },
    schedule: { type: "string", description: "How often rounds happen, e.g. weekly every Friday" },
    explanation: {
      type: "string",
      description: "2-3 friendly sentences in Taglish explaining how this paluwagan works, including the total pot each round",
    },
  },
  required: ["name", "contributionPhp", "members", "schedule", "explanation"],
};

const STATUS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "1-2 sentences in Taglish describing where the group stands" },
    advice: { type: "string", description: "One practical next step in Taglish" },
    risk: { type: "string", enum: ["low", "medium", "high"], description: "Risk that this round gets delayed" },
  },
  required: ["summary", "advice", "risk"],
};

// The model's JSON isn't guaranteed to match the schema (Groq only enforces
// valid JSON), so fill in safe defaults for anything missing or malformed.
const textOr = (v, fallback) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const numberOr = (v, fallback) => {
  const n = Number(typeof v === "string" ? v.replace(/[^\d.]/g, "") : v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function cleanSetup(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    name: textOr(r.name, "Ipon Group").slice(0, 32),
    contributionPhp: numberOr(r.contributionPhp, 500),
    members: Math.min(10, Math.max(2, Math.round(numberOr(r.members, 5)))),
    schedule: textOr(r.schedule, "weekly"),
    explanation: textOr(r.explanation, ""),
  };
}

function cleanStatus(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const risk = String(r.risk || "").trim().toLowerCase();
  return {
    summary: textOr(r.summary, ""),
    advice: textOr(r.advice, ""),
    risk: ["low", "medium", "high"].includes(risk) ? risk : "medium",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const { mode, text, group } = req.body || {};

    if (mode === "setup") {
      if (!text || text.length > 500) return res.status(400).json({ error: "Describe your group in 1 to 500 characters" });
      const result = await askGemini(
        `You help Filipinos set up a paluwagan (rotating savings group). ` +
          `Read the description below (it may be English, Tagalog, Taglish, or Waray) and extract the settings. ` +
          `If the number of members or amount is missing, choose sensible defaults (5 members, 500 pesos). ` +
          `Members must be between 2 and 10. Keep the name under 32 characters.\n\nDescription: ${text}`,
        SETUP_SCHEMA
      );
      return res.status(200).json(cleanSetup(result));
    }

    if (mode === "status") {
      if (!group) return res.status(400).json({ error: "Missing group" });
      const result = await askGemini(
        `You are a friendly paluwagan coach. Here is the current state of a group stored on the Solana blockchain:\n` +
          JSON.stringify(group) +
          `\nExplain where the group stands and give one practical next step. Answer in casual Taglish.`,
        STATUS_SCHEMA
      );
      return res.status(200).json(cleanStatus(result));
    }

    return res.status(400).json({ error: "mode must be 'setup' or 'status'" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
