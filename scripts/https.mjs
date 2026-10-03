// HTTPS for the club on a fixed address with a real Let's Encrypt certificate (v3 §1 Path B, replacing the quick
// tunnel). Ports 80/443 on this server belong to another project's Caddy, so:
//   • the certificate comes from the DNS-01 challenge: sslip.io / nip.io delegate `_acme-challenge.<name>` to the IP
//     inside the name (this server), so while lego runs this process answers those TXT queries on <ip>:53;
//   • the club is served on its own HTTPS port (HTTPS_PORT, default 3443) and every request is forwarded to the app
//     on 127.0.0.1:3200 with X-Forwarded-Proto/Host/For;
//   • the certificate is checked twice a day and renewed 30 days before it expires, without a restart.
// Runs under PM2 as "champions-https". Settings come from .env: HTTPS_HOSTS (comma-separated names, the first is the
// public address), HTTPS_PORT, HTTPS_DNS_BIND (this server's public IP), ACME_EMAIL (optional).
// `node scripts/https.mjs --issue-only [--staging]` only obtains/renews the certificate and exits.
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* no .env: use the environment as it is */
}

const args = new Set(process.argv.slice(2));
const HOSTS = (process.env.HTTPS_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const PORT = Number(process.env.HTTPS_PORT ?? 3443);
const DNS_BIND = process.env.HTTPS_DNS_BIND ?? "";
const TARGET = { host: "127.0.0.1", port: Number(process.env.HTTPS_TARGET_PORT ?? 3200) };
const LEGO = process.env.LEGO_BIN ?? path.join(root, ".bin", "lego");
const CERT_DIR = path.join(root, ".certs");
const LEGO_PATH = path.join(CERT_DIR, "lego");
export const TXT_FILE = path.join(CERT_DIR, "acme-txt.json");
const RENEW_DAYS = 30;
const CHECK_EVERY_MS = 12 * 3600_000;

const log = (...a) => console.log("[https]", ...a);
if (!HOSTS.length || !DNS_BIND) {
  console.error("[https] set HTTPS_HOSTS and HTTPS_DNS_BIND in .env");
  process.exit(1);
}
fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });

// ───────────── the certificate files lego writes ─────────────
function certFiles() {
  const dir = path.join(LEGO_PATH, "certificates");
  if (!fs.existsSync(dir)) return null;
  // lego names the files after the first domain (v4: <name>.crt/.key; v5 may add a folder level — search for it).
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(dir);
  const crt = files.find((f) => f.endsWith(".crt") && !f.endsWith(".issuer.crt") && path.basename(f).startsWith(HOSTS[0]));
  const key = files.find((f) => f.endsWith(".key") && path.basename(f).startsWith(HOSTS[0]));
  return crt && key ? { crt, key } : null;
}

function daysLeft(crtFile) {
  const cert = new X509Certificate(fs.readFileSync(crtFile));
  return (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
}

// ───────────── a tiny authoritative DNS server for _acme-challenge.<host> (only while lego runs) ─────────────
const zones = HOSTS.map((h) => `_acme-challenge.${h}`);

function readTxt() {
  try {
    return JSON.parse(fs.readFileSync(TXT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function encodeName(name) {
  const parts = name.replace(/\.$/, "").split(".");
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
}

function rr(type, ttl, rdata) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(1, 2); // IN
  h.writeUInt32BE(ttl, 4);
  h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([Buffer.from([0xc0, 12]), h, rdata]); // name = the question's name (pointer to offset 12)
}

function soaRdata(zone) {
  const host = zone.replace(/^_acme-challenge\./, "");
  const nums = Buffer.alloc(20);
  nums.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  nums.writeUInt32BE(3600, 4);
  nums.writeUInt32BE(600, 8);
  nums.writeUInt32BE(86400, 12);
  nums.writeUInt32BE(60, 16);
  return Buffer.concat([encodeName(host), encodeName(`hostmaster.${host}`), nums]);
}

/** Answer one DNS query; null = drop it. Names are compared case-insensitively (resolvers randomise case). */
export function answerDns(msg) {
  if (msg.length < 17) return null;
  const qd = msg.readUInt16BE(4);
  if (qd !== 1) return null;
  let i = 12;
  const labels = [];
  while (i < msg.length && msg[i] !== 0) {
    const len = msg[i];
    if (len > 63 || i + 1 + len > msg.length) return null;
    labels.push(msg.subarray(i + 1, i + 1 + len).toString("latin1"));
    i += 1 + len;
  }
  if (i + 5 > msg.length) return null;
  const qtype = msg.readUInt16BE(i + 1);
  const question = msg.subarray(12, i + 5);
  const qname = labels.join(".").toLowerCase();
  const zone = zones.find((z) => qname === z || qname.endsWith(`.${z}`));
  const flags = Buffer.alloc(2);
  // QR=1, opcode 0, AA=1 when it is ours, RD copied; RCODE 5 (REFUSED) for names that aren't ours.
  flags[0] = 0x80 | (zone ? 0x04 : 0) | (msg[2] & 0x01);
  flags[1] = zone ? 0 : 5;
  const answers = [];
  const authority = [];
  if (zone) {
    const values = qname === zone ? (readTxt()[`${zone}.`] ?? readTxt()[zone] ?? []) : [];
    if (qtype === 16 /* TXT */ || qtype === 255 /* ANY */) {
      for (const v of values) {
        const b = Buffer.from(v);
        answers.push(rr(16, 60, Buffer.concat([Buffer.from([b.length]), b])));
      }
    } else if (qtype === 6 /* SOA */ && qname === zone) {
      answers.push(rr(6, 60, soaRdata(zone)));
    } else if (qtype === 2 /* NS */ && qname === zone) {
      answers.push(rr(2, 60, encodeName(zone.replace(/^_acme-challenge\./, ""))));
    }
    if (!answers.length) {
      // NOERROR/NODATA with the zone's SOA (its owner is the zone, written out in full).
      const h = Buffer.alloc(10);
      const rd = soaRdata(zone);
      h.writeUInt16BE(6, 0);
      h.writeUInt16BE(1, 2);
      h.writeUInt32BE(60, 4);
      h.writeUInt16BE(rd.length, 8);
      authority.push(Buffer.concat([encodeName(zone), h, rd]));
    }
  }
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2);
  flags.copy(header, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, question, ...answers, ...authority]);
}

function startDns() {
  const udp = dgram.createSocket("udp4");
  udp.on("message", (msg, r) => {
    const out = answerDns(msg);
    if (out) udp.send(out, r.port, r.address);
  });
  udp.on("error", (e) => log("dns udp error", e.message));
  const tcp = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.setTimeout(10_000, () => sock.destroy());
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
        buf = buf.subarray(2 + msg.length);
        const out = answerDns(msg);
        if (out) {
          const len = Buffer.alloc(2);
          len.writeUInt16BE(out.length);
          sock.write(Buffer.concat([len, out]));
        }
      }
    });
    sock.on("error", () => sock.destroy());
  });
  return new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(53, DNS_BIND, () => {
      tcp.listen(53, DNS_BIND, () => {
        log(`answering _acme-challenge on ${DNS_BIND}:53 for ${HOSTS.join(", ")}`);
        resolve(() => {
          udp.close();
          tcp.close();
          log("challenge DNS stopped");
        });
      });
    });
  });
}

