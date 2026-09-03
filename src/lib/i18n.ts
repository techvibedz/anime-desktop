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
  completedBadge: "مكتمل",
  caughtUpBadge: "آخر حلقة",
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
  refreshServers: "تحديث المصادر",
  loadingMoreServers: "جاري البحث عن مصادر إضافية…",
  skipIntro: "تخطّي المقدمة",

  // Sign out
  signOut: "تسجيل الخروج",
  guest: "زائر",

  // Refresh
  refresh: "تحديث الصفحة",

  // Source-direct home rails
  railThisSeason: "أنمي هذا الموسم",
  railMovies: "أفلام الأنمي",

  // Downloads
  downloadsTitle: "التنزيلات",
  download: "تنزيل",
  downloadEpisode: "تنزيل الحلقة",
  downloadStarted: "بدأ التنزيل",
  downloading: "جارٍ التنزيل…",
  downloaded: "تم التنزيل",
  downloadQueued: "في قائمة الانتظار",
  downloadFailed: "فشل التنزيل",
  downloadRetry: "إعادة التنزيل",
  watchOffline: "مشاهدة بدون إنترنت",
  playDownload: "تشغيل",
  removeDownload: "حذف التنزيل",
  confirmRemoveDownload: "هل تريد حذف هذه الحلقة المُنزَّلة؟",
  downloadsEmpty: "لا توجد تنزيلات",
  downloadsEmptySub: "نزّل الحلقات لمشاهدتها لاحقًا بدون إنترنت.",
  downloadNoServer: "تعذّر العثور على مصدر قابل للتنزيل لهذه الحلقة.",
  downloadResolving: "جارٍ تحضير التنزيل…",
  downloadOffline: "حلقة مُنزَّلة — تُشغَّل بدون إنترنت",
  chooseDownloadServer: "اختر جودة التنزيل",
  chooseDownloadServerSub: "اختر السيرفر والدقة التي تريد تنزيلها",
  storageUsed: (s: string) => `المساحة المستخدمة: ${s}`,

  // Upcoming anime
  upcomingTitle: "أنميات قادمة",
  upcomingSub: "أبرز الأنميات المنتظرة التي ستتوفّر في مصادرنا فور صدورها.",
  upcomingSoon: "قريبًا",
  upcomingFilterPopular: "الأكثر شعبية",
  upcomingFilterSoon: "الأقرب صدورًا",
  upcomingInDays: (n: number) => (n === 1 ? "بعد يوم" : n === 2 ? "بعد يومين" : n <= 10 ? `بعد ${n} أيام` : `بعد ${n} يومًا`),

  // Seasons browser
  seasonsTitle: "المواسم",
  seasonsEmpty: "لا أنميات متوفّرة",
  seasonsEmptySub: "لم نعثر على أنميات من هذا الموسم في مصادرنا. جرّب موسمًا آخر.",

  // Schedule
  scheduleTitle: "جدول الحلقات",
  scheduleEmpty: "لا حلقات مجدولة لهذا اليوم.",
  scheduleToday: "اليوم",
  scheduleAt: (s: string) => `الساعة ${s}`,
  scheduleEp: (n: number) => `الحلقة ${n}`,

  // AniList title detail (Upcoming detail page)
  titleStory: "القصة",
  titleDetails: "تفاصيل",
  titleLinks: "روابط وأخبار",
  titleRelated: "أعمال ذات صلة",
  watchTrailer: "مشاهدة الإعلان",
  searchOnSources: "ابحث في مصادرنا",
  translating: "جارٍ ترجمة القصة…",
  titleNotReleased: "لم يصدر بعد",
  titleAirsOn: (d: string) => `يبدأ العرض: ${d}`,
  titleEpisodes: (n: number) => `${n} حلقة`,
  titleStudio: "الاستوديو",
  titleStatus: "الحالة",
  titleFormat: "النوع",
  titleAirDate: "موعد العرض",
  titleDuration: (n: number) => `${n} دقيقة`,
  statusReleasing: "يُعرض حالياً",
  statusFinished: "مكتمل",
  statusNotYet: "لم يُعرض بعد",
  statusCancelled: "أُلغي",
  statusHiatus: "متوقّف مؤقتاً",

  // Watch — episode list sidebar
  allEpisodes: "كل الحلقات",

  // Watch Party — "شاهد معاً"
  wpTitle: "المشاهدة المشتركة",
  wpSub: "أنشئ غرفة وشاهد الأنمي مع أصدقائك في نفس اللحظة.",
  wpCreate: "إنشاء غرفة",
  wpCreating: "جارٍ الإنشاء…",
  wpJoin: "انضمام",
  wpJoinPlaceholder: "أدخل رمز الغرفة",
  wpRoomCode: "رمز الغرفة",
  wpShareHint: "شارك هذا الرمز مع أصدقائك لينضموا.",
  wpWaiting: "بانتظار انضمام الأصدقاء…",
  wpInRoom: (n: number) => `${n} في الغرفة`,
  wpHost: "المضيف",
  wpYou: "أنت",
  wpHostPicking: "بانتظار أن يختار المضيف حلقة…",
  wpStartWatching: "ابدأ المشاهدة",
  wpStartWatchingHint: "افتح أي حلقة الآن لبثها إلى ضيوفك.",
  wpLeave: "مغادرة الغرفة",
  wpLeaveParty: "إنهاء المشاركة",
  wpInvalidCode: "رمز غير صالح",
  wpSignInRequired: "سجّل الدخول لاستخدام المشاهدة المشتركة.",
  wpHostPaused: "أوقف المضيف التشغيل",
  wpHostPlaying: "يتحكم المضيف بالتشغيل",
  wpFollowing: "تتابع المضيف",
  wpPartyBtn: "شاهد معاً",
};

export const t = ar;
export type Translations = typeof ar;
