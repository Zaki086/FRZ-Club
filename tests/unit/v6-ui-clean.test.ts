// v6 §5 (UICLEAN): page descriptions are gone from every login (UI-1), help lives only in the ⓘ popover at the six
// allowed places (UI-2), the page header is compact (UI-3) and empty states / table rows are dense (UI-4). Rendering
// is checked with react-dom/server (no DOM in this suite); the "no page passes one" rules are source scans.
import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageHeader } from "@/components/page";
import { Empty } from "@/components/states";
import { TD, TH } from "@/components/ui/table";
import { InfoField, InfoTip, INFO_TIP_PLACES, infoTipNext, type InfoTipPlace } from "@/components/info-tip";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx$/.test(e.name) ? [p] : [];
  });
}
const FILES = walk(SRC).map((f) => ({ f: path.relative(ROOT, f), src: fs.readFileSync(f, "utf8") }));
// Marketing content on the public site is content, not a page description (decision noted in the v6 notes).
const MARKETING = /src\/app\/\(public\)\/(page|facilities\/page|plans\/page|privacy\/page|shop\/page|enquire\/page|trial\/page|availability\/page)\.tsx$/;
const APP = FILES.filter(({ f }) => !MARKETING.test(f));

/** Every `<PageHeader …/>` element's attribute text. */
function pageHeaders(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf("<PageHeader");
  while (i >= 0) {
    // Walk to the matching "/>" or ">" while skipping over {…} expressions.
    let depth = 0;
    let j = i + 11;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === ">") break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf("<PageHeader", j);
  }
  return out;
}

