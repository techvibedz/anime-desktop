// Offline test of a3rbCatalogMatch against a downloaded sitemap.
// usage: node scripts/test-a3rb-catalog.mjs <sitemap.xml>
import { readFileSync } from "node:fs";

// — copies of the matcher helpers in src/lib/scraper.ts —
function tm_seasonNum(s) {
  s = (s || "").toLowerCase();
  const m =
    s.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:season|part|cour)\b/) ||
    s.match(/\b(?:season|s|part|cour)\s*(\d+)\b/) ||
    s.match(/الموسم\s*([٠-٩\d]+)/) ||
    s.match(/الجزء\s*([٠-٩\d]+)/);
  if (!m) return 1;
  const n = m[1].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const v = parseInt(n, 10);
  return isNaN(v) ? 1 : v;
}
function tm_normLatin(s) {
  return String(s || "").toLowerCase()
    .replace(/\b(?:season|s|part|cour)\s*\d+\b/g, " ")
    .replace(/\b(?:the|a|an|of|to|wa|no|wo|ga|ni)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
function tm_toks(s) { return s ? s.split(" ").filter((w) => w.length >= 2) : []; }
function a3rbSeasonOf(label) {
  const k = tm_seasonNum(label);
  if (k !== 1) return k;
  const t = label.match(/(?:^|[\s-])(\d{1,2})$/);
  if (t) { const v = parseInt(t[1], 10); if (v >= 2 && v <= 20) return v; }
  return 1;
}
function a3rbCatalogMatch(title, slugs) {
  const rawForms = [title];
  const reParen = /[\(\[]([^\)\]]+)[\)\]]/g;
  let pm;
  while ((pm = reParen.exec(title))) { const p = pm[1].trim(); if (p) rawForms.push(p); }
  const wants = [];
  for (const f of rawForms) {
    for (const v of [f, f.replace(/(\S)[:：](\S)/g, "$1$2")]) {
      const toks = tm_toks(tm_normLatin(v));
      if (!toks.length) continue;
      const set = {};
      toks.forEach((t) => { set[t] = true; });
      wants.push({ set, n: toks.length, season: a3rbSeasonOf(v.toLowerCase()) });
    }
  }
  if (!wants.length) return null;
  let best = { slug: null, score: 0 };
  for (const slug of slugs) {
    const label = slug.replace(/[-_]+/g, " ");
    const gotToks = tm_toks(tm_normLatin(label));
    if (!gotToks.length) continue;
    const gotSeason = a3rbSeasonOf(label);
    for (const w of wants) {
      if (gotSeason !== w.season) continue;
      let gc = 0;
      const gotSet = {};
      for (const t of gotToks) { gotSet[t] = true; if (w.set[t]) gc++; }
      let wc = 0;
      for (const t in w.set) { if (gotSet[t]) wc++; }
      const wantCov = wc / w.n;
      const gotCov = gc / gotToks.length;
      const contained = gotCov === 1 && gc >= 4;
      const ok = contained || (
        w.n >= 3 ? wantCov >= 0.8 :
        w.n === 2 ? wantCov === 1 && gotCov >= 0.6 :
        wantCov === 1 && gotCov === 1);
      if (!ok) continue;
      const score = wantCov * 60 + gotCov * 40;
      if (score > best.score) best = { slug, score };
    }
  }
  return best.slug;
}

const xml = readFileSync(process.argv[2], "utf8");
const slugs = [];
const re = /<loc>\s*https?:\/\/anime3rb\.com\/titles\/([^<\s]+?)\/?\s*<\/loc>/g;
let m;
while ((m = re.exec(xml))) { try { slugs.push(decodeURIComponent(m[1])); } catch { slugs.push(m[1]); } }
console.log("catalog slugs:", slugs.length);

const titles = [
  "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e 4th Season: 2-nensei-hen 1 Gakki",
  "Tensei shitara Slime Datta Ken 4th Season",
  "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season",
  "Dr. Stone: Science Future Part 3",
  "Dorohedoro Season 2",
  "Tsue to Tsurugi no Wistoria Season 2",
  "The Beginning After the End Season 2 (Saikyou no Ousama, Nidome no Jinsei wa Nani wo Suru Season 2)",
  "Blades of the Guardians Season 2 (Biao Ren 2)",
  "Devil May Cry Season 2",
  "Yomi no Tsugai",
  "One Piece",
  "Boku no Hero Academia",
  "Kaijuu 8-gou 2nd Season",
];
for (const t of titles) {
  console.log(`"${t}"\n  → ${a3rbCatalogMatch(t, slugs)}`);
}
