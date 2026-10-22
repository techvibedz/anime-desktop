// CDP manga smoke: attach to the running dev renderer (electron . --remote-debugging-port=9777)
// and drive the manga flow end to end — hub → detail → reader — reporting what rendered.
// usage: node scripts/cdp-manga.mjs [hub|detail <hash>|reader <hash>|eval <js>|shot <file>]
import { writeFileSync } from "node:fs";

const targets = await (await fetch("http://127.0.0.1:9777/json")).json();
const page = targets.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:5173"));
if (!page) { console.error("renderer target not found"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const id = ++mid;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") console.log("[exception]", m.params.exceptionDetails?.exception?.description?.slice(0, 400));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    console.log("[console.error]", m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  }
};
await new Promise((r) => { ws.onopen = r; });
await send("Runtime.enable");
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expr, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evalJs(expr);
    if (v) return v;
    await sleep(1000);
  }
  console.log(`timeout waiting for ${label}`);
  return null;
}

const [mode = "hub", arg = ""] = process.argv.slice(2);

if (mode === "eval") { console.log(JSON.stringify(await evalJs(arg), null, 1)); process.exit(0); }
if (mode === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg || "shot.png", Buffer.from(r.data, "base64"));
  console.log("saved", arg);
  process.exit(0);
}

if (mode === "hub") {
  await evalJs(`location.hash = "#/manga"`);
  await waitFor(`document.body.innerText.includes("عالم المانجا")`, 15000, "hub mount");
  const t0 = Date.now();
  const sections = await waitFor(`(() => { const h = [...document.querySelectorAll('section h2')].map(e => e.textContent); return h.length >= 2 ? h : null; })()`, 60000, "hub sections");
  console.log(`hub sections after ${Date.now() - t0}ms:`, JSON.stringify(sections));
  const cards = await evalJs(`[...document.querySelectorAll('a[href*="/manga/title/"]')].slice(0, 6).map(a => a.getAttribute('href'))`);
  console.log("cards:", JSON.stringify(cards, null, 1));
  const imgs = await evalJs(`(() => { const all = [...document.querySelectorAll('main img')]; return { total: all.length, loaded: all.filter(i => i.complete && i.naturalWidth > 0).length, broken: all.filter(i => i.complete && i.naturalWidth === 0).map(i => i.src).slice(0, 5) }; })()`);
  console.log("images:", JSON.stringify(imgs));
  process.exit(0);
}

if (mode === "detail") {
  await evalJs(`location.hash = ${JSON.stringify(arg)}`);
  const t0 = Date.now();
  const n = await waitFor(`document.querySelectorAll('[aria-label^="الفصل "]').length || null`, 60000, "chapters");
  console.log(`chapters rendered after ${Date.now() - t0}ms:`, n);
  console.log("title:", await evalJs(`document.querySelector('main h1')?.textContent`));
  console.log("first rows:", JSON.stringify(await evalJs(`[...document.querySelectorAll('[aria-label^="الفصل "]')].slice(0, 3).map(b => b.getAttribute('aria-label'))`)));
  process.exit(0);
}

if (mode === "reader") {
  await evalJs(`location.hash = ${JSON.stringify(arg)}`);
  const t0 = Date.now();
  const n = await waitFor(`document.querySelectorAll('[data-page]').length || document.querySelector('img[alt^="الصفحة"]') && 1 || null`, 60000, "pages");
  console.log(`pages after ${Date.now() - t0}ms:`, n);
  await sleep(6000);
  const imgs = await evalJs(`(() => { const all = [...document.querySelectorAll('img[alt^="الصفحة"]')]; return { mounted: all.length, loaded: all.filter(i => i.complete && i.naturalWidth > 0).length, sample: all.slice(0, 2).map(i => i.src) }; })()`);
  console.log("page images:", JSON.stringify(imgs, null, 1));
  console.log("chrome:", await evalJs(`document.querySelector('.z-player')?.innerText?.slice(0, 200)`));
  process.exit(0);
}
