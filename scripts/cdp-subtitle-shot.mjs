// Drive the packaged renderer to a watch page, start an anime4up server, and
// capture the subtitle rendering (text + box + computed styles).
// usage: node scripts/cdp-subtitle-shot.mjs <episodeUrl>
const EP = process.argv[2] || "https://w1.anime4up.rest/episode/%D8%A7%D9%86%D9%85%D9%8A-one-piece-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-1179-%D9%85%D8%AA%D8%B1%D8%AC%D9%85%D8%A9/";
import fs from "node:fs";

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9777/json")).json();
      const page = list.find((t) => t.type === "page" && /index\.html|localhost:5173/.test(t.url || ""))
        || list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no renderer target");
}

const page = await findTarget();
console.log("[cdp] target:", page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const id = ++mid;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({}); } }, 15000);
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => { ws.onopen = r; });
await send("Runtime.enable");
await send("Page.enable");
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

console.log("[cdp] navigating to watch page…");
await evalJs(`location.hash = ${JSON.stringify("#/watch/" + encodeURIComponent(EP))}`);
await new Promise((r) => setTimeout(r, 9000));

console.log("[cdp] server buttons:", JSON.stringify(await evalJs(`Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).filter(Boolean).slice(0,20)`)));
const clicked = await evalJs(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => /anime4up1/i.test(x.innerText));
  if (!b) return "not-found";
  b.click();
  return "clicked:" + b.innerText.trim();
})()`);
console.log("[cdp]", clicked);

// Wait for the subtitle overlay to render a cue.
let info = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  info = await evalJs(`(() => {
    const ps = Array.from(document.querySelectorAll('p'));
    const el = ps.find(p => /[\\u0600-\\u06ff]/.test(p.textContent || '') && p.className.includes('text-white'));
    const v = document.querySelector('video');
    if (!el) return { found: false, videoTime: v ? v.currentTime : null, videoState: v ? v.readyState : null };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const parent = el.parentElement.getBoundingClientRect();
    return {
      found: true, text: el.textContent.slice(0, 60),
      videoTime: v ? +v.currentTime.toFixed(2) : null,
      videoH: v ? v.getBoundingClientRect().height : null,
      videoBottom: v ? v.getBoundingClientRect().bottom : null,
      textBottom: r.bottom, textTop: r.top, parentBottom: parent.bottom,
      distanceFromVideoBottom: v ? +(v.getBoundingClientRect().bottom - r.bottom).toFixed(1) : null,
      bg: cs.backgroundColor, textShadow: cs.textShadow, border: cs.border, webkitTextStroke: cs.webkitTextStrokeWidth,
      color: cs.color, fontSize: cs.fontSize,
    };
  })()`);
  if (info?.found && info.videoTime > 12) break;
}
console.log("[cdp] subtitle:", JSON.stringify(info, null, 1));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  fs.writeFileSync("C:/Users/asus/AppData/Local/Temp/opencode/desktop-subtitle.png", Buffer.from(shot.data, "base64"));
  console.log("[cdp] screenshot saved");
}
process.exit(0);
