#!/usr/bin/env node
// server.js

// load local .env in development
require('dotenv').config();

// polyfill for WebSocket (required on Replit/Koyeb)
global.WebSocket = require("ws");

const express = require("express");
const app = express();

// health check for Koyeb
app.get("/health", (_req, res) => res.sendStatus(200));

// optional: keep your root message
app.get("/", (_req, res) => res.send("Bot is alive"));

// bind to the port Koyeb provides (or 3000 locally)
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});


// deps
const fetch = require("node-fetch");
const { TikTokLiveConnection } = require("tiktok-live-connector");

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
      (msg ? ` — ${msg}` : "")
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

// batch notifications for 90s across platforms
function debounceNotify(username, platform) {
  liveStatus[username][platform] = true;
  if (liveStatus[username].timeout) return;
  liveStatus[username].timeout = setTimeout(() => {
    sendNotification(username);
    liveStatus[username].timeout = null;
  }, 90_000);
}

// — TikTok via waitUntilLive(), with error‐resilient loop —
streamers.forEach((username) => {
  (async () => {
    while (true) {
      try {
        const conn = new TikTokLiveConnection(username, {
          fetchRoomInfoOnConnect: true,
          requestOptions: {
            headers: { cookie: process.env.TIKTOK_COOKIE },
          },
          requestPollingIntervalMs: 60_000,
        });
        log("TikTok", "INFO", username, "waiting for live");
        await conn.waitUntilLive();
        log("TikTok", "LIVE", username);
        debounceNotify(username, "tiktok");
      } catch (err) {
        // catch *any* TikTok errors and keep going
        log("TikTok", "ERROR", username, err.message || err.toString());
      } finally {
        // always reset status, then pause briefly before retrying
        liveStatus[username].tiktok = false;
        log("TikTok", "INFO", username, "resetting watch loop");
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  })();
});


// — Twitch REST polling —
let twitchAccessToken = null;

async function refreshTwitchToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token` +
      `?client_id=${twitchClientId}` +
      `&client_secret=${twitchClientSecret}` +
      `&grant_type=client_credentials`,
    { method: "POST" }
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
      }
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

// schedule & initial Twitch checks
setInterval(() => {
  streamers.forEach(checkTwitch);
}, 60_000);
streamers.forEach(checkTwitch);
