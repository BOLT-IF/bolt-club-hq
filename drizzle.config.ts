import { defineConfig } from "drizzle-kit";

// One migration chain (PLAN §11.4): schema lives in db/schema/*.ts, migrations in db/migrations.
// S0.2 writes the initial migration. DATABASE_URL is only needed when running drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/*.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
