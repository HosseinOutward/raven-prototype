import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_THEME, parseTheme, THEME_COLORS, THEME_DEPTHS, THEME_STRENGTHS, themeTokens, type Theme } from "./theme";

function luminance(triplet: string) {
  const [h, s, l] = triplet.replaceAll("%", "").split(" ").map(Number);
  const chroma = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = l / 100 - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}

function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function everyTheme(): Theme[] {
  const colors: Pick<Theme, "color" | "customHue">[] = [
    ...THEME_COLORS.map((color) => ({ color: color.id, customHue: 0 })),
    // A custom colour can be any hue.
    ...Array.from({ length: 36 }, (_, step) => ({ color: "custom" as const, customHue: step * 10 })),
  ];
  return colors.flatMap((color) =>
    THEME_STRENGTHS.flatMap((strength) => THEME_DEPTHS.map((depth) => ({ ...color, strength: strength.id, depth: depth.id }))),
  );
}

describe("themeTokens", () => {
  test("the default theme is exactly what styles.css declares", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    for (const [name, value] of Object.entries(themeTokens(DEFAULT_THEME))) {
      expect(css).toContain(`--${name}: ${value};`);
    }
  });

  test("text stays readable in every combination", () => {
    for (const theme of everyTheme()) {
      const t = themeTokens(theme);
      const label = JSON.stringify(theme);
      expect({ label, ok: contrast(t.foreground, t.popover) >= 7 }).toEqual({ label, ok: true });
      expect({ label, ok: contrast(t["muted-foreground"], t.card) >= 4.5 }).toEqual({ label, ok: true });
      expect({ label, ok: contrast(t["subtle-foreground"], t.card) >= 4.5 }).toEqual({ label, ok: true });
      expect({ label, ok: contrast(t["primary-foreground"], t.primary) >= 4.5 }).toEqual({ label, ok: true });
    }
  });

  test("elevation runs canvas, surface, raised in every combination", () => {
    for (const theme of everyTheme()) {
      const t = themeTokens(theme);
      expect(luminance(t.background)).toBeLessThan(luminance(t.card));
      expect(luminance(t.card)).toBeLessThan(luminance(t.popover));
    }
  });

  test("a colour tints surfaces; Graphite ignores strength", () => {
    expect(themeTokens({ ...DEFAULT_THEME, color: "ocean" }).card).toBe("212 30% 9%");
    expect(themeTokens({ ...DEFAULT_THEME, strength: "vivid" })).toEqual(themeTokens(DEFAULT_THEME));
  });

  test("the colours that report something are not part of a theme", () => {
    const names = Object.keys(themeTokens(DEFAULT_THEME));
    for (const name of ["live", "speaking", "destructive", "warning"]) expect(names).not.toContain(name);
  });
});

describe("parseTheme", () => {
  test("nothing stored or unreadable gives the default", () => {
    expect(parseTheme(null)).toEqual(DEFAULT_THEME);
    expect(parseTheme("not json")).toEqual(DEFAULT_THEME);
    expect(parseTheme("12")).toEqual(DEFAULT_THEME);
  });

  test("a bad field falls back alone", () => {
    const stored = JSON.stringify({ color: "plum", customHue: 900, strength: "loud", depth: "lighter" });
    expect(parseTheme(stored)).toEqual({ ...DEFAULT_THEME, color: "plum", depth: "lighter" });
  });

  test("a custom hue round-trips", () => {
    const theme: Theme = { color: "custom", customHue: 12, strength: "vivid", depth: "darker" };
    expect(parseTheme(JSON.stringify(theme))).toEqual(theme);
  });
});
