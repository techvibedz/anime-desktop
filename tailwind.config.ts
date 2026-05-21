import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#06071A",
        surface: "#0E0926",
        accent: "#FF2D55",
        "accent-bright": "#FF457A",
        violet: "#7B5CFF",
        indigo: "#5B6BFF",
        gold: "#FFC93C",
        green: "#33D17A",
        text: "#FFFFFF",
        "text-secondary": "rgba(255,255,255,0.78)",
        "text-muted": "rgba(255,255,255,0.5)",
        glass: "rgba(255,255,255,0.04)",
        "glass-border": "rgba(255,255,255,0.08)",
      },
      fontFamily: {
        display: ["Outfit", "system-ui", "sans-serif"],
        sans: ["DM Sans", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(255,45,85,0.35), 0 4px 16px rgba(0,0,0,0.5)",
        card: "0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
      },
    },
  },
  plugins: [],
} satisfies Config;