// ───────────── obtain or renew with lego (exec DNS provider → scripts/acme-hook.mjs) ─────────────
async function runLego({ staging = false, force = false } = {}) {
  fs.writeFileSync(TXT_FILE, "{}");
  const stopDns = await startDns();
  try {
    const legoArgs = [
      "run",
      "--accept-tos",
      "--path", LEGO_PATH,
      "--dns", "exec",
      // Our own server is the only authoritative one for the challenge zone; give the resolvers a moment instead of
      // lego's propagation checks through public resolvers.
      "--dns.propagation.wait", "20s",
      "--renew-days", String(RENEW_DAYS),
      ...HOSTS.flatMap((h) => ["-d", h]),
      ...(process.env.ACME_EMAIL ? ["--email", process.env.ACME_EMAIL] : []),
      ...(staging ? ["--server", "https://acme-staging-v02.api.letsencrypt.org/directory"] : []),
      ...(force ? ["--renew-force"] : []),
    ];
    const code = await new Promise((resolve) => {
      const child = spawn(LEGO, legoArgs, {
        env: { ...process.env, EXEC_PATH: path.join(root, "scripts", "acme-hook.mjs"), LEGO_LOG_FORMAT: "text" },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`lego exited with ${code}`);
  } finally {
    stopDns();
    fs.writeFileSync(TXT_FILE, "{}");
  }
}

async function ensureCertificate(opts) {
  const files = certFiles();
  if (files && !opts.force && daysLeft(files.crt) > RENEW_DAYS) return { files, changed: false };
  log(files ? `renewing (${Math.floor(daysLeft(files.crt))} days left)` : "obtaining the first certificate");
  await runLego(opts);
  const after = certFiles();
  if (!after) throw new Error("lego finished but no certificate was found");
  log(`certificate valid for ${Math.floor(daysLeft(after.crt))} days`);
  return { files: after, changed: true };
}

// ───────────── the HTTPS front door ─────────────
function forward(req, res) {
  const headers = { ...req.headers };
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = req.headers.host ?? HOSTS[0];
  headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  const up = http.request({ ...TARGET, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("The club app is restarting. Please try again in a moment.");
  });
  req.pipe(up);
}

function upgrade(req, socket, head) {
  const up = net.connect(TARGET.port, TARGET.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push("X-Forwarded-Proto: https", `X-Forwarded-Host: ${req.headers.host ?? HOSTS[0]}`);
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

async function main() {
  const staging = args.has("--staging");
  if (args.has("--issue-only")) {
    await ensureCertificate({ staging, force: args.has("--force") });
    return;
  }
  let { files } = await ensureCertificate({ staging });
  const tls = () => ({ key: fs.readFileSync(files.key), cert: fs.readFileSync(files.crt) });
  const server = https.createServer({ ...tls(), minVersion: "TLSv1.2" }, forward);
  server.on("upgrade", upgrade);
  server.listen(PORT, "0.0.0.0", () => log(`serving https://${HOSTS[0]}:${PORT} → http://${TARGET.host}:${TARGET.port}`));
  setInterval(async () => {
    try {
      const r = await ensureCertificate({ staging });
      if (r.changed) {
        files = r.files;
        server.setSecureContext(tls());
        log("new certificate loaded");
      }
    } catch (e) {
      console.error("[https] renewal failed; will retry", e instanceof Error ? e.message : e);
    }
  }, CHECK_EVERY_MS);
}

// Run when started directly or by PM2 (which loads the file through its own wrapper); not when a test imports it.
const self = fileURLToPath(import.meta.url);
if ([process.argv[1], process.env.pm_exec_path].some((p) => p && path.resolve(p) === self)) {
  main().catch((e) => {
    console.error("[https]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
