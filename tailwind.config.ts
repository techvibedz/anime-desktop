import type { Config } from "tailwindcss";

// Cinematic dark system — near-black canvas, luminous green primary (hue 113),
// violet secondary accent. Text on `accent` fills is BLACK (pale saturated
// fill); text on `violet` fills is white.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "oklch(8% 0 0)",
        surface: "oklch(14.5% 0.004 113)",
        raised: "oklch(19% 0.006 113)",
        accent: "oklch(80% 0.17 113)",
        "accent-bright": "oklch(86% 0.16 113)",
        violet: "oklch(58% 0.15 300)",
        indigo: "oklch(58% 0.15 280)",
        gold: "oklch(83% 0.12 90)",
        green: "oklch(72% 0.19 145)",
        text: "oklch(96% 0.005 113)",
        "text-secondary": "oklch(80% 0.008 113)",
        "text-muted": "oklch(63% 0.01 113)",
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
        display: ['"IBM Plex Sans Arabic"', "system-ui", "sans-serif"],
        sans: ['"IBM Plex Sans Arabic"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 20px oklch(80% 0.17 113 / 0.25)",
        card: "0 12px 32px rgba(0,0,0,0.55)",
      },
      // Semantic z scale: rail arrows < sticky chrome < modal < toast.
      zIndex: {
        rail: "20",
        sticky: "40",
        modal: "100",
        toast: "200",
        player: "9999",
      },
    },
  },
  plugins: [],
} satisfies Config;
