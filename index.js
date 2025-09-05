// index.js — Single-file Approval Bot (CommonJS)

// ── Required env ──────────────────────────────────────────────────────────────
// Slack:
//   SLACK_APP_TOKEN       (xapp-..., app-level token with connections:write)
//   SLACK_BOT_TOKEN       (xoxb-...)
//   SLACK_SIGNING_SECRET
//
// OpenAI (for “smart” SLA Q&A):
//   OPENAI_API_KEY        (sk-...)
//   SLA_VECTOR_STORE_ID   (vs_...)
//   SLA_HINT              (optional, e.g. "Contractor Connection")
//
// Routing / gating (optional):
//   CREW_NAME             (e.g. "Kings")
//   APPROVAL_CHANNEL_ID   = channel ID Cxxxxx for central approvals  (REQUIRED)
//   ALLOWED_CHANNEL_IDS   = "C1,C2,C3" allow-list (optional; if blank, allow any job channel)
//   APPROVER_IDS          = "U1,U2" only these can approve/decline (optional)
// ───────────────────────────────────────────────────────────────────────────────

const { App } = require("@slack/bolt");
const OpenAI = require("openai");

// Accept either OPENAI_API_KEY or OPEN_API_KEY (typo-safe)
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;

let oai = null;
try {
  if (OPENAI_KEY) {
    // Force Assistants v2 explicitly
    oai = new OpenAI({
      apiKey: OPENAI_KEY,
      defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
    });
  }
} catch (e) {
  console.warn("OpenAI not initialized:", e.message);
}

// Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// ── Config
const CREW = process.env.CREW_NAME || "Crew";
const APPROVAL_CHANNEL = (process.env.APPROVAL_CHANNEL_ID || "").trim(); // REQUIRED

const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const APPROVER_IDS = (process.env.APPROVER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Is the SLA brain ready?
const brainReady = !!(oai && process.env.SLA_VECTOR_STORE_ID);
console.log("SLA brain ready:", brainReady, "store:", process.env.SLA_VECTOR_STORE_ID || "none");

// ── Helpers
// Allow anywhere unless you explicitly set ALLOWED_CHANNEL_IDS
function inScopeChannel(channelId) {
  if (ALLOWED_CHANNELS.length) return ALLOWED_CHANNELS.includes(channelId);
  return true;
}

function parseItem(text) {
  const m = (text || "").match(/remove\s+([a-z0-9\-\s]+)/i);
  if (m?.[1]) return m[1].trim();
  if (/vanity/i.test(text)) return "vanity";
  if (/cabinet/i.test(text)) return "cabinet";
  return "item";
}

async function ensureInChannel(client, channel) {
  try {
    await client.conversations.join({ channel });
  } catch (e) {
    const code = e?.data?.error;
    if (code && !["already_in_channel","method_not_supported_for_channel_type","not_in_channel"].includes(code)) {
      console.log("join warn:", code);
    }
  }
}

// Lightweight event logger
app.event(/.*/, async ({ event, next }) => {
  try { console.log("EVENT:", event.type, event.channel || ""); } catch {}
  await next();
});

// ── SLA brain (Assistants API + vector store, with caching + preflight)
let _assistantCache = { id: null, storeId: null };
const SLA_MODEL = "gpt-4.1-mini";

async function getAssistantId(system) {
  const storeId = process.env.SLA_VECTOR_STORE_ID;
  if (!oai || !storeId) throw new Error("SLA brain not configured (OPENAI_API_KEY / SLA_VECTOR_STORE_ID).");

  if (_assistantCache.id && _assistantCache.storeId === storeId) {
    return _assistantCache.id;
  }

  // Preflight: make sure the vector store is reachable in this project
  const store = await oai.vectorStores.retrieve(storeId);
  const filesReady = (store.file_counts?.completed || 0);
  console.log("Vector store OK:", store.id, "files:", filesReady);

  const asst = await oai.beta.assistants.create({
    model: SLA_MODEL,
    instructions: system,
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [storeId] } }
  });

  _assistantCache = { id: asst.id, storeId };
  return asst.id;
}

