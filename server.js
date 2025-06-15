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

// prevent unhandled rejections from crashing
process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});

// deps
const fetch = require("node-fetch");
const { WebcastPushConnection } = require("tiktok-live-connector");

// config
const streamers = ["moneybooty", "ftm_frag_it"];
const webhook = process.env.WEBHOOK_URL;
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
const debugTikTok = process.env.DEBUG_TIKTOK === "true";
const debugTwitch = process.env.DEBUG_TWITCH === "true";

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

// — TikTok via WebcastPushConnection (event-driven) —
streamers.forEach((username) => {
  const conn = new WebcastPushConnection(username, {
    fetchRoomInfoOnConnect: true,
    requestOptions: {
      headers: { cookie: process.env.TIKTOK_COOKIE },
    },
  });

  // Throttle duplicate errors
  const lastErrorAt = {};

  conn.on("streamStart", () => {
    log("TikTok", "LIVE", username);
    debounceNotify(username, "tiktok");
  });

  conn.on("streamEnd", () => {
    liveStatus[username].tiktok = false;
    log("TikTok", "INFO", username, "stream ended");
  });

  conn.on("error", (err) => {
    if (!debugTikTok) return;
    const key = `${username}:${err.name}:${err.message}`;
    const now = Date.now();
    if (now - (lastErrorAt[key] || 0) < 30_000) return;
    lastErrorAt[key] = now;
    const header = `${err.name}: ${err.message}`;
    console.error(
      `[${new Date().toISOString()}] [TikTok] [ERROR] @${username} — ${header}`
    );
    console.error(err.stack);
  });

  conn.on("disconnected", () => {
    log("TikTok", "INFO", username, "disconnected—reconnecting in 30s");
    setTimeout(() => conn.connect().catch(() => {}), 30_000);
  });

  // initial connect attempt (and retry loop)
  (async function tryConnect() {
    try {
      log("TikTok", "INFO", username, "connecting…");
      await conn.connect();
      log("TikTok", "SUCCESS", username, "watching");
    } catch {
      log("TikTok", "INFO", username, "not live yet—retry in 30s");
      setTimeout(tryConnect, 30_000);
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
    if (debugTwitch) {
      console.error(
        `[${new Date().toISOString()}] [Twitch] [ERROR] @${username} — ${err.name}: ${err.message}`
      );
      console.error(err.stack);
    } else {
      log("Twitch", "ERROR", username, err.message);
    }
  }
}

// schedule & initial Twitch checks
setInterval(() => {
  streamers.forEach(checkTwitch);
}, 60_000);
streamers.forEach(checkTwitch);
