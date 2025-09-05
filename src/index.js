// src/index.js — CommonJS
const { App } = require("@slack/bolt");

/*
ENV required:
  SLACK_APP_TOKEN       (xapp-..., app-level token with connections:write)
  SLACK_BOT_TOKEN       (xoxb-..., bot token)
  SLACK_SIGNING_SECRET  (signing secret)
  TEST_CHANNEL_ID       (only respond in this channel; leave blank to reply anywhere invited)
  APPROVAL_CHANNEL_ID   (where Approve/Decline card is posted)
  CREW_NAME             (e.g., Kings)
*/

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

const TEST_CHANNEL     = process.env.TEST_CHANNEL_ID || "";
const APPROVAL_CHANNEL = process.env.APPROVAL_CHANNEL_ID || "";
const CREW             = process.env.CREW_NAME || "Crew";

// Optional: quick event logger to help debugging
app.event(/.*/, async ({ event, next }) => {
  try { console.log("EVENT:", event.type, event.channel || ""); } catch {}
  await next();
});

// Utility: pull "item" from text
function parseItem(text) {
  const m = (text || "").match(/remove\s+([a-z0-9\-\s]+)/i);
  return (m?.[1] || "item").trim();
}

// 1) Mention → ask for photo → "Request approval" button
app.event("app_mention", async ({ event, say }) => {
  try {
    if (TEST_CHANNEL && event.channel !== TEST_CHANNEL) return;

    const text = (event.text || "").replace(/<@[^>]+>/, "").trim();

    if (/remove|demo|cabinet|vanity|tear.?out/i.test(text)) {
      const item = parseItem(text);
      await say({
        thread_ts: event.ts,
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

    await say({ thread_ts: event.ts, text: "Send a photo and press *Request approval*." });
  } catch (err) {
    console.error("app_mention error:", err);
    await say({ thread_ts: event.ts, text: "I hit a snag. Try again or ping a manager." });
  }
});

// 2) Button → require photo → post Approve/Decline in approvals channel (robust + friendly errors)
app.action("request_approval", async ({ ack, body, client }) => {
  await ack();
  try {
    const { channel, thread_ts, item } = JSON.parse(body.actions[0].value);

    // Look for any image in the thread (more robust)
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
            action_id: "decline_demo", value: JSON.stringify({ channel, thread_ts, item, requester: body.user.id }) }
        ]
      }
    ];

    if (!APPROVAL_CHANNEL) {
      await client.chat.postMessage({
        channel, thread_ts,
        text: "APPROVAL_CHANNEL_ID isn't set. Ask an admin to add it in the service Variables."
      });
      return;
    }

    // Post to approvals channel — show a friendly error if it fails
    try {
      const msg = await client.chat.postMessage({
        channel: APPROVAL_CHANNEL,
        text: `${CREW} requests approval to remove ${item}.`,
        blocks: approvalBlocks
      });

      (globalThis._approvals ||= new Map()).set(msg.ts, { channel, thread_ts, requester: body.user.id, item });

      await client.chat.postMessage({
        channel, thread_ts,
        text: "Sent for approval. I’ll update here when there’s a decision."
      });
    } catch (e) {
      const err = e?.data?.error || e.message;
      await client.chat.postMessage({
        channel, thread_ts,
        text: `I couldn't post in the approvals channel (${APPROVAL_CHANNEL}). Error: *${err}*.\nMake sure I'm invited there and the channel ID is correct.`
      });
      throw e;
    }
  } catch (err) {
    console.error("request_approval error:", err);
  }
});

// 3) Approver clicks → update approval post + notify crew thread
const decide = (label) => async ({ ack, body, client }) => {
  await ack();
  try {
    const val = JSON.parse(body.actions[0].value);
    const { channel, thread_ts, requester, item } = val;

    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
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

// --- start
(async () => {
  await app.start();
  console.log("Approval Bot running (Socket Mode).");
})();
