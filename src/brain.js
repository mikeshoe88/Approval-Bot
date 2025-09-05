// src/brain.js (CommonJS)
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Ask the SLA brain a question. Returns a short, clause-backed answer.
 * Env needed: OPENAI_API_KEY, SLA_VECTOR_STORE_ID
 * Optional:   SLA_HINT (default carrier/program)
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

  const resp = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: `Audience: ${audience}\nCarrier/Program hint: ${carrierHint}\nQuestion: ${question}` },
    ],
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [process.env.SLA_VECTOR_STORE_ID] } },
  });

  return resp.output_text || "I couldn't find a clear clause—add a photo or specify the carrier/program.";
}

module.exports = { askSla };
