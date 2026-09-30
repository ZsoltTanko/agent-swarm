import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../src/ui/tokens.css", import.meta.url), "utf8");
const AGENT_COLORS = 12;

/** The custom properties declared in `block`, by name. */
function tokens(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

const darkAt = CSS.indexOf("@media (prefers-color-scheme: dark)");
const SCHEMES = { light: tokens(CSS.slice(0, darkAt)), dark: tokens(CSS.slice(darkAt)) };

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("agent ink tokens", () => {
  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  for (const [scheme, values] of Object.entries(SCHEMES)) {
    it(`keeps text on every agent color at least 4.5:1 (${scheme})`, () => {
      for (let i = 0; i < AGENT_COLORS; i++) {
        const color = values.get(`--agent-${i}`);
        const ink = values.get(`--agent-${i}-ink`);
        expect(color, `--agent-${i}`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(ink, `--agent-${i}-ink`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(color!, ink!), `--agent-${i}-ink on --agent-${i}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
