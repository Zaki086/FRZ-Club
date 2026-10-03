// PM2 process file: `pm2 start ecosystem.config.cjs && pm2 save` keeps the club running 24/7 and after reboots.
// Run `npm run build` first. Both processes read .env from this folder.
module.exports = {
  apps: [
    {
      name: "champions-web",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3200 -H 0.0.0.0",
      env: { NODE_ENV: "production" },
      max_memory_restart: "1500M",
      restart_delay: 3000,
    },
    {
      name: "champions-worker",
      cwd: __dirname,
      script: "node_modules/tsx/dist/cli.mjs",
      args: "--env-file-if-exists=.env src/server/jobs/worker.ts",
      env: { NODE_ENV: "production" },
      max_memory_restart: "500M",
      restart_delay: 5000,
    },
    {
      // HTTPS while ports 80/443 belong to another project's Caddy (v3 §1, Path B): a Let's Encrypt certificate for
      // HTTPS_HOSTS (sslip.io / nip.io names, DNS-01 challenge answered by the script itself), served on HTTPS_PORT
      // and forwarded to the app on 127.0.0.1:3200. Renews itself 30 days before expiry. See scripts/https.mjs.
      name: "champions-https",
      cwd: __dirname,
      script: "scripts/https.mjs",
      max_memory_restart: "200M",
      restart_delay: 10000,
    },
  ],
};