async function askSla({
  question,
  audience = "Crew",
  carrierHint = process.env.SLA_HINT || "Contractor Connection"
}) {
  if (!brainReady) {
    return "SLA brain is not configured yet (need OPENAI_API_KEY and SLA_VECTOR_STORE_ID).";
  }

  const system =
    "You answer SERVPRO Team Hall SLA questions. Be concise (3–5 lines), " +
    "demo-first, checklist style. When certain, include the clause/section or filename. " +
    "Prefer carrier-specific guidance. If unsure, say so and request a clear photo and job #.";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const assistant_id = await getAssistantId(system);

    // Create thread with the question
    const thread = await oai.beta.threads.create({
      messages: [{
        role: "user",
        content: `Audience: ${audience}\nCarrier/Program hint: ${carrierHint}\nQuestion: ${question}`
      }]
    });

    // Run and poll with progress logs + 90s guard
    let run = await oai.beta.threads.runs.create(thread.id, { assistant_id });
    const started = Date.now();
    while (!["completed", "failed", "cancelled", "expired"].includes(run.status)) {
      console.log("Assistant run status:", run.status);
      if (Date.now() - started > 90000) throw new Error("Assistant run timeout (>90s)");
      await sleep(800);
      run = await oai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    if (run.status !== "completed") throw new Error(`Assistant run ${run.status}`);

    // Read latest assistant message
    const msgs = await oai.beta.threads.messages.list(thread.id, { order: "desc", limit: 1 });
    const last = msgs.data?.[0];
    let text = "";
    for (const block of (last?.content || [])) {
      if (block.type === "text") text += block.text.value;
    }

    return text || "I couldn’t find a clear clause—try specifying the carrier/program or add a photo.";
  } catch (err) {
    console.error("askSla error (detailed):", err?.error?.message || err.message);
    return "I hit a snag reading the SLA. Check that the API key and vector store are in the *same OpenAI project*, and that the store has at least one file in Ready status.";
  }
}

// ── Triggers
const PROMPT_RE = /(remove|demo|vanity|cabinet|approval|approve)/i;

// 1) Mention → SLA answer (if ready) → offer approval button
app.event("app_mention", async ({ event, client, say }) => {
  try {
    if (!inScopeChannel(event.channel)) return;

    await ensureInChannel(client, event.channel);

    const text = (event.text || "").replace(/<@[^>]+>/, "").trim();
    const looksLikeDemo = PROMPT_RE.test(text);
    const item = parseItem(text);

    if (brainReady) {
      let answer;
      try {
        answer = await askSla({ question: text, audience: "Crew" });
      } catch (e) {
        console.error("askSla error:", e?.error?.message || e.message);
        answer = "I hit a snag reading the SLA. Double-check my API key and vector store, then try again.";
      }
      await say({ thread_ts: event.ts, text: answer });

      if (looksLikeDemo) {
        await say({
          thread_ts: event.ts,
          text: "Add a photo and press Request approval.",
          blocks: [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Request approval" },
                  action_id: "request_approval",
                  value: JSON.stringify({ channel: event.channel, thread_ts: event.ts, item })
                }
              ]
            }
          ]
        });
      }
      return;
    }

    // No brain → just prompt for photo and approval
    if (looksLikeDemo) {
      await say({
        thread_ts: event.ts,
        text:
          "Send a picture and I’ll request approval to remove. " +
          "Upload 1–2 photos here in this thread, then press Request approval.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "*Send a picture and I’ll request approval to remove.*\n" +
                "Upload 1–2 photos here in this thread, then press *Request approval*."
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Request approval" },
                action_id: "request_approval",
                value: JSON.stringify({ channel: event.channel, thread_ts: event.ts, item })
              }
            ]
          }
        ]
      });
      return;
    }

    await say({ thread_ts: event.ts, text: "Say what you need (e.g., *remove vanity*) then upload a photo and press *Request approval*." });
  } catch (err) {
    console.error("app_mention error:", err);
    await say({ thread_ts: event.ts, text: "I hit a snag. Try again or ping a manager." });
  }
});

