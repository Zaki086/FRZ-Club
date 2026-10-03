import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "bcryptjs", "nodemailer"],
  poweredByHeader: false,
  // Enables forbidden() → a real HTTP 403 page when a role opens a screen it may not use (plan §12 step 12).
  experimental: { authInterrupts: true },
};

export default nextConfig;
