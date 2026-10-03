import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "bcryptjs", "nodemailer"],
  poweredByHeader: false,
  // Enables forbidden() → a real HTTP 403 page when a role opens a screen it may not use (plan §12 step 12).
  experimental: { authInterrupts: true },
  // v3 §1: once the public address is HTTPS, browsers are told to stay on HTTPS (ignored on plain HTTP by design).
  async headers() {
    if (!(process.env.APP_URL ?? "").startsWith("https://")) return [];
    return [{ source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] }];
  },
};

export default nextConfig;
