#!/usr/bin/env node
// testWebhook.js

const fetch = require("node-fetch");
const webhook = process.env.WEBHOOK_URL;

if (!webhook) {
  console.error("ERROR: WEBHOOK_URL env var not set");
  process.exit(1);
}

const [, , user, platform] = process.argv;
const validUsers = ["moneybooty", "ftm_frag_it"];
const validPlatforms = ["twitch", "tiktok"];

if (!validUsers.includes(user) || !validPlatforms.includes(platform)) {
  console.error(
    "Usage: node testWebhook.js <moneybooty|ftm_frag_it> <twitch|tiktok>",
  );
  process.exit(1);
}

let content;
if (platform === "twitch") {
  content = `🔴 **@${user} is live on Twitch!** https://twitch.tv/${user}`;
} else {
  content = `🎥 **@${user} is live on TikTok!** https://www.tiktok.com/@${user}/live`;
}

console.log(`[TEST] Sending ${platform} notification for ${user}`);
fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content }),
})
  .then(() => {
    console.log("[TEST] Done");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[TEST] Error sending webhook:", err);
    process.exit(1);
  });
