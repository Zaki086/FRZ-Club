// `npm run audit:dummy` (completion pass §10): is anything fake left?
//  1. Source scan — dummy markers in src/ (fixed identities, sample domains, test gateways, placeholder images,
//     TODOs, stock phrases). Every hit is either a violation or on the allow-list below, with the reason.
//  2. Crawl — every role visits every page in its menu on a desktop and a 360 px phone (tests/audit/crawl.spec.ts).
// Writes AUDIT.md and exits non-zero when anything needs fixing. Needs the app running at APP_URL with sample data.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

type Rule = { id: string; what: string; re: RegExp };
const RULES: Rule[] = [
  { id: "fixed-identity", what: "a hard-coded club name, address, UPI ID or city", re: /The Champions Club|Champions Club|championsclub@|@testupi|Ahmedabad|SG Highway/ },
  { id: "sample-domain", what: "sample e-mail domains", re: /@example\.(com|org|net)|@[a-z0-9-]+\.test\b|@[a-z0-9-]+\.example\b/i },
  { id: "test-gateway", what: "test payment gateway / test mode", re: /test[_ -]?gateway|TEST MODE|rzp_test_/i },
  { id: "placeholder-media", what: "stock or placeholder images", re: /unsplash\.com|picsum\.photos|placehold(\.co|er\.com)|via\.placeholder|loremflickr/i },
  { id: "lorem", what: "lorem ipsum / dummy copy", re: /lorem ipsum|dolor sit amet/i },
  { id: "todo", what: "unfinished work markers", re: /\b(TODO|FIXME|XXX|HACK)\b/ },
  { id: "dummy-word", what: "the words dummy / fake / mock", re: /\b(dummy|fake|mocked?)\b/i },
  { id: "coming-soon", what: "'coming soon' promises", re: /coming soon/i },
  { id: "phone-number", what: "hard-coded mobile numbers", re: /(?<![\d.])[6-9]\d{9}(?!\d)/ },
  { id: "gstin", what: "hard-coded GSTINs", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/ },
];