describe("UI-1 page descriptions are gone", () => {
  it("UI-1: PageHeader renders no description, even when an old call site still passes one", () => {
    const html = renderToStaticMarkup(h(PageHeader, { title: "Bar tabs", subtitle: "Every tab — open, carried over, settled or void." }));
    expect(html).toContain("Bar tabs");
    expect(html).not.toContain("Every tab");
    expect(html).not.toMatch(/<p\b/);
  });

  it("UI-1: no page passes a description to PageHeader; `meta` only ever carries the record's own data", () => {
    const offenders: string[] = [];
    const literalMeta: string[] = [];
    let headers = 0;
    for (const { f, src } of FILES) {
      for (const tag of pageHeaders(src)) {
        headers++;
        if (/\bsubtitle=/.test(tag)) offenders.push(f);
        if (/\bmeta="/.test(tag)) literalMeta.push(f);
      }
    }
    expect(headers).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
    expect(literalMeta).toEqual([]);
  });

  it("UI-1: no hand-written explanatory paragraph sits under a page title on any login", () => {
    const offenders: string[] = [];
    for (const { f, src } of APP) {
      const lines = src.split("\n");
      lines.forEach((l, i) => {
        if (!/<h1\b/.test(l)) return;
        const next = lines.slice(i + 1, i + 3).join("\n");
        // A literal sentence of 40+ characters in a muted paragraph right under the title.
        if (/<p className="[^"]*text-muted-foreground[^"]*">\s*[A-Z][^<{]{40,}/.test(next)) offenders.push(`${f}:${i + 1}`);
      });
    }
    // The 404/403/offline/"being set up" screens' sentence is the screen's whole message, not a description of it.
    expect(offenders.filter((o) => !/src\/app\/(not-found|forbidden)\.tsx|offline\/page\.tsx|\(staff\)\/app\/layout\.tsx/.test(o))).toEqual([]);
  });

  it("UI-1: dialogs carry no explanatory description — only data (Due now, Expected, The safe holds …)", () => {
    const literal: string[] = [];
    for (const { f, src } of FILES) {
      for (const m of src.matchAll(/<DialogContent\b[^>]*?\bdescription="([^"]+)"/g)) literal.push(`${f}: ${m[1].slice(0, 40)}`);
    }
    // Kept: "Close courts" states what the destructive action does to every booking (a consequence, not help).
    expect(literal.filter((l) => !l.includes("close-courts-dialog.tsx"))).toEqual([]);
  });
});

describe("UI-2 help only in the ⓘ popover, only where it prevents mistakes", () => {
  it("UI-2: the six allowed places", () => {
    expect([...INFO_TIP_PLACES].sort()).toEqual(
      ["blind-count", "price-book-precedence", "refund-identity", "send-all-preflight", "variance-tolerance", "whatsapp-opt-in"].sort(),
    );
  });

  it("UI-2: the ⓘ is used only at allowed places, and each built place is wired", () => {
    const used = new Map<string, string[]>();
    for (const { f, src } of FILES) {
      if (f.endsWith("info-tip.tsx")) continue;
      for (const m of src.matchAll(/<Info(?:Tip|Field)\b[^>]*?\bplace="([^"]+)"/g)) used.set(m[1], [...(used.get(m[1]) ?? []), f]);
      // Every use names its place literally, so this scan sees all of them.
      for (const m of src.matchAll(/<Info(?:Tip|Field)\b([^>]*)/g)) expect(m[1]).toMatch(/\bplace="/);
    }
    for (const place of used.keys()) expect(INFO_TIP_PLACES).toContain(place as InfoTipPlace);
    for (const place of ["blind-count", "variance-tolerance", "refund-identity", "price-book-precedence", "whatsapp-opt-in"]) {
      expect(used.get(place)?.length ?? 0, place).toBeGreaterThan(0);
    }
  });

  it("UI-2: the ⓘ is an accessible button: aria-label, aria-expanded, aria-controls the note; closed by default", () => {
    const html = renderToStaticMarkup(h(InfoTip, { place: "blind-count", label: "About the blind count", children: "Count every note." }));
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('aria-label="About the blind count"');
    expect(html).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toMatch(new RegExp(`<span id="${controls!.replace(/[:]/g, "\\:")}" role="note" hidden=""`));
    expect(html).toContain("focus-visible:ring-2");
    const open = renderToStaticMarkup(h(InfoTip, { place: "blind-count", label: "About", defaultOpen: true, children: "Count every note." }));
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('hidden=""');
  });

  it("UI-2: toggle opens and closes; Escape, a click outside and focus leaving close it", () => {
    expect(infoTipNext(false, "toggle")).toBe(true);
    expect(infoTipNext(true, "toggle")).toBe(false);
    expect(infoTipNext(false, "open")).toBe(true);
    for (const e of ["escape", "outside", "blur-out"] as const) expect(infoTipNext(true, e)).toBe(false);
  });

  it("UI-2: the ⓘ next to a field stays outside the <label>, so the input's name is exactly the label", () => {
    const html = renderToStaticMarkup(
      h(InfoField, { label: "Variance tolerance ₹", place: "variance-tolerance", infoLabel: "About the variance tolerance", info: "Over this needs approval.", children: h("input", {}) }),
    );
    const id = /<label for="([^"]+)"[^>]*>Variance tolerance ₹<\/label>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<input id="${id}"/>`);
    expect(html).not.toMatch(/<label[^>]*>[^]*<button[^]*<\/label>/);
  });
});

describe("UI-3 compact header", () => {
  it("UI-3: the title is a ~24–28 px heading (not the display size) on one line with the actions", () => {
    const html = renderToStaticMarkup(h(PageHeader, { title: "Refunds", actions: h("button", {}, "Pay out a refund") }));
    expect(html).toMatch(/<h1 class="[^"]*text-2xl[^"]*sm:text-\[1\.75rem\]/);
    expect(html).not.toMatch(/text-(3|4|5)xl/);
    expect(html).toMatch(/class="[^"]*flex[^"]*items-center[^"]*justify-between/);
    expect(html.indexOf("Refunds")).toBeLessThan(html.indexOf("Pay out a refund"));
  });

  it("UI-3: no staff or portal page has a display-size page title", () => {
    const big = APP.filter(({ f }) => /src\/app\/\((staff|member)\)\/(app|portal)\//.test(f)).flatMap(({ f, src }) =>
      [...src.matchAll(/<h1 className="([^"]*)"/g)].filter((m) => /text-(3|4|5)xl/.test(m[1])).map(() => f),
    );
    expect(big).toEqual([]);
  });
});

describe("UI-4 density", () => {
  it("UI-4: an empty state is one short line plus at most one action — no hint sentence", () => {
    const html = renderToStaticMarkup(h(Empty, { title: "No bar tabs yet", hint: "Your member discount is applied automatically at the bar." }));
    expect(html).toContain("No bar tabs yet");
    expect(html).not.toContain("member discount");
    expect((html.match(/<p\b/g) ?? []).length).toBe(1);
  });

  it("UI-4: no call site still writes an empty-state hint", () => {
    const hints = FILES.filter(({ src }) => /empty=\{\{[^\n]*\bhint:|<Empty\b[^>\n]*\bhint=/.test(src)).map(({ f }) => f);
    expect(hints).toEqual([]);
  });

  it("UI-4: compact table rows", () => {
    expect(renderToStaticMarkup(h("table", {}, h("tbody", {}, h("tr", {}, h(TD, {}, "x")))))).toMatch(/<td class="px-3 py-1\.5 /);
    expect(renderToStaticMarkup(h("table", {}, h("thead", {}, h("tr", {}, h(TH, {}, "x")))))).toMatch(/<th class="h-9 px-3 py-2 /);
  });

  it("UI-4: no paragraph-length toast", () => {
    const long = FILES.flatMap(({ f, src }) => [...src.matchAll(/toast(?:\.\w+)?\(\s*(["`])([^"`]*)\1/g)].filter((m) => m[2].length > 80).map(() => f));
    expect(long).toEqual([]);
  });
});
