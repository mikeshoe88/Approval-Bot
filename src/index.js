const { App } = require("@slack/bolt");
import { App } from "@slack/bolt";

/* ENV:
SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET,
TEST_CHANNEL_ID, APPROVAL_CHANNEL_ID, CREW_NAME
*/

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

const TEST = process.env.TEST_CHANNEL_ID;
const APPROVALS = process.env.APPROVAL_CHANNEL_ID;
const CREW = process.env.CREW_NAME || "Crew";

const parseItem = t => (t.match(/remove\s+([a-z0-9\-\s]+)/i)?.[1] || "item").trim();

app.event("app_mention", async ({ event, say }) => {
  if (TEST && event.channel !== TEST) return;
  const text = (event.text || "").replace(/<@[^>]+>/, "").trim();

  if (/remove|demo|cabinet|vanity|tear.?out/i.test(text)) {
    const item = parseItem(text);
    await say({
      thread_ts: event.ts,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: "*Send a picture and I’ll request approval to remove.*\nUpload 1–2 photos here in this thread, then press *Request approval*." } },
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "Request approval" },
            action_id: "request_approval",
            value: JSON.stringify({ channel: event.channel, thread_ts: event.ts, item }) }
        ]}
      ]
    });
  } else {
    await say({ thread_ts: event.ts, text: "Send a photo and press *Request approval*." });
  }
});

app.action("request_approval", async ({ ack, body, client }) => {
  await ack();
  const { channel, thread_ts, item } = JSON.parse(body.actions[0].value);

  const replies = await client.conversations.replies({ channel, ts: thread_ts, limit: 50 });
  const firstImg = replies.messages?.flatMap(m => m.files || []).find(f => f.mimetype?.startsWith("image/"));
  if (!firstImg) {
    await client.chat.postEphemeral({ channel, user: body.user.id, thread_ts,
      text: "I need a photo in this thread before I can send the approval." });
    return;
  }

  const { permalink } = await client.chat.getPermalink({ channel, message_ts: thread_ts });
  const blocks = [
    { type: "section", text: { type: "mrkdwn",
      text: `*${CREW} is requesting approval to remove ${item}.*\nPlease see picture, there is suspect wet material behind the wall.\n\n<${permalink}|Open original thread>` } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" },
        action_id: "approve_demo", value: JSON.stringify({ channel, thread_ts, item, requester: body.user.id }) },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Decline" },
        action_id: "decline_demo", value: JSON.stringify({ channel, thread_ts, item, requester: body.user.id }) }
    ]}
  ];

  const msg = await client.chat.postMessage({ channel: APPROVALS, text: `${CREW} requests approval to remove ${item}.`, blocks });
  (globalThis._approvals ||= new Map()).set(msg.ts, { channel, thread_ts, requester: body.user.id, item });
  await client.chat.postMessage({ channel, thread_ts, text: "Sent for approval. I’ll update here when there’s a decision." });
});

const decide = label => async ({ ack, body, client }) => {
  await ack();
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
};
app.action("approve_demo", decide("APPROVED ✅"));
app.action("decline_demo", decide("DECLINED ❌"));

(async () => { await app.start(); console.log("Approval Bot running (Socket Mode)."); })();