/** Hits that are deliberate. Matched on file path + rule; each says why. */
const ALLOW: Array<{ file: RegExp; rule: string; why: string }> = [
  { file: /src\/server\/services\/gateway\.ts$/, rule: "test-gateway", why: "the Test Gateway exists only when NODE_ENV=test (selection throws otherwise)" },
  { file: /src\/app\/\(public\)\/pay\/test\//, rule: "test-gateway", why: "page returns 404 unless NODE_ENV=test" },
  { file: /src\/app\/api\/payments\/test-gateway\//, rule: "test-gateway", why: "route returns 404 unless NODE_ENV=test" },
  { file: /src\/server\/services\/payments\.ts$/, rule: "test-gateway", why: "comments describing the test-only path" },
  { file: /src\/server\/services\/capabilities\.ts$/, rule: "test-gateway", why: "reports 'test gateway (tests only)' as the reason under NODE_ENV=test" },
  { file: /src\/lib\/states\.ts$/, rule: "fixed-identity", why: "the list of Indian states (Gujarat is one of them)" },
  { file: /src\/lib\/codes\.ts$/, rule: "fixed-identity", why: "doc comment showing how initials are made" },
  { file: /src\/lib\/codes\.ts$/, rule: "phone-number", why: "doc comment showing the phone formats normalisePhone accepts" },
  { file: /src\/server\/services\/settings\.ts$/, rule: "fixed-identity", why: "comment only: the defaults are empty" },
  { file: /scripts\/audit-dummy\.ts$/, rule: "*", why: "this file lists the patterns" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|js|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

type Hit = { rule: string; file: string; line: number; text: string; allowed: string | null };
const hits: Hit[] = [];
for (const file of [...walk("src"), "public/sw.js"]) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, i) => {
    for (const r of RULES) {
      if (!r.re.test(text)) continue;
      const allow = ALLOW.find((a) => a.file.test(file) && (a.rule === r.id || a.rule === "*"));
      hits.push({ rule: r.id, file, line: i + 1, text: text.trim().slice(0, 140), allowed: allow?.why ?? null });
    }
  });
}

// 2. Crawl (unless --source-only).
type Crawl = { role: string; path: string; viewport: string; status: number; consoleErrors: string[]; dummyText: string | null; overflowPx: number; menuMismatch?: string | null };
let crawl: Crawl[] = [];
let crawlNote = "";
if (!process.argv.includes("--source-only")) {
  const out = path.resolve(process.env.TMPDIR ?? "/tmp", `audit-crawl-${process.pid}.json`);
  try {
    execFileSync("npx", ["playwright", "test", "--config", "playwright.audit.config.ts"], { stdio: "inherit", env: { ...process.env, AUDIT_OUT: out } });
  } catch {
    crawlNote = "The crawler itself reported a failure; see the console output.";
  }
  try {
    crawl = JSON.parse(readFileSync(out, "utf8")) as Crawl[];
  } catch {
    crawlNote = "No crawl results (is the app running at APP_URL with sample data?).";
  }
}

const violations = hits.filter((h) => !h.allowed);
const badStatus = crawl.filter((c) => c.status >= 400 || c.status === 0);
const consoleErr = crawl.filter((c) => c.consoleErrors.length);
const dummyText = crawl.filter((c) => c.dummyText);
const overflow = crawl.filter((c) => c.viewport === "360px" && c.overflowPx > 1);
// v4 §1.4: each staff role's rendered sidebar must be its navigation list (the §1.1 lists for Owner, Manager, Front desk).
const menuMismatch = crawl.filter((c) => c.menuMismatch);
const visits = crawl.filter((c) => c.path !== "(sidebar)");
const problems = violations.length + badStatus.length + consoleErr.length + dummyText.length + overflow.length + menuMismatch.length;
const esc = (s: string) => s.replace(/\|/g, "\\|");

const md = [
  "# AUDIT — real or absent",
  "",
  `Generated by \`npm run audit:dummy\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. ${problems === 0 ? "**No problems found.**" : `**${problems} problem(s) to fix.**`}`,
  "",
  "## 1. Source scan",
  "",
  `${hits.length} hit(s) in \`src/\` for ${RULES.length} patterns: **${violations.length} violation(s)**, ${hits.length - violations.length} allowed with a reason.`,
  "",
  "| Pattern | What it catches | Violations | Allowed |",
  "|---|---|---|---|",
  ...RULES.map((r) => `| \`${r.id}\` | ${r.what} | ${violations.filter((h) => h.rule === r.id).length} | ${hits.filter((h) => h.rule === r.id && h.allowed).length} |`),
  "",
  ...(violations.length ? ["### Violations", "", "| Pattern | Where | Line |", "|---|---|---|", ...violations.map((h) => `| ${h.rule} | \`${h.file}:${h.line}\` | \`${esc(h.text)}\` |`), ""] : []),
  ...(hits.some((h) => h.allowed) ? ["### Allowed (deliberate)", "", "| Pattern | Where | Why |", "|---|---|---|", ...hits.filter((h) => h.allowed).map((h) => `| ${h.rule} | \`${h.file}:${h.line}\` | ${h.allowed} |`), ""] : []),
  "## 2. Crawl — every role, every page, desktop and 360 px",
  "",
  crawlNote || `${new Set(visits.map((c) => `${c.role} ${c.path}`)).size} role × page combinations, ${visits.length} page loads, roles: ${[...new Set(visits.map((c) => c.role))].join(", ")}.`,
  "",
  "| Check | Problems |",
  "|---|---|",
  `| HTTP error or no response | ${badStatus.length} |`,
  `| Browser console errors | ${consoleErr.length} |`,
  `| Dummy text on screen (lorem, undefined, NaN, [object Object], TODO, test mode…) | ${dummyText.length} |`,
  `| Wider than a 360 px phone (horizontal scroll) | ${overflow.length} |`,
  `| Sidebar differs from the role's navigation list (v4 §1.1) | ${menuMismatch.length} |`,
  "",
  ...(badStatus.length ? ["### HTTP errors", "", ...badStatus.map((c) => `- ${c.role} · \`${c.path}\` (${c.viewport}) → ${c.status}`), ""] : []),
  ...(consoleErr.length ? ["### Console errors", "", ...consoleErr.map((c) => `- ${c.role} · \`${c.path}\` (${c.viewport}): ${esc(c.consoleErrors[0])}`), ""] : []),
  ...(dummyText.length ? ["### Dummy text", "", ...dummyText.map((c) => `- ${c.role} · \`${c.path}\` (${c.viewport}): “${esc(c.dummyText!)}”`), ""] : []),
  ...(overflow.length ? ["### Too wide on a phone", "", ...overflow.map((c) => `- ${c.role} · \`${c.path}\`: ${c.overflowPx}px wider than the screen`), ""] : []),
  ...(menuMismatch.length ? ["### Sidebar differs from the navigation list", "", ...menuMismatch.map((c) => `- ${c.role}: ${esc(c.menuMismatch!)}`), ""] : []),
  "## Pages visited",
  "",
  ...[...new Set(visits.map((c) => c.role))].map((role) => `- **${role}:** ${[...new Set(visits.filter((c) => c.role === role).map((c) => `\`${c.path}\``))].join(", ")}`),
  "",
].join("\n");

writeFileSync("AUDIT.md", md);
console.log(`AUDIT.md written: ${violations.length} source violation(s), ${badStatus.length} HTTP error(s), ${consoleErr.length} console-error page(s), ${dummyText.length} dummy-text page(s), ${overflow.length} too-wide page(s), ${menuMismatch.length} sidebar mismatch(es).`);
process.exit(problems === 0 ? 0 : 1);
