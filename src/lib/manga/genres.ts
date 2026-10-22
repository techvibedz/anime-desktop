// Manga genre catalog — Arabic labels shared by the combined browse screen.
//
// Each source addresses genres its own way: 3asq.online uses `/manga-genre/<slug>/`
// (English or Arabic slug), mangalik.net uses `/manga-genre/<label>/` (its own
// Arabic spelling, spaces slugified), mangawy.org uses `/browse?genre=<label>`.
// `asq`/`mangalik`/`mangawy` overrides below were each verified live against the
// real site; when an override is absent the adapter derives the source's form
// from `label` (asq needs `asq`, the other two slugify spaces to hyphens).
export interface MangaGenre {
  label: string;
  /** 3asq.online `/manga-genre/<slug>/` slug (English or Arabic). */
  asq?: string;
  /** mangalik.net taxonomy spelling when it differs from `label`. */
  mangalik?: string;
  /** mangawy.org taxonomy spelling when it differs from `label`. */
  mangawy?: string;
}

/** Ordered roughly by popularity; the filter sheet renders them in this order. */
export const MANGA_GENRES: MangaGenre[] = [
  { label: "أكشن", asq: "action", mangalik: "اكشن" },
  { label: "مغامرة", asq: "adventure" },
  { label: "فانتازيا", asq: "fantasy" },
  { label: "دراما", asq: "drama" },
  { label: "رومانسي", asq: "romance", mangalik: "رومانسى" },
  { label: "كوميديا", asq: "comedy", mangawy: "كوميدي" },
  { label: "شونين", asq: "shounen" },
  { label: "شوجو", asq: "shoujo" },
  { label: "رعب", asq: "horror" },
  { label: "خيال علمي", asq: "sci-fi", mangalik: "خيال-علمى" },
  { label: "غموض", asq: "mystery" },
  { label: "شياطين", asq: "demons" },
  { label: "قوة خارقة", asq: "super-powers" },
  { label: "حياة مدرسية", asq: "school-life" },
  { label: "فنون قتالية", asq: "martial-arts", mangalik: "فنون-قتاليه" },
  { label: "سينين", asq: "seinen" },
  { label: "حريم", asq: "harem" },
  { label: "مأساة", asq: "tragedy", mangalik: "ماساة" },
  { label: "خارق للطبيعة", asq: "supernatural", mangalik: "خارق-للطبيعه" },
  { label: "عسكري", asq: "military" },
  { label: "تاريخ", asq: "historical", mangawy: "تاريخي" },
  { label: "علم نفس", asq: "psychological", mangawy: "نفسي" },
  { label: "رياضه", asq: "sports" },
  { label: "جوسي", asq: "josei", mangalik: "جوسى" },
  { label: "ميكا", asq: "mecha" },
  { label: "ايتشى", asq: "ecchi" },
  { label: "تبديل الجنس", asq: "gender-bender", mangalik: "جندر-بندر" },
  { label: "شريحة من الحياة", asq: "slice-of-life" },
  { label: "إيسيكاي", asq: "إيسيكاي" },
  { label: "ساموراي", asq: "ساموراي" },
  { label: "نينجا", asq: "نينجا" },
  { label: "جريمة", asq: "جريمة" },
  { label: "حرب", asq: "حرب" },
  { label: "ون شوت", asq: "ون-شوت" },
  { label: "ويب تون", asq: "ويب-تون" },
  { label: "العاب", asq: "العاب", mangawy: "لعبة" },
  { label: "عنف", asq: "عنف" },
  { label: "اضطهاد", asq: "اضطهاد" },
  { label: "إثارة", mangalik: "اثاره" },
  { label: "انتقام" },
  { label: "تناسخ" },
  { label: "سحر" },
  { label: "طبخ" },
];

export function asqGenreSlug(label: string): string | null {
  return MANGA_GENRES.find((genre) => genre.label === label)?.asq ?? null;
}

export function mangalikGenreSlug(label: string): string {
  const entry = MANGA_GENRES.find((genre) => genre.label === label);
  return (entry?.mangalik ?? label).replace(/\s+/g, "-");
}

export function mangawyGenreLabel(label: string): string {
  return MANGA_GENRES.find((genre) => genre.label === label)?.mangawy ?? label;
}
