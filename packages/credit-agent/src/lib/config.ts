// Validated environment for the credit-agent. Throws clearly on missing/bad values.

export interface CreditAgentConfig {
  port: number;
  mongoUri: string;
  locusApiKey: string;
  locusApiBase: string;
  locusOfflineMode: boolean;
  locusWebhookSecret: string;
  decisionTokenSecret: string;
  publicBaseUrl: string;
  frontendOrigin: string;
  minLoanUsdc: number;
  maxLoanUsdc: number;
  maxTtlSeconds: number;
  repaymentFirstAttemptDelaySeconds: number;
  mockBalance: string;
  scoreReportPrice: number;
  collectionLoopIntervalSeconds: number;
  scoreLoopIntervalSeconds: number;
  defaultLoopIntervalSeconds: number;
  defaultGraceSeconds: number;
  maxRepaymentAttempts: number;
  repaymentBackoffSeconds: number[];
  loopsDisabled: boolean;
  settlementWatcherEnabled: boolean;
  settlementWatcherIntervalSeconds: number;
  settlementGraceSeconds: number;
  debugEndpointsEnabled: boolean;
  agentRentUsdc: number;
  agentRentCoverageDays: number;
  subscriptionWatcherIntervalSeconds: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`missing required env ${name}`);
  }
  return v;
}

function reqNum(name: string): number {
  const v = req(name);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} not numeric: ${v}`);
  return n;
}

export function loadConfig(): CreditAgentConfig {
  return {
    port: Number(process.env.PORT ?? "4000"),
    mongoUri: req("MONGODB_URI"),
    locusApiKey: req("LOCUS_API_KEY"),
    locusApiBase:
      process.env.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api",
    locusOfflineMode: process.env.LOCUS_OFFLINE_MODE === "1",
    locusWebhookSecret: req("LOCUS_WEBHOOK_SECRET"),
    decisionTokenSecret: req("DECISION_TOKEN_SECRET"),
    publicBaseUrl: req("PUBLIC_BASE_URL"),
    frontendOrigin: req("FRONTEND_ORIGIN"),
    minLoanUsdc: reqNum("MIN_LOAN_USDC"),
    maxLoanUsdc: reqNum("MAX_LOAN_USDC"),
    maxTtlSeconds: reqNum("MAX_TTL_SECONDS"),
    repaymentFirstAttemptDelaySeconds: reqNum(
      "REPAYMENT_FIRST_ATTEMPT_DELAY_SECONDS",
    ),
    mockBalance: process.env.LOCUS_MOCK_BALANCE ?? "10.00",
    scoreReportPrice: reqNum("SCORE_REPORT_PRICE"),
    collectionLoopIntervalSeconds: Number(
      process.env.COLLECTION_LOOP_INTERVAL_SECONDS ?? "10",
    ),
    scoreLoopIntervalSeconds: Number(
      process.env.SCORE_LOOP_INTERVAL_SECONDS ?? "30",
    ),
    defaultLoopIntervalSeconds: Number(
      process.env.DEFAULT_LOOP_INTERVAL_SECONDS ?? "60",
    ),
    defaultGraceSeconds: Number(process.env.DEFAULT_GRACE_SECONDS ?? "60"),
    maxRepaymentAttempts: Number(process.env.MAX_REPAYMENT_ATTEMPTS ?? "4"),
    repaymentBackoffSeconds: (process.env.REPAYMENT_BACKOFF_SECONDS ??
      "30,60,120,300")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    loopsDisabled: process.env.LOOPS_DISABLED === "1",
    settlementWatcherEnabled:
      process.env.SETTLEMENT_WATCHER_ENABLED === "1",
    settlementWatcherIntervalSeconds: Number(
      process.env.SETTLEMENT_WATCHER_INTERVAL_SECONDS ?? "30",
    ),
    settlementGraceSeconds: Number(
      process.env.SETTLEMENT_GRACE_SECONDS ?? "60",
    ),
    debugEndpointsEnabled: process.env.DEBUG_ENDPOINTS_ENABLED === "1",
    agentRentUsdc: Number(process.env.AGENT_RENT_USDC ?? "0.005"),
    agentRentCoverageDays: Number(process.env.AGENT_RENT_COVERAGE_DAYS ?? "30"),
    subscriptionWatcherIntervalSeconds: Number(
      process.env.SUBSCRIPTION_WATCHER_INTERVAL_SECONDS ?? "3",
    ),
  };
}
