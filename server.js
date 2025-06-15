#!/usr/bin/env node
// server.js

// polyfill for WebSocket (required on Replit)
global.WebSocket = require("ws");

// keep-alive server
const keepAlive = require("./keepAlive");
keepAlive();

// deps
const fetch = require("node-fetch");
const { WebcastPushConnection } = require("tiktok-live-connector");

// config
const streamers = ["moneybooty", "ftm_frag_it"];
const webhook = process.env.WEBHOOK_URL;
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;

// in-memory state
const liveStatus = {
  moneybooty: { tiktok: false, twitch: false, timeout: null },
  ftm_frag_it: { tiktok: false, twitch: false, timeout: null },
};

// structured logger
function log(platform, level, user, msg = "") {
  console.log(
    `[${new Date().toISOString()}] ` +
      `[${platform}] ` +
      `[${level}] ` +
      `@${user}` +
      (msg ? ` — ${msg}` : ""),
  );
}

// send a Discord webhook
async function sendNotification(username) {
  const { tiktok: t, twitch: tw } = liveStatus[username];
  let content = "";

  if (t && tw) {
    content =
      `🚨 **@${username} is now live on Twitch & TikTok!**\n` +
      `🔴 Twitch: https://twitch.tv/${username}\n` +
      `🎥 TikTok: https://www.tiktok.com/@${username}/live`;
  } else if (tw) {
    content = `🔴 **@${username} is live on Twitch!** https://twitch.tv/${username}`;
  } else if (t) {
    content = `🎥 **@${username} is live on TikTok!** https://www.tiktok.com/@${username}/live`;
  } else {
    return;
  }

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  log("DISCORD", "NOTIFY", username);
}

// batch notifications for 90 s across platforms
function debounceNotify(username, platform) {
  liveStatus[username][platform] = true;
  if (liveStatus[username].timeout) return;
  liveStatus[username].timeout = setTimeout(() => {
    sendNotification(username);
    liveStatus[username].timeout = null;
  }, 90_000);
}

// — TikTok via connector, with explicit offline status —
streamers.forEach((username) => {
  const conn = new WebcastPushConnection(username);

  conn.on("streamStart", () => {
    log("TikTok", "LIVE", username);
    debounceNotify(username, "tiktok");
  });

  conn.on("streamEnd", () => {
    liveStatus[username].tiktok = false;
    log("TikTok", "INFO", username, "stream ended");
  });

  async function tryConnect() {
    log("TikTok", "INFO", username, "connecting…");
    try {
      await conn.connect();
      log("TikTok", "SUCCESS", username, "watching");
    } catch {
      log("TikTok", "STATUS", username, "live=false");
    } finally {
      setTimeout(tryConnect, 30_000);
    }
  }

  tryConnect();
});

// — Twitch REST polling —
let twitchAccessToken = null;

async function refreshTwitchToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token` +
      `?client_id=${twitchClientId}` +
      `&client_secret=${twitchClientSecret}` +
      `&grant_type=client_credentials`,
    { method: "POST" },
  );
  twitchAccessToken = (await res.json()).access_token;
}

async function checkTwitch(username) {
  if (!twitchAccessToken) await refreshTwitchToken();
  log("Twitch", "INFO", username, "polling…");
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${username}`,
      {
        headers: {
          "Client-ID": twitchClientId,
          Authorization: `Bearer ${twitchAccessToken}`,
        },
      },
    );
    const data = await res.json();
    const isLive = Array.isArray(data.data) && data.data.length > 0;
    log("Twitch", "STATUS", username, `live=${isLive}`);
    if (isLive && !liveStatus[username].twitch) {
      log("Twitch", "LIVE", username);
      debounceNotify(username, "twitch");
    }
    liveStatus[username].twitch = isLive;
  } catch (err) {
    log("Twitch", "ERROR", username, err.message);
  }
}

// schedule & initial
setInterval(() => {
  streamers.forEach(checkTwitch);
}, 60_000);

streamers.forEach(checkTwitch);
