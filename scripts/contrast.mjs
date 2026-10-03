// WCAG contrast check for the theme tokens (v3 §2.3). Reads the OKLCH values in src/app/globals.css and checks the
// text/background pairs the UI uses. `node scripts/contrast.mjs` exits non-zero if a pair misses AA.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const tok = Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]*\)|#[0-9a-f]{3,8})/gi)].map((m) => [m[1], m[2]]));

function oklchToRgb(s) {
  const [L, C, H] = s.replace(/oklch\(|\)/g, "").trim().split(/\s+/).map(Number);
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s3] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s3, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s3, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s3];
  return lin.map((v) => Math.min(1, Math.max(0, v)));
}
function hexToLin(hex) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  return [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}
const linOf = (v) => (v.startsWith("#") ? hexToLin(v) : oklchToRgb(v));
const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const dec = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** A token name, or "name/NN": the token at NN % opacity over the card (browsers blend in sRGB). */
function colour(spec) {
  const [name, pct] = spec.split("/");
  if (!tok[name]) return null;
  if (!pct) return linOf(tok[name]);
  const a = Number(pct) / 100;
  const fg = linOf(tok[name]).map(enc);
  const bg = linOf(tok.card).map(enc);
  return fg.map((c, i) => dec(a * c + (1 - a) * bg[i]));
}
const lumOf = (lin) => 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
const ratio = (a, b) => {
  const [x, y] = [lumOf(colour(a)), lumOf(colour(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum]
const PAIRS = [
  ["foreground", "background", 4.5], ["foreground", "card", 4.5], ["muted-foreground", "background", 4.5], ["muted-foreground", "card", 4.5],
  ["muted-foreground", "muted", 4.5], ["primary", "background", 4.5], ["primary-foreground", "primary", 4.5], ["accent-foreground", "accent", 4.5],
  ["secondary-foreground", "secondary", 4.5], ["destructive", "card", 4.5], ["destructive-foreground", "destructive", 4.5], ["success-text", "card", 4.5],
  ["success-foreground", "success", 4.5], ["warning-text", "card", 4.5], ["warning-foreground", "warning", 4.5], ["ink-foreground", "ink", 4.5],
  ["sidebar-foreground", "sidebar", 4.5], ["sidebar-primary-foreground", "sidebar-primary", 4.5], ["sidebar-accent-foreground", "sidebar-accent", 4.5],
  ["accent", "ink", 3], ["ring", "background", 3], ["input", "card", 3],
  // v3 §10 page port: tinted chips and states (token text on a translucent token over the card).
  ["primary", "primary/15", 4.5], ["junior", "junior/20", 4.5], ["junior", "junior/10", 4.5], ["success-text", "success/25", 4.5],
  ["success-text", "success/10", 4.5], ["warning-foreground", "warning/40", 4.5], ["warning-text", "warning/15", 4.5],
  ["destructive", "destructive/10", 4.5], ["accent", "ink", 4.5], ["muted-foreground", "secondary", 4.5],
];
let bad = 0;
for (const [f, b, min] of PAIRS) {
  if (!colour(f) || !colour(b)) {
    console.log(`?? ${f} on ${b}: token missing`);
    bad++;
    continue;
  }
  const r = ratio(f, b);
  const ok = r >= min;
  if (!ok) bad++;
  console.log(`${ok ? "ok " : "LOW"} ${r.toFixed(2).padStart(5)}  ${f} on ${b} (needs ${min})`);
}
process.exit(bad ? 1 : 0);
