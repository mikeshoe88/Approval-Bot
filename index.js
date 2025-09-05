// index.js — Single file Approval Bot (CommonJS)

// ── Env you need ──────────────────────────────────────────────────────────────
// Slack:
//   SLACK_APP_TOKEN       (xapp-..., app-level token, connections:write)
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
//   APPROVAL_CHANNEL_ID   = "SAME" (default) or a channel ID Cxxxxx for central approvals
//   ALLOW_ALL_CHANNELS    = "true" to respond anywhere
//   ALLOWED_CHANNEL_IDS   = "C1,C2,C3" allow-list
//   TEST_CHANNEL_ID       = "Cxxxx" single test channel
//   APPROVER_IDS          = "U1,U2" only these can approve/decline
// ───────────────────────────────────────────────────────────────────────────────

const { App } = require("@slack/bolt");
const OpenAI = require("openai");

// OpenAI client (optional; bot still works without the SLA brain)
let oai = null;
try {
  if (process.env.OPENAI_API_KEY) {
    oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
const APPROVAL_CHANNEL = (process.env.APPROVAL_CHANNEL_ID || "SAME").trim();

const ALLOW_ALL = String(process.env.ALLOW_ALL_CHANNELS || "").toLowerCase() === "true";
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TEST_CHANNEL = process.env.TEST_CHANNEL_ID || "";

const APPROVER_IDS = (process.env.APPROVER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Is the SLA brain ready?
const brainReady = !!(oai && process.env.SLA_VECTOR_STORE_ID);
console.log("SLA brain ready:", brainReady, "store:", process.env.SLA_VECTOR_STORE_ID || "none");

// ── Helpers
function inScopeChannel(channelId) {
  if (ALLOW_ALL) return true;
  if (ALLOWED_CHANNELS.length) return ALLOWED_CHANNELS.includes(channelId);
  if (TEST_CHANNEL) return channelId === TEST_CHANNEL;
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

// Lightweight logger to help debugging
app.event(/.*/, async ({ event, next }) => {
  try { console.log("EVENT:", event.type, event.channel || ""); } catch {}
  await next();
});

// ── SLA brain (single-file) — uses file_search + attachments (no extra_body)
async function askSla({ question, audience = "Crew", carrierHint = process.env.SLA_HINT || "Contractor Connection" }) {
  if (!brainReady) {
    return "SLA brain is not configured yet (need OPENAI_API_KEY and SLA_VECTOR_STORE_ID).";
  }

  const system =
    "You answer SERVPRO Team Hall SLA questions. Be concise (3–5 lines), " +
    "demo-first, checklist style. When certain, include the clause/section or filename. " +
    "Prefer carrier-specific guidance. If unsure, say so and request a clear photo and job #.";

  // 1) List files in the vector store
  const storeId = process.env.SLA_VECTOR_STORE_ID;
  const page = await oai.vectorStores.files.list(storeId, { limit: 50 });
  const fileIds = (page.data || []).map(f => f.id);
  if (!fileIds.length) {
    return "Your vector store has no processed files yet. Upload the SLA PDFs and try again.";
  }

  // 2) Ask with file_search tool + attachments
  const resp = await oai.responses.create({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Audience: ${audience}\nCarrier/Program hint: ${carrierHint}\nQuestion: ${question}`
      }
    ],
    tools: [{ type: "file_search" }],
    attachments: fileIds.map(id => ({ file_id: id, tools: [{ type: "file_search" }] }))
  });

  return resp.output_text || "I couldn’t find a clear clause—add a photo or specify the carrier/program.";
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

// 2) Button → require photo → post Approve/Decline in same or central channel
app.action("request_approval", async ({ ack, body, client }) => {
  await ack();
  console.log("ACTION: request_approval", body.container?.channel_id || "");
  try {
    const { channel, thread_ts, item } = JSON.parse(body.actions[0].value);

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

    const { permalink } = await client.chat.getPermalink({ channel, message_ts: thread_ts });

    const approvalBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${CREW} is requesting approval to remove ${item}.*\nPlease see picture, there is suspect wet material behind the wall.\n\n<${permalink}|Open original thread>`
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

    const targetChannel = APPROVAL_CHANNEL === "SAME" ? channel : APPROVAL_CHANNEL;
    if (targetChannel !== channel) await ensureInChannel(client, targetChannel);

    try {
      const msg = await client.chat.postMessage({
        channel: targetChannel,
        text: `${CREW} requests approval to remove ${item}.`,
        blocks: approvalBlocks
      });

      (globalThis._approvals ||= new Map()).set(msg.ts, { channel, thread_ts, requester: body.user.id, item });

      await client.chat.postMessage({
        channel, thread_ts,
        text: targetChannel === channel
          ? "Sent for approval in this thread’s channel. I’ll update here when there’s a decision."
          : `Sent for approval in <#${targetChannel}>. I’ll update here when there’s a decision.`
      });
    } catch (e) {
      const err = e?.data?.error || e.message;
      await client.chat.postMessage({
        channel, thread_ts,
        text: `I couldn't post in <#${targetChannel}>. Error: *${err}*.\nInvite me there and confirm the channel ID.`
      });
      throw e;
    }
  } catch (err) {
    console.error("request_approval error:", err);
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

// 4) Approver asks for more info → nudge crew
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