// 2) Button → require photo → post Approve/Decline ONLY to central channel; decisions back to origin thread
app.action("request_approval", async ({ ack, body, client }) => {
  await ack();
  try {
    const { channel, thread_ts, item } = JSON.parse(body.actions[0].value);

    // Require a management approvals channel
    if (!APPROVAL_CHANNEL) {
      await client.chat.postMessage({
        channel, thread_ts,
        text: "APPROVAL_CHANNEL_ID is not set to a central channel. Ask an admin to set it in Variables."
      });
      return;
    }

    // Ensure there is at least one photo in the job thread
    const replies = await client.conversations.replies({ channel, ts: thread_ts, limit: 200 });
    const files = (replies.messages || []).flatMap(m => m.files || []);
    const firstImg = files.find(f =>
      (f.mimetype && f.mimetype.startsWith("image/")) ||
      ["jpg","jpeg","png","heic","webp"].includes((f.filetype || "").toLowerCase())
    );
    if (!firstImg) {
      await client.chat.postEphemeral({
        channel, user: body.user.id, thread_ts,
        text: "I need a photo in this thread before I can send the approval."
      });
      return;
    }

    // Build breadcrumbs: origin channel name + thread permalink
    const [{ permalink }, chanInfo] = await Promise.all([
      client.chat.getPermalink({ channel, message_ts: thread_ts }),
      client.conversations.info({ channel })
    ]);
    const originName = chanInfo?.channel?.name ? `#${chanInfo.channel.name}` : `<#${channel}>`;

    // Approval card (posted in central approvals channel)
    const approvalBlocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "Demo Approval Request", emoji: true }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${CREW} requests approval to remove:* *${item}*`
        }
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Origin:* ${originName}` },
          { type: "mrkdwn", text: `<${permalink}|Open job thread>` }
        ]
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Crew notes: suspect wet material behind the wall. Minimal demo requested for mitigation/documentation."
        }
      },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" },
            action_id: "approve_demo", value: JSON.stringify({ channel, thread_ts, item, requester: body.user.id }) },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Decline" },
            action_id: "decline_demo", value: JSON.stringify({ channel, thread_ts, item, requester: body.user.id }) },
          { type: "button", text: { type: "plain_text", text: "Ask for more info" },
            action_id: "request_more_info", value: JSON.stringify({ channel, thread_ts, item, requester: body.user.id }) }
        ]
      }
    ];

    // Join & post in the central approvals channel
    await ensureInChannel(client, APPROVAL_CHANNEL); // harmless if already in
    const msg = await client.chat.postMessage({
      channel: APPROVAL_CHANNEL,
      text: `Approval requested: remove ${item} (from ${originName})`,
      blocks: approvalBlocks
    });

    // Track mapping for decision callbacks
    (globalThis._approvals ||= new Map()).set(msg.ts, { channel, thread_ts, requester: body.user.id, item });

    // Confirm to the job thread (origin)
    await client.chat.postMessage({
      channel, thread_ts,
      text: `Sent to <#${APPROVAL_CHANNEL}> for approval. I’ll update here when there’s a decision.`
    });
  } catch (err) {
    console.error("request_approval error:", err);
    // Best-effort origin-thread error message
    try {
      const val = JSON.parse(body.actions?.[0]?.value || "{}");
      if (val.channel && val.thread_ts) {
        await client.chat.postMessage({
          channel: val.channel, thread_ts: val.thread_ts,
          text: `I couldn’t post in the approvals channel. Error: *${err?.data?.error || err.message}*.`
        });
      }
    } catch {}
  }
});

// 3) Approver clicks → update approval post + notify crew thread (with allow-list)
const decide = (label) => async ({ ack, body, client }) => {
  await ack();
  try {
    const val = JSON.parse(body.actions[0].value);
    const { channel, thread_ts, requester, item } = val;

    if (APPROVER_IDS.length && !APPROVER_IDS.includes(body.user.id)) {
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id,
        text: "Only designated approvers can take this action."
      });
      return;
    }

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `${label} recorded`, // accessibility + removes Slack warning
      blocks: [
        ...body.message.blocks.filter(b => b.type !== "actions"),
        { type: "context", elements: [{ type: "mrkdwn", text: `*${label}* by <@${body.user.id}> • ${new Date().toLocaleString()}` }] }
      ]
    });

    const verdict = label.includes("APPROVED")
      ? `Approved—proceed with *minimal demo* and full documentation for ${item}.`
      : `Declined—hold demo on ${item}.`;

    await client.chat.postMessage({ channel, thread_ts, text: verdict });
    await client.chat.postEphemeral({ channel, user: requester, thread_ts, text: `Decision on *${item}*: ${label}` });
  } catch (err) {
    console.error("decision error:", err);
  }
};

app.action("approve_demo", decide("APPROVED ✅"));
app.action("decline_demo", decide("DECLINED ❌"));

// 4) Approver asks for more info → nudge crew in the original thread
app.action("request_more_info", async ({ ack, body, client }) => {
  await ack();
  try {
    const val = JSON.parse(body.actions[0].value);
    const { channel, thread_ts, item } = val;
    await client.chat.postMessage({
      channel, thread_ts,
      text: `Need more info to decide on *${item}*:\n• Wide shot of area\n• Close-up of suspect wet material\n• Moisture reading photo (if available)\n• Note any utilities behind`
    });
  } catch (err) {
    console.error("request_more_info error:", err);
  }
});

// ── start
(async () => {
  await app.start();
  console.log("Approval Bot running (Socket Mode).");
})();
