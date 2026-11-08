// Shared AI helper. Files starting with "_" are not exposed as Vercel routes.
// Uses Groq when GROQ_API_KEY is set (fast), otherwise Gemini.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      const err = new Error(`AI request failed (${res.status}): ${detail.slice(0, 200)}`);
      err.status = res.status;
      err.modelNotFound = res.status === 404 || /model_not_found|decommissioned/.test(detail);
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`AI took longer than ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Groq retires models regularly, so try a few in order and skip any that are gone.
const GROQ_MODELS = [
  process.env.GROQ_MODEL,
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
].filter((m, i, all) => m && all.indexOf(m) === i);

async function askGroq(input, schema) {
  let lastErr;
  for (const model of GROQ_MODELS) {
    try {
      return await askGroqModel(model, input, schema);
    } catch (e) {
      lastErr = e;
      if (!e.modelNotFound) throw e;
    }
  }
  throw lastErr;
}

async function askGroqModel(model, input, schema) {
  const data = await postJson(
    "https://api.groq.com/openai/v1/chat/completions",
    { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    {
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You reply with a single JSON object only, no extra text. " +
            "It must match this JSON schema:\n" + JSON.stringify(schema),
        },
        { role: "user", content: input },
      ],
    }
  );
  return JSON.parse(data.choices[0].message.content);
}

async function askGeminiApi(input, schema) {
  const data = await postJson(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    { "x-goog-api-key": process.env.GEMINI_API_KEY, "Api-Revision": "2026-05-20" },
    {
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      input,
      response_format: { type: "text", mime_type: "application/json", schema },
    }
  );
  const output = (data.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || [])
    .find((c) => c.type === "text");
  if (!output) throw new Error("Gemini returned no text");
  return JSON.parse(output.text);
}

// Same name as before so coach.js and agent.js don't need changes.
export async function askGemini(input, schema) {
  if (process.env.GROQ_API_KEY) {
    try {
      return await askGroq(input, schema);
    } catch (e) {
      if (!process.env.GEMINI_API_KEY) throw e;
      console.error("[ai] Groq failed, falling back to Gemini:", e.message);
    }
  }
  if (process.env.GEMINI_API_KEY) return askGeminiApi(input, schema);
  throw new Error("Set GROQ_API_KEY (or GEMINI_API_KEY) on the server");
}
