import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts", "Frontend (2)/**", "uploads/**", "backups/**"],
  },
  {
    files: ["src/server/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
];

export default config;
