// CDP driver: attach to the renderer, capture console, optionally navigate.
// usage: node scripts/cdp-drive.mjs <mode> [arg]
//   mode=state   → print current hash + any /watch links on the page
//   mode=watch   → navigate to #/watch/<encoded arg> then stream console for 90s
const targets = await (await fetch("http://127.0.0.1:9777/json")).json();
const page = targets.find((t) => t.type === "page" && (t.url || "").startsWith("http://localhost:5173"));
if (!page) { console.error("renderer target not found"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const mode = process.argv[2] || "state";
const arg = process.argv[3] || "";

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    const args = m.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map(p=>p.value) ?? "")).join(" ");
    if (/a3rb|anime3rb|player|enrich|resolve|server/i.test(args)) {
      console.log(`[${m.params.type}]`, args.slice(0, 500));
    }
  }
};

await new Promise((r) => { ws.onopen = r; });
await send("Runtime.enable");

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

if (mode === "state") {
  const hash = await evalJs("location.hash");
  console.log("hash:", hash);
  const links = await evalJs(`Array.from(document.querySelectorAll('a[href*="watch"]')).slice(0,8).map(a=>a.getAttribute('href'))`);
  console.log("watch links:", JSON.stringify(links, null, 1));
  const text = await evalJs("document.body.innerText.slice(0,300)");
  console.log("body text:", JSON.stringify(text));
  process.exit(0);
}

if (mode === "watch") {
  console.log("navigating to watch page…");
  await evalJs(`location.hash = ${JSON.stringify("#/watch/" + encodeURIComponent(arg))}`);
  console.log("…streaming console for 90s");
  setTimeout(async () => {
    const servers = await evalJs(`Array.from(document.querySelectorAll('button')).map(b=>b.innerText).filter(t=>/3rb|4up|wit/i.test(t))`);
    console.log("server buttons:", JSON.stringify(servers));
    process.exit(0);
  }, 90000);
}
