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

// Common AniList tags (themes) used in taste reasons. Tags without an entry
// are not shown as a reason (never show raw English in an Arabic sentence).
const TAG_AR: Record<string, string> = {
  Isekai: "عوالم أخرى (إيسيكاي)", Reincarnation: "تناسخ", Revenge: "انتقام", Tragedy: "مأساة",
  "Time Manipulation": "التلاعب بالزمن", "Time Loop": "حلقة زمنية", Magic: "سحر", Demons: "شياطين",
  Military: "حرب وعسكرية", War: "حروب", "Martial Arts": "فنون قتالية", Swordplay: "سيوف",
  Survival: "بقاء", "Post-Apocalyptic": "ما بعد نهاية العالم", Dystopian: "عالم بائس", Detective: "تحقيق",
  "Crime": "جريمة", "Organized Crime": "عصابات", Mafia: "مافيا", Gore: "دموي", Vampire: "مصاصو دماء",
  Ghost: "أشباح", Youkai: "كائنات خارقة", "Urban Fantasy": "خيال حضري", Mythology: "أساطير",
  "Super Power": "قوى خارقة", Superhero: "أبطال خارقون", Ninja: "نينجا", Samurai: "ساموراي", Pirates: "قراصنة",
  Travel: "رحلات ومغامرة", Space: "الفضاء", "Artificial Intelligence": "ذكاء اصطناعي", Cyberpunk: "سايبربانك",
  Robots: "روبوتات", "Video Games": "ألعاب فيديو", "Virtual World": "عالم افتراضي", School: "مدرسة",
  "School Club": "نادي مدرسي", Workplace: "بيئة عمل", Family: "عائلة", "Found Family": "عائلة مختارة",
  "Coming of Age": "النضج", Philosophy: "فلسفة", "Psychological": "نفسي", Twists: "مفاجآت وحبكات",
  "Plot Twist": "مفاجآت وحبكات", "Death Game": "لعبة الموت", Gambling: "مقامرة", Politics: "سياسة",
  "Royal Affairs": "صراع العروش", Kingdom: "ممالك", Nobility: "نبلاء", Cooking: "طبخ", Food: "طعام",
  Music: "موسيقى", Band: "فرقة موسيقية", Idol: "آيدول", Basketball: "كرة السلة", Football: "كرة القدم",
  Volleyball: "كرة الطائرة", Baseball: "بيسبول", Boxing: "ملاكمة", Racing: "سباقات", "Tokusatsu": "توكوساتسو",
  Iyashikei: "هادئ ومريح", "Cute Girls Doing Cute Things": "لطيف وهادئ", "Slapstick": "كوميديا حركية",
  Parody: "محاكاة ساخرة", Satire: "سخرية", "Love Triangle": "مثلث حب", "Rom-Com": "رومانسي كوميدي",
  Shounen: "شونين", Seinen: "سينين", Shoujo: "شوجو", Josei: "جوسي", Kaiju: "وحوش عملاقة",
  "Anti-Hero": "بطل مضاد", Villainess: "الشريرة", "Overpowered Main Character": "بطل خارق القوة",
  "Dungeon": "زنزانات", "Monster": "وحوش", Dragons: "تنانين", Elf: "إلف", Witch: "ساحرات",
  "Body Horror": "رعب جسدي", "Cosmic Horror": "رعب كوني", Conspiracy: "مؤامرة", Terrorism: "إرهاب",
  "Medicine": "طب", Historical: "تاريخي", "Alternate Universe": "عالم بديل", Aliens: "كائنات فضائية",
};

/** Arabic label for a theme tag, or null when we don't have a good one. */
export function arTag(t: string): string | null {
  return TAG_AR[t] ?? null;
}
