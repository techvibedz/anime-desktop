import assert from "node:assert/strict";
import { chapterImageReferer, fetchReadableChapter, probePageAlive, type ReadableDeps } from "./readable";
import type { MangaChapterRef as ChapterCopy, MangaReaderData } from "./types";

// Dead-copy fallback: a chapter whose listed images are gone (3asq Naruto
// 590–700) must be served from another source's copy of the same number.

const asq: ChapterCopy = { source: "asq", mangaId: "https://3asq.online/manga/naruto/", id: "https://3asq.online/manga/naruto/700/" };
const lik: ChapterCopy = { source: "mangalik", mangaId: "naruto", id: "700" };
const wy: ChapterCopy = { source: "mangawy", mangaId: "naruto", id: "700" };

function deps(chapters: Record<string, MangaReaderData | Error>, dead: Set<string>, log: string[] = []): ReadableDeps {
  return {
    fetchChapter: async (copy) => {
      log.push(`fetch:${copy.source}`);
      const value = chapters[copy.source];
      if (!value || value instanceof Error) throw value ?? new Error("missing");
      return value;
    },
    probe: async (uri, referer) => {
      log.push(`probe:${uri}|${referer}`);
      return !dead.has(uri);
    },
  };
}

async function main() {
  // Referers per source (moved out of the reader).
  assert.equal(chapterImageReferer(asq), "https://3asq.online/");
  assert.equal(chapterImageReferer(lik), "https://lekmanga.site/");
  assert.equal(chapterImageReferer({ source: "hijala", mangaId: "x", id: "x-3" }), "https://hijala.com/");
  assert.equal(chapterImageReferer(wy), "https://mangawy.org/");

  // Live primary: no alternates lookup, one probe pair.
  {
    const log: string[] = [];
    let asked = false;
    const got = await fetchReadableChapter(asq, async () => { asked = true; return [lik]; }, {}, deps({ asq: { pages: ["a1", "a2", "a3"] } }, new Set(), log));
    assert.equal(got.copy, asq);
    assert.deepEqual(got.data.pages, ["a1", "a2", "a3"]);
    assert.equal(asked, false);
    assert.deepEqual(log, ["fetch:asq", "probe:a1|https://3asq.online/", "probe:a3|https://3asq.online/"]);
  }

  // Dead primary → the alternate whose images load, probed with its own Referer.
  {
    const log: string[] = [];
    const primary = { ...asq, id: asq.id + "x" };
    const d = deps({ asq: { pages: ["d1", "d2"] }, mangalik: { pages: ["l1", "l2"] } }, new Set(["d1", "d2"]), log);
    const got = await fetchReadableChapter(primary, async () => [primary, lik], {}, d);
    assert.equal(got.copy, lik);
    assert.deepEqual(got.data.pages, ["l1", "l2"]);
    assert.ok(log.includes("probe:l1|https://lekmanga.site/"));
    assert.equal(log.filter((line) => line === "fetch:asq").length, 1, "the anchor copy is not refetched");

    // Remembered: a reopen goes straight to the copy that worked.
    const again: string[] = [];
    const reopened = await fetchReadableChapter(primary, async () => [lik], {}, deps({ asq: { pages: ["d1"] }, mangalik: { pages: ["l1", "l2"] } }, new Set(["d1"]), again));
    assert.equal(reopened.copy, lik);
    assert.equal(again[0], "fetch:mangalik");
  }

  // A work seen dead sends its OTHER chapters to the alternates first.
  {
    const log: string[] = [];
    const next = { ...asq, id: "https://3asq.online/manga/naruto/699x/" };
    const got = await fetchReadableChapter(next, async () => [next, lik], {}, deps({ asq: { pages: ["d1"] }, mangalik: { pages: ["l1"] } }, new Set(["d1"]), log));
    assert.equal(got.copy, lik);
    assert.equal(log[0], "fetch:mangalik");
    assert.ok(!log.includes("fetch:asq"));
  }

  // Failing/empty primary falls through too.
  {
    const primary = { ...asq, id: asq.id + "y" };
    const got = await fetchReadableChapter(primary, async () => [lik], {}, deps({ asq: new Error("boom"), mangalik: { pages: ["l1"] } }, new Set()));
    assert.equal(got.copy, lik);
    const empty = { ...asq, id: asq.id + "z" };
    const got2 = await fetchReadableChapter(empty, async () => [wy], {}, deps({ asq: { pages: [] }, mangawy: { pages: ["w1"] } }, new Set()));
    assert.equal(got2.copy, wy);
  }

  // Every copy dead → still the first page list (per-page state), not a throw.
  {
    const primary = { ...asq, mangaId: "https://3asq.online/manga/fresh/", id: asq.id + "w" };
    const got = await fetchReadableChapter(primary, async () => [lik], {}, deps({ asq: { pages: ["d1"] }, mangalik: { pages: ["d2"] } }, new Set(["d1", "d2"])));
    assert.equal(got.copy, primary);
  }

  // Nothing at all → the original error.
  {
    const primary = { ...asq, id: asq.id + "v" };
    await assert.rejects(
      fetchReadableChapter(primary, async () => { throw new Error("no detail"); }, {}, deps({ asq: new Error("boom") }, new Set())),
      /boom/,
    );
  }

  // Probe verdicts: only definitive answers are "dead".
  const ans = (status: number, contentType = "image/jpeg", challenge = false) => async () => ({ status, contentType, challenge });
  assert.equal(await probePageAlive("u", "r", ans(404)), false);
  assert.equal(await probePageAlive("u", "r", ans(403)), false);
  assert.equal(await probePageAlive("u", "r", ans(200, "text/html; charset=utf-8")), false);
  assert.equal(await probePageAlive("u", "r", ans(403, "text/html", true)), true, "Cloudflare challenge is not a dead file");
  assert.equal(await probePageAlive("u", "r", ans(206)), true);
  assert.equal(await probePageAlive("u", "r", ans(503)), true);
  assert.equal(await probePageAlive("u", "r", ans(0, "")), true);
  assert.equal(await probePageAlive("u", "r", async () => { throw new Error("ipc"); }), true);
  let seen = "";
  await probePageAlive("https://x/a.jpg#pantoufa-cols=https://x/b.jpg", "r", async (uri) => { seen = uri; return { status: 200, contentType: "image/jpeg", challenge: false }; });
  assert.equal(seen, "https://x/a.jpg");

  console.log("readable ok");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
