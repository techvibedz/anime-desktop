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
  /** hijala.com `genre[]` term ids — the site has duplicate terms per genre
   * (أكشن = 2 and 7), so every live id with members is listed. */
  hijala?: number[];
}

/** Ordered roughly by popularity; the filter sheet renders them in this order. */
export const MANGA_GENRES: MangaGenre[] = [
  { label: "أكشن", asq: "action", mangalik: "اكشن", hijala: [2, 7, 393] },
  { label: "مغامرة", asq: "adventure", hijala: [16, 395] },
  { label: "فانتازيا", asq: "fantasy", hijala: [394, 13, 3, 9] },
  { label: "دراما", asq: "drama", hijala: [10] },
  { label: "رومانسي", asq: "romance", mangalik: "رومانسى", hijala: [300] },
  { label: "كوميديا", asq: "comedy", mangawy: "كوميدي", hijala: [15, 399] },
  { label: "شونين", asq: "shounen", hijala: [12] },
  { label: "شوجو", asq: "shoujo", hijala: [299] },
  { label: "رعب", asq: "horror", hijala: [26] },
  { label: "خيال علمي", asq: "sci-fi", mangalik: "خيال-علمى" },
  { label: "غموض", asq: "mystery", hijala: [24] },
  { label: "شياطين", asq: "demons" },
  { label: "قوة خارقة", asq: "super-powers", hijala: [14] },
  { label: "حياة مدرسية", asq: "school-life", hijala: [20] },
  { label: "فنون قتالية", asq: "martial-arts", mangalik: "فنون-قتاليه", hijala: [5, 19] },
  { label: "سينين", asq: "seinen" },
  { label: "حريم", asq: "harem", hijala: [331] },
  { label: "مأساة", asq: "tragedy", mangalik: "ماساة" },
  { label: "خارق للطبيعة", asq: "supernatural", mangalik: "خارق-للطبيعه" },
  { label: "عسكري", asq: "military" },
  { label: "تاريخ", asq: "historical", mangawy: "تاريخي", hijala: [227] },
  { label: "علم نفس", asq: "psychological", mangawy: "نفسي", hijala: [251] },
  { label: "رياضه", asq: "sports", hijala: [21] },
  { label: "جوسي", asq: "josei", mangalik: "جوسى" },
  { label: "ميكا", asq: "mecha" },
  { label: "ايتشى", asq: "ecchi" },
  { label: "تبديل الجنس", asq: "gender-bender", mangalik: "جندر-بندر" },
  { label: "شريحة من الحياة", asq: "slice-of-life", hijala: [23] },
  { label: "إيسيكاي", asq: "إيسيكاي" },
  { label: "ساموراي", asq: "ساموراي" },
  { label: "نينجا", asq: "نينجا", hijala: [303] },
  { label: "جريمة", asq: "جريمة", hijala: [305] },
  { label: "حرب", asq: "حرب" },
  { label: "ون شوت", asq: "ون-شوت" },
  { label: "ويب تون", asq: "ويب-تون" },
  { label: "العاب", asq: "العاب", mangawy: "لعبة", hijala: [8, 4, 317] },
  { label: "عنف", asq: "عنف" },
  { label: "اضطهاد", asq: "اضطهاد" },
  { label: "إثارة", mangalik: "اثاره", hijala: [296] },
  { label: "انتقام", hijala: [384] },
  { label: "تناسخ", hijala: [25, 402] },
  { label: "سحر", hijala: [11] },
  { label: "طبخ", hijala: [316] },
];

export function asqGenreSlug(label: string): string | null {
  return MANGA_GENRES.find((genre) => genre.label === label)?.asq ?? null;
}

export function mangalikGenreSlug(label: string): string {
  const entry = MANGA_GENRES.find((genre) => genre.label === label);
  return (entry?.mangalik ?? label).replace(/\s+/g, "-");
}

export function hijalaGenreIds(label: string): number[] {
  return MANGA_GENRES.find((genre) => genre.label === label)?.hijala ?? [];
}

export function mangawyGenreLabel(label: string): string {
  return MANGA_GENRES.find((genre) => genre.label === label)?.mangawy ?? label;
}
