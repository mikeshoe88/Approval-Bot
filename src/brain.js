// src/brain.js (CommonJS)
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Ask the SLA brain a question. It pulls all file IDs from your vector store
 * and attaches them to a file_search tool call.
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
    const storeId = process.env.SLA_VECTOR_STORE_ID;
    if (!storeId) return "No vector store configured (SLA_VECTOR_STORE_ID).";

    // Pull files from the vector store
    const page = await client.vectorStores.files.list(storeId, { limit: 50 });
    const fileIds = (page.data || []).map(f => f.id);

    if (!fileIds.length) {
      return "Your vector store has no processed files yet. Upload the SLA PDFs and try again.";
    }

    // Ask with file_search + attachments
    const resp = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Audience: ${audience}\nCarrier/Program hint: ${carrierHint}\nQuestion: ${question}`
        }
      ],
      tools: [{ type: "file_search" }],
      attachments: fileIds.map(id => ({
        file_id: id,
        tools: [{ type: "file_search" }]
      }))
    });

    return resp.output_text || "I couldn’t find a clear clause—add a photo or specify the carrier/program.";
  } catch (err) {
    console.error("askSla error:", err?.error?.message || err.message);
    return "I hit a snag reading the SLA. Double-check my API key and vector store, then try again.";
  }
}

module.exports = { askSla };
