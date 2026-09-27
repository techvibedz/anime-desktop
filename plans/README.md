# Improvement plans

Written against commit `e5fe1f5`.

These plans are self-contained specs for an executor with no prior context. Each names
its in-scope files, its verification gates, and its escape hatches. Do not implement
beyond what a plan specifies.

## Status

| # | Plan | Category | Effort | Risk | Status |
|---|------|----------|--------|------|--------|
| 001 | [Harden mid-stream playback](001-harden-midstream-playback.md) | correctness / resilience | M | Low–Med | DONE (in worktree, awaiting merge) |

## Execution order

001 stands alone — no dependencies. Steps within it are ordered (proxy retry first, then
the renderer onError change, then the optional log tweak).

## Context

Origin: user reported episodes "failing mid-watching" / "stopping mid-run". Root analysis
found the progressive-MP4 / direct-stream path far less resilient than the HLS path —
specifically (A) the `pantoufa-video://` proxy 502s on the first transient chunk failure
with no retry, and (B) the `<video>.onError` code-3 branch abandons the server with no
re-extract attempt. Plan 001 closes both gaps with small, contained, behind-existing-
fallback changes.

Not yet diagnosed from runtime logs: which provider/path dominates the user's actual
failures. Both fixes are net-positive regardless; Step 3 adds the one log line that pins
it for next time.
