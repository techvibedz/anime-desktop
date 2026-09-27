// Connect to a running Electron renderer via CDP, capture console errors,
// uncaught exceptions, and failed network requests, then probe the scraper
// bridge + run a home fetch. Prints everything and exits.
const BASE = "http://localhost:9222";

async function findTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && /localhost:5173/.test(t.url || ""))
        || list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no renderer target on :9222");
}

const page = await findTarget();
console.log("[cdp] target:", page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

const fmt = (a) => (a.value !== undefined ? a.value : a.description ?? JSON.stringify(a.preview ?? a));

ws.addEventListener("open", () => {
  send("Runtime.enable");
  send("Log.enable");
  send("Network.enable");
  console.log("[cdp] listening for console / exceptions / failed requests…");
});

ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === "Runtime.consoleAPICalled") {
    const args = (m.params.args || []).map(fmt).join(" ");
    console.log(`[console.${m.params.type}] ${args}`);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    console.log(`[EXCEPTION] ${d.exception?.description || d.text}`);
  } else if (m.method === "Log.entryAdded") {
    const e = m.params.entry;
    if (e.level === "error" || e.level === "warning") console.log(`[log.${e.level}] ${e.text} ${e.url || ""}`);
  } else if (m.method === "Network.loadingFailed") {
    console.log(`[net.FAIL] ${m.params.errorText} ${m.params.type}`);
  } else if (m.result && m.result.result) {
    console.log("[eval]", m.result.result.value ?? m.result.result.description);
  }
});

// After listeners settle, probe the bridge + the home scrape directly.
setTimeout(() => {
  send("Runtime.evaluate", { expression: "typeof window.pantoufa + ' :: ' + JSON.stringify(Object.keys(window.pantoufa||{}))", returnByValue: true });
}, 4000);
setTimeout(() => {
  send("Runtime.evaluate", {
    expression: `(async()=>{try{const m=await import('/src/lib/api.ts');const r=await m.fetchHome();return 'fetchHome ok: featured='+(r.featured?.length??'?')+' sections='+(r.sections?.length??'?');}catch(e){return 'fetchHome ERR: '+(e&&e.message||e);}})()`,
    awaitPromise: true, returnByValue: true,
  });
}, 6000);

setTimeout(() => { console.log("[cdp] done"); ws.close(); process.exit(0); }, 30000);
