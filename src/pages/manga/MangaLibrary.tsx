// Manga library — saved works + reading shelf (mobile app/manga-library.tsx parity).

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { normFuzzy } from "../../lib/fuzzy";
import { removeFromMangaLibrary, useContinueReading, useMangaLibrary } from "../../lib/manga/store";
import type { MangaCard } from "../../lib/manga/types";
import { useCardLayout } from "../../lib/cardLayout";
import { CardLayoutControl } from "../../components/CardLayoutControl";
import { ICONS, MangaCardTile, MangaPage, MangaState, MIcon } from "../../components/manga/MangaUI";
import { MANGA_GRID } from "./MangaHub";

export function MangaLibraryPage() {
  const navigate = useNavigate();
  const items = useMangaLibrary();
  const progress = useContinueReading(1000);
  const { layout, setLayout } = useCardLayout("manga-library");
  const [query, setQuery] = useState("");
  const [readingOnly, setReadingOnly] = useState(false);
  const progressById = useMemo(() => new Map(progress.map((item) => [`${item.source}:${item.id}`, item])), [progress]);
  const readingCount = items.filter((item) => progressById.has(`${item.source}:${item.id}`)).length;
  const shown = useMemo(() => items.filter((item) => normFuzzy(item.title).includes(normFuzzy(query)) &&
    (!readingOnly || progressById.has(`${item.source}:${item.id}`))), [items, query, readingOnly, progressById]);
  const remove = (card: MangaCard) => {
    if (window.confirm(`إزالة من المكتبة؟\n${card.title}`)) void removeFromMangaLibrary(card.source, card.id);
  };

  return (
    <MangaPage>
      <div className="mx-auto max-w-[1500px]">
        <header className="flex items-center gap-4">
          <button type="button" onClick={() => navigate(-1)} aria-label={t.back}
            className="flex h-11 w-11 items-center justify-center rounded border border-m-line bg-m-sheet text-m-ink hover:border-m-ink">
            <MIcon d={ICONS.back} />
          </button>
          <div className="flex-1">
            <div className="font-mono text-[10px] font-bold tracking-[0.16em] text-m-accent" dir="ltr">YOUR READING SHELF</div>
            <h1 className="text-[30px] font-bold leading-tight">مكتبتي</h1>
            <div className="text-xs font-semibold text-m-muted">{items.length} عمل محفوظ · {readingCount} أقرأ الآن</div>
          </div>
        </header>

        {items.length > 0 && (
          <>
            <div className="mt-6 flex items-center gap-3">
              <label className="flex h-12 flex-1 items-center gap-3 rounded border border-m-line bg-m-sheet px-4 focus-within:border-m-ink">
                <MIcon d={ICONS.search} className="text-m-muted" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث في مكتبتك…" aria-label="البحث في مكتبة المانجا"
                  className="h-full flex-1 bg-transparent outline-none placeholder:text-m-muted" />
                {query && <button type="button" onClick={() => setQuery("")} aria-label={t.cancel} className="text-m-muted hover:text-m-ink"><MIcon d={ICONS.close} /></button>}
              </label>
              <CardLayoutControl layout={layout} onChange={setLayout} />
            </div>
            <div className="mt-4 flex gap-2 border-b border-m-line pb-3">
              {[{ label: "كل الأعمال", value: false }, { label: "أقرأ الآن", value: true }].map((tab) => (
                <button key={tab.label} type="button" onClick={() => setReadingOnly(tab.value)} aria-pressed={readingOnly === tab.value}
                  className={`h-11 rounded border px-6 text-sm font-bold ${readingOnly === tab.value ? "border-m-accent bg-m-accent-wash text-m-accent" : "border-m-line bg-m-sheet text-m-muted hover:text-m-ink"}`}>
                  {tab.label}
                </button>
              ))}
              <span className="ms-auto self-center text-sm font-bold text-m-muted">{shown.length} {t.mangaSeries}</span>
            </div>
          </>
        )}

        {shown.length > 0 ? (
          <div className={`mt-5 ${MANGA_GRID[layout]}`}>
            {shown.map((card) => {
              const item = progressById.get(`${card.source}:${card.id}`);
              return (
                <MangaCardTile key={`${card.source}:${card.id}`} card={card} layout={layout}
                  subtitle={item ? `الفصل ${item.chapterNumber} · الصفحة ${item.page + 1}` : card.type ?? undefined}
                  corner={(
                    <button type="button" onClick={() => remove(card)} aria-label={`${t.remove}: ${card.title}`}
                      className="flex h-8 w-8 items-center justify-center rounded border border-m-line bg-m-sheet text-m-ink shadow-sm hover:border-m-accent hover:text-m-accent">
                      <MIcon d={ICONS.close} size={16} />
                    </button>
                  )} />
              );
            })}
          </div>
        ) : (
          <MangaState icon={items.length ? ICONS.search : ICONS.bookmark}
            title={items.length ? "لا توجد أعمال مطابقة" : t.mangaLibraryEmpty}
            message={items.length ? "غيّر البحث أو اعرض كل الأعمال المحفوظة." : t.mangaLibraryEmptySub}
            primary={{
              label: items.length ? "عرض كل الأعمال" : t.mangaBrowseNow,
              icon: ICONS.book,
              onClick: () => { if (items.length) { setQuery(""); setReadingOnly(false); } else navigate("/manga"); },
            }} />
        )}
      </div>
    </MangaPage>
  );
}
