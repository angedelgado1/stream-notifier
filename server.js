#!/usr/bin/env node
// server.js

// load local .env in development
require('dotenv').config();

// polyfill for WebSocket (required on Replit/Koyeb)
global.WebSocket = require("ws");

const express = require("express");
const fetch = require("node-fetch");
const { WebcastPushConnection } = require("tiktok-live-connector");
const app = express();

// health check for Koyeb
app.get("/health", (_req, res) => res.sendStatus(200));
app.get("/", (_req, res) => res.send("Bot is alive"));

// bind to the port Koyeb provides (or 3000 locally)
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));

// prevent unhandled rejections from crashing
global.process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});

// config
const streamers = [
  { key: "moneybooty", twitch: "moneybooty", tiktok: "moneybooty" },
  { key: "ftm_frag_it", twitch: "ftm_frag_it", tiktok: "ftm.frag.it" }
];
const webhook = process.env.WEBHOOK_URL;
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
const debugTikTok = process.env.DEBUG_TIKTOK === "true";
const debugTwitch = process.env.DEBUG_TWITCH === "true";

// in-memory state
const liveStatus = streamers.reduce((acc, s) => {
  acc[s.key] = { tiktok: false, twitch: false, timeout: null };
  return acc;
}, {});

// structured logger
function log(platform, level, user, msg = "") {
  console.log(
    `[${new Date().toISOString()}] [${platform}] [${level}] @${user}` +
      (msg ? ` — ${msg}` : "")
  );
}

// send a Discord webhook
async function sendNotification(username) {
  const s = streamers.find((st) => st.key === username);
  const { tiktok: t, twitch: tw } = liveStatus[username];
  let content = "";

  if (t && tw) {
    content =
      `🚨 **@${s.key} is now live on Twitch & TikTok!**\n` +
      `🔴 Twitch: https://twitch.tv/${s.twitch}\n` +
      `🎥 TikTok: https://www.tiktok.com/@${s.tiktok}/live`;
  } else if (tw) {
    content = `🔴 **@${s.key} is live on Twitch!** https://twitch.tv/${s.twitch}`;
  } else if (t) {
    content = `🎥 **@${s.key} is live on TikTok!** https://www.tiktok.com/@${s.tiktok}/live`;
  } else {
    return;
  }

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  log("DISCORD", "NOTIFY", s.key);
}

// debounce notifications for 90s across platforms
function debounceNotify(username, platform) {
  liveStatus[username][platform] = true;
  if (liveStatus[username].timeout) return;
  liveStatus[username].timeout = setTimeout(() => {
    sendNotification(username);
    liveStatus[username].timeout = null;
  }, 90_000);
}

// — TikTok (event-driven) —
streamers.forEach(({ key, tiktok: user }) => {
  const conn = new WebcastPushConnection(user, {
    fetchRoomInfoOnConnect: true,
    requestOptions: { headers: { cookie: process.env.TIKTOK_COOKIE } },
  });

  const lastErrorAt = {};

  conn.on("streamStart", () => {
    log("TikTok", "LIVE", user);
    debounceNotify(key, "tiktok");
  });

  conn.on("streamEnd", () => {
    liveStatus[key].tiktok = false;
    log("TikTok", "INFO", user, "stream ended");
  });

  conn.on("error", (err) => {
    if (!debugTikTok) return;
    const errKey = `${user}:${err.name}:${err.message}`;
    const now = Date.now();
    if (now - (lastErrorAt[errKey] || 0) < 30_000) return;
    lastErrorAt[errKey] = now;
    console.error(
      `[${new Date().toISOString()}] [TikTok] [ERROR] @${user} — ${err.name}: ${err.message}`
    );
    console.error(err.stack);
  });

  conn.on("disconnected", () => {
    log("TikTok", "INFO", user, "disconnected—reconnecting in 30s");
    setTimeout(() => conn.connect().catch(() => {}), 30_000);
  });

  (async function tryConnect() {
    try {
      log("TikTok", "INFO", user, "connecting…");
      await conn.connect();
      log("TikTok", "SUCCESS", user, "watching");
    } catch {
      log("TikTok", "INFO", user, "not live yet—retry in 30s");
      setTimeout(tryConnect, 30_000);
    }
  })();
});

// — Twitch REST polling —
let twitchAccessToken = null;

async function refreshTwitchToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${twitchClientId}` +
      `&client_secret=${twitchClientSecret}&grant_type=client_credentials`,
    { method: "POST" }
  );
  twitchAccessToken = (await res.json()).access_token;
}

async function checkTwitch({ key, twitch: user }) {
  if (!twitchAccessToken) await refreshTwitchToken();
  log("Twitch", "INFO", user, "polling…");
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${user}`,
      { headers: { "Client-ID": twitchClientId, Authorization: `Bearer ${twitchAccessToken}` } }
    );
    const data = await res.json();
    const isLive = Array.isArray(data.data) && data.data.length > 0;
    log("Twitch", "STATUS", user, `live=${isLive}`);
    if (isLive && !liveStatus[key].twitch) {
      log("Twitch", "LIVE", user);
      debounceNotify(key, "twitch");
    }
    liveStatus[key].twitch = isLive;
  } catch (err) {
    if (debugTwitch) {
      console.error(
        `[${new Date().toISOString()}] [Twitch] [ERROR] @${user} — ${err.name}: ${err.message}`
      );
      console.error(err.stack);
    } else {
      log("Twitch", "ERROR", user, err.message);
    }
  }
}

setInterval(() => streamers.forEach(checkTwitch), 60_000);
streamers.forEach(checkTwitch);
