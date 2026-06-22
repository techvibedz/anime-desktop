// Arabic labels for AniList's fixed English enum values (genres, media format).
// AniList returns these as stable English keys, so a static map gives a clean,
// instant Arabic rendering — no translation round-trip needed.
// Ported from the mobile app (lib/anilistLabels.ts).

const GENRE_AR: Record<string, string> = {
  Action: "أكشن",
  Adventure: "مغامرة",
  Comedy: "كوميدي",
  Drama: "دراما",
  Ecchi: "إيتشي",
  Fantasy: "خيال",
  Horror: "رعب",
  "Mahou Shoujo": "فتاة سحرية",
  Mecha: "ميكا",
  Music: "موسيقى",
  Mystery: "غموض",
  Psychological: "نفسي",
  Romance: "رومانسي",
  "Sci-Fi": "خيال علمي",
  "Slice of Life": "شريحة من الحياة",
  Sports: "رياضة",
  Supernatural: "خارق للطبيعة",
  Thriller: "إثارة",
};

export function arGenre(g: string): string {
  return GENRE_AR[g] || g;
}

const FORMAT_AR: Record<string, string> = {
  TV: "مسلسل",
  TV_SHORT: "مسلسل قصير",
  MOVIE: "فيلم",
  SPECIAL: "حلقة خاصة",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "فيديو موسيقي",
};

export function arFormat(f: string | null | undefined): string | null {
  if (!f) return null;
  return FORMAT_AR[f] || f;
}
