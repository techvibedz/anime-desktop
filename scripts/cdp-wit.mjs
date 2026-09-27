// Inspect the scraper's witanime BrowserWindow: is it real content or a CF wall?
const BASE = "http://localhost:9222";
const r = await fetch(`${BASE}/json/list`);
const list = await r.json();
const wit = list.find((t) => /witanime/.test(t.url || ""));
if (!wit) { console.log("no witanime target. targets:\n" + list.map(t=>t.type+' '+t.url).join("\n")); process.exit(0); }
console.log("[wit] url:", wit.url);
const ws = new WebSocket(wit.webSocketDebuggerUrl);
let id = 1;
const evalExpr = (expression) => new Promise((res) => {
  const myId = id++;
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { ws.removeEventListener("message", onMsg); res(m.result?.result?.value ?? m.result?.result?.description ?? JSON.stringify(m.error)); } };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
});
ws.addEventListener("open", async () => {
  console.log("title    :", await evalExpr("document.title"));
  console.log("readyState:", await evalExpr("document.readyState"));
  console.log("url      :", await evalExpr("location.href"));
  console.log("cf-wall  :", await evalExpr("/just a moment|checking your browser|cf-browser-verification|challenge-platform/i.test(document.documentElement.innerHTML)"));
  // Try several common witanime home selectors.
  console.log("selectors:", await evalExpr(`JSON.stringify({
    anime_card: document.querySelectorAll('.anime-card-container, .anime-card, .anime-list-content .hover').length,
    episodes_card: document.querySelectorAll('.episodes-card-container, .episodes-card, .anime-card-poster').length,
    img: document.querySelectorAll('img').length,
    links_anime: document.querySelectorAll('a[href*="/anime/"]').length,
    links_episode: document.querySelectorAll('a[href*="الحلقة"], a[href*="/episode/"]').length,
  })`));
  console.log("bodytext :", await evalExpr("(document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0,260)"));
  ws.close(); process.exit(0);
});
