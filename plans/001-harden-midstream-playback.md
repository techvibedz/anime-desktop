# Plan 001 — Harden mid-stream playback (progressive MP4 / direct streams)

**Written against commit:** `8f497e6`
**Status:** DONE — implemented in worktree branch `worktree-agent-a825e8091c3d908ca` (commit `1115ba6`), typecheck-verified, awaiting user merge.
**Effort:** M
**Risk of the fix:** Low–Medium (touches the live video proxy + the player error handler; both are behind existing fallbacks)

---

## Problem statement

Users report episodes that "fail mid-watching" or "stop running" partway through.
The custom player has two code paths with very unequal resilience:

- **HLS** (`.m3u8`, hls.js) is heavily defended — per-fragment retries, media-error
  recovery, network recovery, and explicit auth-error → re-extract. It rarely dies
  mid-watch.
- **Progressive MP4 / direct streams** (mp4upload, vid3rb, videa, ok.ru, vk — anything
  played through the `<video>` element's `src`, whether via the `pantoufa-video://`
  proxy or direct) is defended only by a 15s stall watchdog and a single
  `<video>.onError` handler.

Two concrete weaknesses in that second path cause avoidable mid-stream death:

### Gap A — the proxy 502s on the first dropped chunk, no retry
`electron/main.ts` chunks progressive media into 4 MB Range requests and fetches each
chunk via `tryFetch(...)` (around line 1765). If that fetch throws for a **transient**
reason (CDN momentarily drops the connection / a single race times out — NOT an expired
token), the handler falls straight to the `catch` and returns **502** (around lines
1861–1885). A single blip on a single mid-stream chunk kills the frame. By contrast the
HLS path retries each fragment up to 5 times. We want the proxy to absorb a transient
chunk failure with a small bounded retry before surfacing 502.

**Important:** retries must apply ONLY to transient failures. If every strategy failed
with an auth status (401/403/410) the token is dead — retrying wastes time and the
existing code already returns a 410 with the `X-Pantoufa-Reextract` header so the
renderer re-extracts. Do not retry the auth case.

### Gap B — `<video>.onError` code 3 abandons the server instantly
`src/pages/Watch.tsx` (around line 1592) handles `<video>` errors:
- `code === 2` (MEDIA_ERR_NETWORK) → `triggerReextract(...)`  ✅ good
- `code === 3` (MEDIA_ERR_DECODE) **or** `code === 4` → `advanceToNext()`

A transient mid-stream proxy 502 frequently surfaces to Chromium as **code 3**, so a
server that just needed one re-extract gets thrown away and the user drops to a worse
server (or runs out). The HLS path re-extracts once before advancing; the MP4 path
should do the same for code 3.

---

## Out of scope (do NOT touch)

- The HLS error handler (`hls.on(Hls.Events.ERROR, ...)`, ~`Watch.tsx:1054-1126`). It
  already works; leave it alone.
- The stall watchdog / in-place reload logic (`checkStall`, ~`Watch.tsx:930-977`). Leave
  as-is.
- The strategy racing internals of `tryFetch` / `fetchWithStrategy`
  (~`main.ts:1490-1658`). You wrap the call site, you do not change the racing.
- Caching, DoH, enrichment, sibling/episode resolution, anything in `src/lib/api.ts`.
- Do NOT add a new npm dependency. Do NOT change `package.json`.

---

## Repo conventions to follow

- TypeScript, 2-space indent, double quotes, semicolons.
- Logging uses `console.info` / `console.warn` with a `[player]` prefix (renderer) or
  `[pantoufa-video]` prefix (main process). Match that exactly — the user reads these
  logs to diagnose playback.
- No new abstractions. Inline the retry loop where it's used; this codebase keeps the
  proxy handler as one long function on purpose.

---

## Step 1 — Add a bounded transient retry to the proxy chunk fetch (Gap A)

**File:** `electron/main.ts`
**Location:** the `protocol.handle(VIDEO_PROTOCOL, async (request) => { ... })` handler.
Find the single call site:

```ts
let { upstream, strategy } = await tryFetch(target, referer, range, request.method, request.signal);
```

(around line 1765, immediately after the chunk `range` is computed and before the
`mp4upload` "retry with bytes=0-" block).

