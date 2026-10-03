// Connectivity awareness — browser/Electron renderer.
//
// navigator.onLine plus the window's online/offline events give an immediate,
// zero-cost signal (no probes, no races). `online` may read true on a captive
// portal or LAN-without-internet, which is acceptable: it answers "does this
// machine have a network?", not "is the anime source reachable?".

import { useCallback, useEffect, useRef, useState } from "react";

/** Resolve the current connection state. Kept async for API parity. */
export async function checkOnline(_timeoutMs = 4000): Promise<boolean> {
  try {
    return navigator.onLine;
  } catch {
    return true;
  }
}

/**
 * Reactive online status. `online` is `null` until the first check resolves,
 * then a boolean. Updates on online/offline events and exposes `recheck()`
 * for manual retries (e.g. a "try again" button).
 */
export function useOnlineStatus(): { online: boolean | null; recheck: () => Promise<boolean> } {
  const [online, setOnline] = useState<boolean | null>(null);
  const mounted = useRef(true);

  const recheck = useCallback(async () => {
    let v = true;
    try {
      v = navigator.onLine;
    } catch {}
    if (mounted.current) setOnline(v);
    return v;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void recheck();
    const onOnline = () => { if (mounted.current) setOnline(true); };
    const onOffline = () => { if (mounted.current) setOnline(false); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      mounted.current = false;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [recheck]);

  return { online, recheck };
}
