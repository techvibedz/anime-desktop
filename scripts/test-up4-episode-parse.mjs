// Live check of the animation4up episode-list parser + pagination walker.
// Guards the regression where the container scoping matched the class name in
// the page's inline CSS (not the element), parsed zero episodes, and left
// anime4up1/2 servers missing from every witanime-primary episode.
// usage: node scripts/test-up4-episode-parse.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "../src/lib/scraper.ts"), "utf8");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ar,en;q=0.9", Referer: "https://w1.anime4up.rest/" },
    redirect: "follow",
  });
  return res.ok ? res.text() : null;
}

const mod = { exports: {} };
const sandbox = {
  module: mod, exports: mod.exports, console, fetch, URL, atob, btoa, setTimeout, clearTimeout,
  AbortSignal, Uint8Array, TextDecoder, window: { pantoufa: { fetchHtml } },
  // scraper.ts imports only two local modules; neither is exercised by the parser.
  require: (id) => (id === "./fuzzy" ? { fuzzyScore: () => 0 } : {}),
};
vm.createContext(sandbox);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInContext(js, sandbox);

const { findUp4EpisodeAcrossPages } = mod.exports;
const probe = await fetchHtml("https://w1.anime4up.rest/anime/mirai-nikki/");
if (!probe) {
  console.log("SKIP: anime4up unreachable (network/geo) — parser not exercised");
  process.exit(0);
}

let failed = 0;
const cases = [
  ["single-page list finds ep 3", "https://w1.anime4up.rest/anime/mirai-nikki/", 3, "-الحلقة-3-"],
  ["paginated list finds ep 1100", "https://w1.anime4up.rest/anime/one-piece-gfjgfh/", 1100, "-1100"],
];
for (const [label, animeUrl, ep, needle] of cases) {
  try {
    const r = await findUp4EpisodeAcrossPages(animeUrl, ep);
    const url = r.url ? decodeURIComponent(r.url) : "";
    if (url && url.includes(needle)) console.log(`PASS ${label}: ${r.url}`);
    else { failed++; console.error(`FAIL ${label}: url=${r.url} definitive=${r.definitive}`); }
  } catch (error) {
    failed++;
    console.error(`FAIL ${label}: ${error.message}`);
  }
}
console.log(failed === 0 ? "ALL UP4 PARSE CHECKS PASSED" : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
