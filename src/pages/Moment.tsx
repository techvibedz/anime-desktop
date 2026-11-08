// Shared-moment link: /moment/<id> (from a pasted pantoufa-join.pages.dev/m/<id>
// link or the pantoufa://moment/<id> deep link). Loads the moment and opens
// the player at its timestamp (mobile app/moment/[id].tsx parity).

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchMoment, isMomentId } from "../lib/moments";
import { t } from "../lib/i18n";

export function MomentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isMomentId(id)) {
      setFailed(true);
      return;
    }
    let alive = true;
    void fetchMoment(id).then((m) => {
      if (!alive) return;
      if (!m) {
        setFailed(true);
        return;
      }
      const p = new URLSearchParams();
      if (m.anime_href) p.set("anime", m.anime_href);
      if (m.anime_title) p.set("title", m.anime_title);
      if (m.image) p.set("img", m.image);
      if (m.ep_num != null) p.set("ep", String(m.ep_num));
      if (m.url4up) p.set("up4", m.url4up);
      if (m.url3rb) p.set("a3rb", m.url3rb);
      p.set("t", String(m.t_sec));
      if (m.sharer_name) p.set("from", m.sharer_name);
      navigate(`/watch/${encodeURIComponent(m.episode_href)}?${p.toString()}`, { replace: true });
    });
    return () => { alive = false; };
  }, [id, navigate]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      {failed ? (
        <>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-text-muted" aria-hidden><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
          <p className="text-sm font-semibold text-text-secondary">{t.momentNotFound}</p>
          <button type="button" onClick={() => navigate("/", { replace: true })} className="rounded-full bg-white/10 px-5 py-2 text-sm font-bold text-white hover:bg-white/15">
            {t.home}
          </button>
        </>
      ) : (
        <>
          <span className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm text-text-muted">{t.momentOpening}</p>
        </>
      )}
    </div>
  );
}
