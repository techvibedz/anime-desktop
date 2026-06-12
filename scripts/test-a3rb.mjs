// Ad-hoc test of the anime3rb chain exactly as the app does it.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const A3RB = "https://anime3rb.com";

async function fetchHtml(url, referer) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ar,en;q=0.9",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  console.log(`  GET ${url} → ${res.status}`);
  if (!res.ok) return null;
  return res.text();
}

const title = process.argv[2] || "One Piece";
const ep = parseInt(process.argv[3] || "1100", 10);

// 1. title page probe
const slug = title.toLowerCase().normalize("NFKD").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
console.log("slug guess:", slug);
const titleHtml = await fetchHtml(`${A3RB}/titles/${slug}`, A3RB + "/");
if (!titleHtml) { console.log("TITLE PAGE MISS"); process.exit(0); }
const tm = titleHtml.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) || titleHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
const got = tm ? tm[1].replace(/\s*[|–]\s*Anime3rb.*$/i, "").trim() : "(no title tag)";
console.log("page title (after strip):", JSON.stringify(got));

// 2. episode page
const epHtml = await fetchHtml(`${A3RB}/episode/${slug}/${ep}`, A3RB + "/");
if (!epHtml) { console.log("EPISODE PAGE MISS"); process.exit(0); }
let raw =
  epHtml.match(/video_url&quot;:&quot;(https:[\s\S]*?)&quot;/)?.[1] ||
  epHtml.match(/"video_url"\s*:\s*"(https:[\s\S]*?)"/)?.[1] ||
  null;
if (!raw) { console.log("NO video_url IN EPISODE HTML"); process.exit(0); }
const playerUrl = raw.replace(/\\\//g, "/").replace(/&amp;/g, "&");
console.log("player url:", playerUrl);

// 3. vid3rb extraction
const res = await fetch(playerUrl, {
  headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "ar,en;q=0.9", "Referer": "https://anime3rb.com/" },
  redirect: "follow",
});
console.log(`  GET player → ${res.status}`);
const playerHtml = await res.text();
const m = playerHtml.match(/video_sources\s*=\s*(\[\{[\s\S]*?\}\])\s*;/);
if (!m) {
  const i = playerHtml.indexOf("video_sources");
  console.log("NO video_sources MATCH. context:", i >= 0 ? playerHtml.slice(i, i + 400) : "(token absent, page len=" + playerHtml.length + ")");
  process.exit(0);
}
const sources = JSON.parse(m[1]);
console.log("sources:", sources.map((s) => ({ label: s.label, res: s.res, premium: s.premium, hasSrc: !!s.src })));
