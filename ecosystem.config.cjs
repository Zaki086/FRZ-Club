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
  ],
};