**Change:** wrap that call in a small retry loop that retries on a thrown error, but
re-throws immediately when the failure is an auth error (so the existing `catch` block's
`expired` → 410 path still fires). `tryFetch` attaches `statusCodes: number[]` to the
error it throws when all strategies failed with HTTP responses; use that to classify.

Replace the single `let { upstream, strategy } = await tryFetch(...)` line with:

```ts
// Progressive media is chunked, so a single transient chunk failure (a CDN
// connection drop or one timed-out strategy race — NOT an expired token) must
// not 502 the whole stream the way it used to. HLS gets per-fragment retries;
// give progressive MP4 the same courtesy with a small bounded retry here. Auth
// failures (all strategies 401/403/410) are NOT transient — the token is dead —
// so we re-throw immediately and let the catch block return its 410 +
// X-Pantoufa-Reextract so the renderer re-extracts a fresh URL.
let upstream: Awaited<ReturnType<typeof tryFetch>>["upstream"];
let strategy: string;
{
  const MAX_CHUNK_ATTEMPTS = 3;
  let lastErr: any;
  let ok = false;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    try {
      const r = await tryFetch(target, referer, range, request.method, request.signal);
      upstream = r.upstream;
      strategy = r.strategy;
      ok = true;
      break;
    } catch (err: any) {
      lastErr = err;
      const codes: number[] = Array.isArray(err?.statusCodes) ? err.statusCodes : [];
      const authDead = codes.length > 0 && codes.every((s) => s === 401 || s === 403 || s === 410);
      // Don't retry a dead token or a caller-aborted request (renderer moved on).
      if (authDead || request.signal?.aborted) throw err;
      if (attempt < MAX_CHUNK_ATTEMPTS) {
        console.warn(`[pantoufa-video] chunk fetch failed (attempt ${attempt}/${MAX_CHUNK_ATTEMPTS}), retrying: ${target}${range ? " " + range : ""}`);
        await new Promise((res) => setTimeout(res, 600 * attempt));
        continue;
      }
    }
  }
  if (!ok) throw lastErr;
}
```

**Notes for the executor:**
- `upstream` and `strategy` are reassigned later (the `mp4upload` bytes=0- retry block
  does `upstream = r.upstream; strategy = r.strategy;`). Declaring them with `let` as
  above keeps that working. Confirm the later block still compiles.
- Do not change `tryFetch` itself.
- The `600 * attempt` backoff is deliberate: short enough that the `<video>` element's
  buffer (and the 15s stall watchdog) tolerate it, long enough to clear a transient blip.

**Verify:**
```
npm run typecheck
```
Expected: no errors. (`tsc --noEmit && tsc --noEmit -p electron/tsconfig.json`.)

---

## Step 2 — Re-extract once on `<video>` decode error before advancing (Gap B)

**File:** `src/pages/Watch.tsx`
**Location:** the `<video onError={...}>` handler (around line 1592).

Current code:
```tsx
onError={(e) => {
  const err = (e.target as HTMLVideoElement).error;
  const code = err?.code;
  console.warn(`[player] <video> error code=${code} message=${err?.message || ""}`);
  // Code 2 (MEDIA_ERR_NETWORK): proxy returned 410/403 → signed
  // URL expired. Re-extract a fresh URL instead of advancing.
  if (code === 2 && resolved.url) {
    triggerReextract(`mp4 network error code=${code}`);
    return;
  }
  if (code === 3 || code === 4) advanceToNext();
}}
```

Change the code 3 branch to attempt a re-extract first (mirroring the HLS path, which
re-extracts once before advancing). `triggerReextract` is already idempotent/budgeted —
it counts attempts via `reextractCount` and falls back to the iframe (or advances) once
`MAX_REEXTRACTS_BEFORE_FALLBACK` is exceeded (see `triggerReextract`,
~`Watch.tsx:876-901`), and it's gated by `reextractUsedRef` so it can't loop. So calling
it here is safe and self-limiting.

