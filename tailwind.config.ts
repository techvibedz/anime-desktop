import type { Config } from "tailwindcss";

// "The Personal Screening Room" — the mobile app's palette (anime-mobile
// DESIGN.md / lib/theme.ts): near-black canvas, periwinkle primary, mint
// secondary, gold for ratings. Filled accent/mint controls carry DARK labels
// (`text-black` / `text-on-accent`), never white. Token names are unchanged so
// every screen picks the new palette up.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#08090C",
        "bg-deep": "#050507",
        surface: "#14161C",
        "surface-container": "#101218",
        raised: "#1C1F27",
        accent: "#8B93FF",
        "accent-bright": "#A5ABFF",
        "on-accent": "#0A0B12",
        mint: "#5EEAD4",
        violet: "#7C6CF2",
        indigo: "#6A72E8",
        gold: "#FFCE5C",
        green: "#4ADE80",
        danger: "#FF6B6B",
        text: "#FFFFFF",
        "text-secondary": "#B4B8C5",
        "text-muted": "#8A8F9E",
        "glass-border": "rgba(255,255,255,0.08)",
        // Manga's own ink-and-paper palette (mobile lib/manga/design parity) —
        // deliberately independent of the anime UI.
        m: {
          paper: "#F5F1E8",
          sheet: "#FFFCF6",
          wash: "#EBE5D9",
          ink: "#22231F",
          muted: "#68675E",
          line: "#D9D2C5",
          accent: "#B83E25",
          "accent-wash": "#F4E1D7",
          read: "#38634F",
          "read-wash": "#DFE9DF",
          rating: "#8B5A14",
          night: "#181916",
          "night-panel": "#252621",
          "night-muted": "#C4C0B5",
          "night-line": "#42443B",
          "night-accent": "#F09572",
        },
      },
      fontFamily: {
        // Cairo carries Arabic (the first-class script); Outfit sets Latin
        // titles and numerals in display sizes.
        display: ['"Outfit Variable"', '"Cairo Variable"', "system-ui", "sans-serif"],
        sans: ['"Cairo Variable"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "16px",
        control: "14px",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(139,147,255,0.45), 0 12px 32px -8px rgba(139,147,255,0.35)",
        card: "0 18px 40px -12px rgba(0,0,0,0.7)",
        lift: "0 24px 48px -16px rgba(0,0,0,0.85)",
      },
      // Semantic z scale: rail arrows < sticky chrome < modal < toast.
      zIndex: {
        rail: "20",
        sticky: "40",
        modal: "100",
        toast: "200",
        player: "9999",
      },
      keyframes: {
        rise: { from: { opacity: "0", transform: "translateY(10px)" }, to: { opacity: "1", transform: "none" } },
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        kenburns: { from: { transform: "scale(1)" }, to: { transform: "scale(1.08)" } },
        sheetUp: { from: { opacity: "0", transform: "translateY(24px) scale(0.98)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: {
        rise: "rise 420ms cubic-bezier(0.22,1,0.36,1) both",
        fadeIn: "fadeIn 300ms ease-out both",
        kenburns: "kenburns 9s ease-out both",
        sheetUp: "sheetUp 280ms cubic-bezier(0.22,1,0.36,1) both",
      },
    },
  },
  plugins: [],
} satisfies Config;
