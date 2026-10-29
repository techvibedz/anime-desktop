// Cinematic backdrop for the signed-out screens: a slow-drifting wall of the
// posters from the cached home feed (no network — a cold install just gets the
// gradient), dimmed behind the auth card.

import { useEffect, useState } from "react";
import { storage } from "../lib/storage";

export function AuthBackdrop() {
  const [posters, setPosters] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    storage.getItem("@home_cache_v3").then((raw) => {
      if (!raw || !alive) return;
      try {
        const data = JSON.parse(raw)?.data?.data;
        const imgs: string[] = [];
        for (const s of data?.sections ?? []) for (const it of s.items ?? []) if (it?.image) imgs.push(it.image);
        setPosters([...new Set(imgs)].slice(0, 28));
      } catch {}
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {posters.length > 0 && (
        <div className="absolute -inset-[10%] grid rotate-[-8deg] grid-cols-7 gap-4 opacity-35">
          {posters.concat(posters).slice(0, 42).map((src, i) => (
            <div key={i} className="aspect-[2/3] overflow-hidden rounded-card bg-surface">
              <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
            </div>
          ))}
        </div>
      )}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(8,9,12,0.55)_0%,rgba(8,9,12,0.92)_60%,#08090C_100%)]" />
      <div className="absolute -top-40 start-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
    </div>
  );
}
