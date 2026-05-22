// All UI strings in Arabic. Anime titles stay as scraped.

export const ar = {
  // Common
  appName: "بانتوفة",
  cancel: "إلغاء",
  loading: "جارٍ التحميل…",
  retry: "إعادة المحاولة",
  back: "رجوع",
  save: "حفظ",
  remove: "حذف",
  episode: "الحلقة",
  episodes: "الحلقات",
  episodeCount: (n: number) => `${n} ${n === 1 ? "حلقة" : "حلقات"}`,

  // Auth
  welcomeBack: "أهلًا بعودتك",
  loginSub: "سجّل الدخول لمزامنة قائمتك والمتابعة من حيث توقّفت.",
  continueWithGoogle: "المتابعة بحساب Google",
  signUpWithGoogle: "إنشاء حساب بـ Google",
  or: "أو",
  email: "البريد الإلكتروني",
  password: "كلمة المرور",
  passwordPlaceholder: "••••••••",
  emailPlaceholder: "you@example.com",
  forgotPassword: "هل نسيت كلمة المرور؟",
  signIn: "تسجيل الدخول",
  signUp: "إنشاء حساب",
  createAccount: "إنشاء حساب",
  noAccount: "ليس لديك حساب؟",
  haveAccount: "لديك حساب بالفعل؟",
  signInFailed: "فشل تسجيل الدخول",
  authNotConfigured: "خدمة المصادقة غير مهيّأة",
  checkInbox: "افحص بريدك",
  confirmEmailSent: (e: string) => `أرسلنا رابط التحقق إلى ${e}.`,
  passwordMin8: "ثمانية أحرف على الأقل",

  // Home
  home: "الرئيسية",
  search: "بحث",
  continueWatching: "تابع المشاهدة",
  trendingNow: "الأكثر رواجًا",
  recentlyUpdated: "حلقات جديدة",
  tvSeries: "مسلسلات",
  movies: "أفلام",
  featured: "مميّز",
  seeAllShort: "عرض الكل",
  watchNow: "شاهد الآن",
  myList: "قائمتي",
  newBadge: "جديد",

  // Detail
  watchEpisode: "شاهد هذه الحلقة",
  openAnimePage: "افتح صفحة الأنمي",
  failedToLoad: "تعذّر التحميل",
  notFound: "غير موجود",
  watchedBadge: "مُشاهَدة",
  addToList: "أضف إلى قائمتي",
  saved: "محفوظ",
  bothSources: "المصدران",

  // My List
  myListTitle: "قائمتي",
  currentlyWatching: "أتابع حاليًا",
  planToWatch: "خطّتي للمشاهدة",
  history: "السجلّ",
  emptyList: "قائمتك فارغة",
  emptyHistory: "لا يوجد سجلّ مشاهدة.",
  watched: "تمّت المشاهدة",
  progressPercent: (p: number) => `${p}٪ مشاهد`,

  // Search
  searchPlaceholder: "ابحث عن أنمي…",
  noResults: "لا توجد نتائج",

  // Watch / Player
  playNow: "▶ تشغيل",
  loadingServers: "جاري تحميل المصادر…",
  noServers: "لا توجد مصادر متاحة.",
  resolving: (n: string) => `جاري تحضير ${n}…`,
  noVideo: "تعذّر تشغيل الفيديو",
  servers: "المصادر",
  skipServer: "تخطّي هذا المصدر",

  // Sign out
  signOut: "تسجيل الخروج",
  guest: "زائر",
};

export const t = ar;
export type Translations = typeof ar;
