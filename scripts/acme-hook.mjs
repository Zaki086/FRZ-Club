#!/usr/bin/env node
// lego "exec" DNS provider hook for scripts/https.mjs: `acme-hook.mjs present|cleanup <fqdn> <value>`.
// Keeps the pending `_acme-challenge` TXT values in .certs/acme-txt.json, which the challenge DNS server reads.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".certs", "acme-txt.json");
const [action, fqdn, value] = process.argv.slice(2);
if (!["present", "cleanup"].includes(action) || !fqdn || !value) {
  console.error("usage: acme-hook.mjs present|cleanup <fqdn> <value>");
  process.exit(2);
}
let txt = {};
try {
  txt = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  /* first value */
}
const name = fqdn.toLowerCase().endsWith(".") ? fqdn.toLowerCase() : `${fqdn.toLowerCase()}.`;
const values = new Set(txt[name] ?? []);
if (action === "present") values.add(value);
else values.delete(value);
txt[name] = [...values];
fs.writeFileSync(file, JSON.stringify(txt), { mode: 0o600 });
