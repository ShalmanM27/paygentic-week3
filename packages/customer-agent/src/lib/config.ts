// Validated env for the customer agent.

export interface CustomerAgentConfig {
  port: number;
  locusApiKey: string;
  locusApiBase: string;
  locusOfflineMode: boolean;
  mockBalance?: string;
  borrowerAUrl: string;
  borrowerBUrl: string;
  continuousMode: boolean;
  jobIntervalSeconds: number;
  borrowerWeightA: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`missing env ${name}`);
  return v;
}

export function loadCustomerConfig(): CustomerAgentConfig {
  return {
    port: Number(process.env.PORT ?? "4003"),
    locusApiKey: req("LOCUS_API_KEY"),
    locusApiBase:
      process.env.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api",
    locusOfflineMode: process.env.LOCUS_OFFLINE_MODE === "1",
    mockBalance: process.env.LOCUS_MOCK_BALANCE,
    borrowerAUrl: req("BORROWER_A_URL"),
    borrowerBUrl: req("BORROWER_B_URL"),
    continuousMode: process.env.CONTINUOUS_MODE === "true",
    jobIntervalSeconds: Number(process.env.JOB_INTERVAL_SECONDS ?? "20"),
    borrowerWeightA: Number(process.env.BORROWER_WEIGHT_A ?? "0.7"),
  };
}
