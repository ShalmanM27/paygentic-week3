// Single source of truth for demo seed values. Used by:
//   - demo-runner.ts (at boot)
//   - /debug/reset-demo (between demo cycles)
//
// applyDemoSeed is idempotent: post-call, the system is in the same
// state as a fresh boot of demo-runner regardless of prior history.

import { BorrowerModel, setMockBalanceForKey } from "@credit/shared";
import type { CreditAgentConfig } from "./config.js";

export const DEMO_BORROWER_PRESETS: Record<
  string,
  { score: number; limit: number; mockBalance: string }
> = {
  "agent-a": { score: 750, limit: 0.05, mockBalance: "0.0010" },
  "agent-b": { score: 550, limit: 0.02, mockBalance: "0.0010" },
};

/** Hardcoded demo customer key — matches packages/credit-agent/scripts/demo-runner.ts. */
export const DEMO_CUSTOMER_KEY = "claw_dev_demo_customer";
export const DEMO_CUSTOMER_BALANCE = "0.5000";
export const DEMO_CREDIT_BALANCE = "10.0000";

export interface ApplySeedResult {
  borrowersReset: string[];
}

/**
 * Reset every borrower record in-place to the demo preset (score, limit,
 * outstanding=0, defaultCount=0, status="ACTIVE"). Preserves apiKey,
 * walletAddress, serviceUrl that the borrower registered with at boot.
 *
 * In offline mode (LOCUS_OFFLINE_MODE=1), also reset the mock-client
 * balances for credit-agent, customer-agent, and both borrowers. In
 * live mode this no-ops on balances — real Locus wallets persist
 * across our app's lifetime, we don't reach into them.
 */
export async function applyDemoSeed(
  config: CreditAgentConfig,
): Promise<ApplySeedResult> {
  const borrowersReset: string[] = [];
  for (const [borrowerId, preset] of Object.entries(DEMO_BORROWER_PRESETS)) {
    const borrower = await BorrowerModel.findOneAndUpdate(
      { borrowerId },
      {
        $set: {
          score: preset.score,
          limit: preset.limit,
          outstanding: 0,
          defaultCount: 0,
          status: "ACTIVE",
        },
      },
      { new: true },
    );
    if (borrower) {
      borrowersReset.push(borrowerId);
      // Mock balance reset is offline-only. Live Locus wallets keep state.
      if (config.locusOfflineMode && borrower.apiKey) {
        setMockBalanceForKey(borrower.apiKey, preset.mockBalance);
      }
    }
  }

  if (config.locusOfflineMode) {
    // Lender pool + customer demand wallet — only meaningful for the mock.
    setMockBalanceForKey(config.locusApiKey, DEMO_CREDIT_BALANCE);
    setMockBalanceForKey(DEMO_CUSTOMER_KEY, DEMO_CUSTOMER_BALANCE);
  }

  return { borrowersReset };
}
