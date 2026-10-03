// HTTPS for the club while the server's ports 80/443 belong to another project's Caddy (v3 §1, Path B).
// Runs a Cloudflare quick tunnel to the app on 127.0.0.1:3200 under PM2 ("champions-tunnel"). A quick tunnel gets
// a new https://*.trycloudflare.com address every time it starts, so this wrapper reads the address, writes it to
// .tunnel-url and, when it differs from APP_URL in .env, updates APP_URL and restarts only our own two processes
// (champions-web, champions-worker) so links, emails and HSTS use the live address.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.env.CLOUDFLARED_BIN ?? path.join(root, ".bin", "cloudflared");
const target = process.env.TUNNEL_TARGET ?? "http://127.0.0.1:3200";

function syncAppUrl(url) {
  writeFileSync(path.join(root, ".tunnel-url"), `${url}\n`);
  const envFile = path.join(root, ".env");
  const env = readFileSync(envFile, "utf8");
  const current = /^APP_URL="?([^"\n]*)"?/m.exec(env)?.[1];
  if (current === url) return;
  const next = /^APP_URL=/m.test(env) ? env.replace(/^APP_URL=.*$/m, `APP_URL="${url}"`) : `${env.trimEnd()}\nAPP_URL="${url}"\n`;
  writeFileSync(envFile, next);
  console.log(`[tunnel] APP_URL ${current ?? "(unset)"} → ${url}; restarting champions-web and champions-worker`);
  try {
    execFileSync("pm2", ["restart", "champions-web", "champions-worker", "--update-env"], { stdio: "inherit" });
  } catch (e) {
    console.error("[tunnel] restart failed", e);
  }
}

const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", target], { stdio: ["ignore", "pipe", "pipe"] });
let seen = false;
const scan = (chunk) => {
  const text = String(chunk);
  process.stdout.write(text);
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  if (m && !seen) {
    seen = true;
    syncAppUrl(m[0]);
  }
};
// Cloudflare drops idle quick tunnels; cloudflared then retries the dead tunnel for ever ("Tunnel not found").
// Exit instead, so PM2 starts a fresh tunnel and the new address reaches APP_URL.
let notFound = 0;
const watch = (chunk) => {
  if (/Tunnel not found/.test(String(chunk)) && ++notFound >= 3) {
    console.error("[tunnel] Cloudflare no longer knows this tunnel; starting a new one");
    child.kill("SIGTERM");
  }
};
child.stdout.on("data", watch);
child.stderr.on("data", watch);
child.stdout.on("data", scan);
child.stderr.on("data", scan);
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
