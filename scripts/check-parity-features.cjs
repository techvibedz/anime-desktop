// Desktop feature-parity smoke check: every mobile-parity feature must stay
// wired end to end. Static source assertions only — no runtime needed.
// Run: node scripts/check-parity-features.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const has = (file, needle, label) =>
  assert.ok(read(file).includes(needle), `${label}: missing "${needle}" in ${file}`);

// 1. Routes exist and are lazy-loaded.
const app = read("src/App.tsx");
for (const route of [
  "/welcome", "/forgot", "notifications", "profile", "settings", "news",
  "report", "chat", "scraper-debug", "admin/live", "admin/users",
  "admin/chats", "admin/logs",
]) {
  assert.ok(app.includes(`path="${route}"`), `App.tsx route missing: ${route}`);
}

// 2. Lifecycle wiring (presence, usage, notifications, remote log, invites).
for (const needle of ["startPresence", "startUsageSession", "startNotificationSync", "setLogUser", "takePendingInvite", "onNotificationClick"]) {
  assert.ok(app.includes(needle), `App.tsx lifecycle missing: ${needle}`);
}

// 3. Core parity modules export the expected API surface.
const modules = {
  "src/lib/notifications.ts": ["startNotificationSync", "stopNotificationSync", "getUnreadCount", "markAllRead", "clearNotifications", "maybeDailyAnimeReminder"],
  "src/lib/presence.ts": ["ADMIN_EMAILS", "isAdmin", "startPresence", "subscribeOnlineUsers"],
  "src/lib/usage.ts": ["startUsageSession", "flushUsage", "fetchAllUsage", "fetchUserDaily", "fetchUserWatchHistory"],
  "src/lib/remoteLog.ts": ["setLogUser", "remoteLog", "fetchAdminLogs"],
  "src/lib/reports.ts": ["submitReport"],
  "src/lib/adminChat.ts": ["adminOpenChat", "adminCloseChat", "adminReopenChat", "adminListChats", "sendChatMessage", "fetchMyThread"],
  "src/lib/profile.ts": ["updateProfile"],
  "src/lib/news.ts": ["fetchNewsPage", "fetchNewsArticle"],
  "src/lib/companion.ts": ["askCompanion"],
  "src/lib/aniskip.ts": ["getEpisodeSkipTimes"],
  "src/lib/playerExtras.ts": ["SLEEP_PRESETS", "nextSleepPreset"],
  "src/lib/dailyPick.ts": ["pickOfTheDay", "orderDailyPool"],
  "src/lib/recommend.ts": ["fetchForYou"],
  "src/lib/malInfo.ts": ["getMalRating", "fetchAnimeInfo", "fetchAnimeRecommendations"],
  "src/lib/relations.ts": ["fetchAnimeRelations"],
  "src/lib/homeCloudCache.ts": ["writeCloudHome", "readCloudHome"],
  "src/lib/metadataCache.ts": ["readCloudMetadata", "writeCloudMetadata"],
  "src/lib/partyInvite.ts": ["partyInviteLink", "partyShareText", "takePendingInvite"],
  "src/lib/cardLayout.ts": ["useCardLayout", "cardLayoutMetrics"],
  "src/lib/settings.ts": ["getAutoplayNext", "getAutoSkipIntro", "getPrefetchNext", "clearContentCache"],
  "src/lib/motion.ts": ["usePrefersReducedMotion"],
};
for (const [file, names] of Object.entries(modules)) {
  assert.ok(fs.existsSync(path.join(root, file)), `module missing: ${file}`);
  const src = read(file);
  for (const name of names) assert.ok(src.includes(name), `${file} missing export: ${name}`);
}

// 4. Player features integrated into Watch.
for (const needle of ["CompanionPanel", "getEpisodeSkipTimes", "nextSleepPreset", "requestPictureInPicture", "getAutoplayNext"]) {
  has("src/pages/Watch.tsx", needle, "Watch player");
}

// 5. Cloud cache wired into the API pipeline.
for (const needle of ["writeCloudHome", "readCloudHome", "readCloudMetadata", "writeCloudMetadata"]) {
  has("src/lib/api.ts", needle, "api cloud cache");
}

// 6. Shell integration (badge + offline banner + admin nav).
for (const needle of ["getUnreadCount", "offlineNotice", "NAV_ADMIN"]) {
  has("src/components/Layout.tsx", needle, "Layout shell");
}

// 7. Electron notification bridge + manual update check.
for (const needle of ["pantoufa:notify", "pantoufa:notification-click", "pantoufa:check-updates"]) {
  has("electron/main.ts", needle, "main IPC");
}
for (const needle of ["notify:", "onNotificationClick", "checkForUpdates"]) {
  has("electron/preload.ts", needle, "preload bridge");
}

console.log("ALL feature-parity checks passed");
