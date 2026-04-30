// Entry point: load env, connect mongo, build server, start cron loops,
// install signal handlers.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, disconnect } from "@credit/shared";
import { loadConfig } from "./lib/config.js";
import { initLocusClient } from "./lib/locus.js";
import { buildServer } from "./server.js";
import { startCollectionLoop } from "./jobs/collection-loop.js";
import { startDefaultLoop } from "./jobs/default-loop.js";
import { startScoreRecomputeLoop } from "./jobs/score-recompute-loop.js";
import { startSettlementWatcher } from "./jobs/settlement-watcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

async function main(): Promise<void> {
  const cfg = loadConfig();
  await connect(cfg.mongoUri);
  initLocusClient(cfg);
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(
    `credit-agent listening on http://localhost:${cfg.port} ` +
      `(locus mode: ${cfg.locusOfflineMode ? "offline/mock" : "live/beta"}` +
      `, loops: ${cfg.loopsDisabled ? "disabled" : "enabled"})`,
  );

  const collection = startCollectionLoop({ logger: app.log, config: cfg });
  const score = startScoreRecomputeLoop({ logger: app.log, config: cfg });
  const defaults = startDefaultLoop({ logger: app.log, config: cfg });
  const settlement = startSettlementWatcher({ logger: app.log, config: cfg });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    collection.stop();
    score.stop();
    defaults.stop();
    settlement.stop();
    await app.close();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
