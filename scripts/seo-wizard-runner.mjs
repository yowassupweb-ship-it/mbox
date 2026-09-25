#!/usr/bin/env node
import "../server/env.mjs";
import { Pool } from "pg";
import { buildSeoPackage, ensureSeoWizardSchema, runSeoWizardCollection } from "../server/seo-wizard.mjs";

const command = process.argv[2] || "all";
const scenario = process.argv[3] || "step1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 10_000, keepAlive: true });
const query = (sql, values = []) => pool.query(sql, values);

try {
  await ensureSeoWizardSchema(query);
  if (command === "collect" || command === "all") {
    const result = await runSeoWizardCollection(query, { scenario, buildPackage: command === "all" });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "package") {
    const pkg = await buildSeoPackage(query, { scenario: process.argv[3] || "monday" });
    console.log(JSON.stringify({ package_id: pkg.id, scenario: pkg.scenario, created_at: pkg.created_at }, null, 2));
  } else {
    console.error("Usage: node scripts/seo-wizard-runner.mjs [all|collect|package] [scenario]");
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
