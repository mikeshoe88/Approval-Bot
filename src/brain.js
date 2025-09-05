// src/brain.js (CommonJS)
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Ask the SLA brain a question. Returns a short, clause-backed answer.
 * Env: OPENAI_API_KEY, SLA_VECTOR_STORE_ID
 * Optional: SLA_HINT
 */
async function askSla({
  question,
  audience = "Crew",
  carrierHint = process.env.SLA_HINT || "Contractor Connection",
}) {
  const system =
    "You answer SERVPRO Team Hall SLA questions. Be concise (3–5 lines), " +
    "demo-first, checklist style. When certain, include the clause/section or filename. " +
    "Prefer carrier-specific guidance. If unsure, say so and request a clear photo and job #.";

  try {
    const resp = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: `Audience: ${audience}\nCarrier/Program hint: ${carrierHint}\nQuestion: ${question}` }
      ],
      tools: [{ type: "file_search" }],
      // IMPORTANT: tool_resources must be nested under extra_body
      extra_body: {
        tool_resources: {
          file_search: { vector_store_ids: [process.env.SLA_VECTOR_STORE_ID] }
        }
      }
    });

    return resp.output_text || "I couldn’t find a clear clause—add a photo or specify the carrier/program.";
  } catch (err) {
    console.error("askSla error:", err?.error?.message || err.message);
    return "I hit a snag reading the SLA. Double-check my API key and vector store, then try again.";
  }
}

module.exports = { askSla };
