// Entry: load .env, build server, optionally start cron driver, listen.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCustomerConfig } from "./lib/config.js";
import { startCronDriver } from "./lib/cron-driver.js";
import { buildServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

async function main(): Promise<void> {
  const cfg = loadCustomerConfig();
  const { app, locus } = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(
    `customer-agent listening on http://localhost:${cfg.port} ` +
      `(locus mode: ${cfg.locusOfflineMode ? "offline/mock" : "live/beta"}, ` +
      `cron: ${cfg.continuousMode ? `every ${cfg.jobIntervalSeconds}s` : "disabled"})`,
  );

  const driver = startCronDriver({ config: cfg, locus, logger: app.log });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    driver.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