New code:
```tsx
onError={(e) => {
  const err = (e.target as HTMLVideoElement).error;
  const code = err?.code;
  console.warn(`[player] <video> error code=${code} message=${err?.message || ""}`);
  // Code 2 (MEDIA_ERR_NETWORK): proxy returned 410/403 → signed URL expired.
  // Code 3 (MEDIA_ERR_DECODE): a transient mid-stream proxy 502 / dropped chunk
  // often surfaces here, NOT as a true decode failure — so try one re-extract
  // before abandoning the server (triggerReextract is budgeted and falls back
  // to the iframe / advances once its retry budget is spent, so this can't loop).
  if ((code === 2 || code === 3) && resolved.url) {
    triggerReextract(`mp4 ${code === 2 ? "network" : "decode"} error code=${code}`);
    return;
  }
  if (code === 4) advanceToNext();
}}
```

**Why this is safe (read before worrying):** `triggerReextract` sets
`reextractUsedRef.current = true` on first call and bumps `reextractCount`. Once the
count passes `MAX_REEXTRACTS_BEFORE_FALLBACK` (2) it stops re-extracting and either
remounts the iframe (`setResolved({ type: "iframe" })`) or calls `advanceToNext()`. The
gate `reextractUsedRef` is reset only when a fresh stream wires up
(`reextractUsedRef.current = false`, ~`Watch.tsx:913`). So a genuinely broken stream
(real decode failure that recurs) burns its 2-attempt budget and then advances/falls
back exactly like before — just one cycle slower. A transient blow recovers.

**Verify:**
```
npm run typecheck
```
Expected: no errors.

---

## Step 3 — (Optional, do only if Steps 1–2 are clean) one diagnostic log line

So the next failing session is diagnosable, confirm the proxy's existing `FINAL ERR`
log (around `main.ts:1881`) includes the `range` in its output. If it does not already,
append `${range ? " " + range : ""}` to that `console.warn` so a 502 line tells us
whether it was a first chunk or a mid-stream chunk. Do not add any other logging.

**Verify:** `npm run typecheck` — no errors.

---

## Done criteria (all must hold)

1. `npm run typecheck` exits 0 (both `tsc --noEmit` invocations).
2. `electron/main.ts`: the `tryFetch` call inside the `VIDEO_PROTOCOL` handler is wrapped
   in the bounded retry loop; auth-dead and caller-aborted cases re-throw without
   retrying; `upstream`/`strategy` are still reassignable by the later `mp4upload` block.
3. `src/pages/Watch.tsx`: the `<video>.onError` handler re-extracts on code 2 **and**
   code 3, and advances only on code 4.
4. No changes to any file outside `electron/main.ts` and `src/pages/Watch.tsx`.
5. No new dependencies; `package.json` unchanged.

## Manual smoke test (the author/user runs this — executor cannot)

Build and run the packaged-equivalent dev app:
```
npm run electron:dev
```
Then:
- Play an episode on an MP4 provider (mp4upload, vid3rb, or videa) and let it run several
  minutes. It should not drop to a different server or freeze on a transient blip.
- Watch the terminal: a transient chunk failure should now print
  `[pantoufa-video] chunk fetch failed (attempt 1/3), retrying` and recover, instead of a
  bare `FINAL ERR ... 502`.
- An actually-expired token should still print `URL EXPIRED (...)` and the renderer should
  re-extract (unchanged behavior).

## Escape hatches — STOP and report instead of improvising if:

- `tryFetch` does NOT attach `statusCodes` to its thrown error (verify around
  `main.ts:1650-1656` — it sets `(wrap as any).statusCodes = statusCodes`). If that's
  gone, the auth-vs-transient classification in Step 1 is wrong — stop and report.
- `triggerReextract` no longer self-limits (no `reextractUsedRef` gate / no
  `MAX_REEXTRACTS_BEFORE_FALLBACK` budget). Then Step 2 could loop — stop and report.
- The `<video>` element's `onError` signature or `resolved` shape differs from what's
  excerpted above. Stop and report; do not guess.

## Maintenance note

The retry count (3) and backoff (600ms × attempt) in Step 1 are the calibration knobs.
If mp4 streams still stall on slow MENA→EU CDN edges, raising `MAX_CHUNK_ATTEMPTS` or the
backoff is the first lever — but keep total worst-case retry time under the renderer's
15s stall watchdog (`STALL_THRESHOLD_MS`, `Watch.tsx:86`) so the watchdog and the proxy
retry don't fight. Future reviewers touching the proxy handler should preserve the
"auth-dead → re-throw immediately" branch; losing it reintroduces ~10s of wasted retries
on every expired token.
