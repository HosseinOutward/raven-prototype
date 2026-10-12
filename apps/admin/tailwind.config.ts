import type { Config } from "tailwindcss";

// The same tokens as the desktop app (apps/desktop/tailwind.config.ts), so the dashboard
// reads as part of Raven. Change them there first.
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist Variable", "Segoe UI Variable Text", "Segoe UI", "system-ui", "-apple-system", "sans-serif"],
        mono: ["Geist Mono Variable", "Cascadia Mono", "Consolas", "ui-monospace", "monospace"],
      },
      fontSize: {
        caption: ["12px", { lineHeight: "16px" }],
        small: ["13px", { lineHeight: "18px" }],
        body: ["14px", { lineHeight: "20px" }],
        "title-sm": ["15px", { lineHeight: "20px", letterSpacing: "-0.005em" }],
        title: ["18px", { lineHeight: "24px", letterSpacing: "-0.012em" }],
        display: ["24px", { lineHeight: "30px", letterSpacing: "-0.02em" }],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        subtle: "hsl(var(--subtle-foreground))",
        warning: "hsl(var(--warning))",
        live: "hsl(var(--live))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          fill: "hsl(var(--destructive-fill))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: "hsl(var(--card))",
        popover: "hsl(var(--popover))",
      },
      borderRadius: { chip: "6px", control: "8px", card: "12px", panel: "16px" },
      boxShadow: {
        raised: "0 0 0 1px hsl(var(--border)), 0 16px 48px rgb(0 0 0 / 0.5)",
      },
    },
  },
  plugins: [],
} satisfies Config;
