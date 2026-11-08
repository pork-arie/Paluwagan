// Shared Gemini helper. Files starting with "_" are not exposed as Vercel routes.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
// Give up before Vercel kills the function, so callers can fall back cleanly.
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 20000);

export async function askGemini(input, schema) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set on the server");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Content-Type": "application/json",
        "Api-Revision": "2026-05-20",
      },
      body: JSON.stringify({
        model: MODEL,
        input,
        response_format: { type: "text", mime_type: "application/json", schema },
      }),
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Gemini took longer than ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const output = (data.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || [])
    .find((c) => c.type === "text");
  if (!output) throw new Error("Gemini returned no text");
  return JSON.parse(output.text);
}