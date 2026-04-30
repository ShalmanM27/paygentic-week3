// Task output verification. Hackathon-grade placeholder — production
// would use LLM-as-judge or human-in-loop. Keep simple, deterministic,
// and explainable.

const REFUSAL_PREFIXES = [
  "i cannot",
  "i can't",
  "i'm unable",
  "i am unable",
  "as an ai",
  "i don't",
  "sorry, i",
  "sorry,i",
  "i apologize",
];

const MIN_OUTPUT_CHARS = 20;
const MAX_OUTPUT_CHARS = 50_000;

export interface VerifyResult {
  passes: boolean;
  notes: string;
}

export function verifyTaskOutput(args: {
  output: string | null | undefined;
}): VerifyResult {
  const output = (args.output ?? "").trim();

  if (output.length < MIN_OUTPUT_CHARS) {
    return {
      passes: false,
      notes: `output too short (${output.length} chars, need ≥ ${MIN_OUTPUT_CHARS})`,
    };
  }
  if (output.length > MAX_OUTPUT_CHARS) {
    return {
      passes: false,
      notes: `output too long (${output.length} chars, cap ${MAX_OUTPUT_CHARS})`,
    };
  }
  const lower = output.toLowerCase();
  for (const prefix of REFUSAL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return {
        passes: false,
        notes: `refusal pattern matched at start: "${prefix}"`,
      };
    }
  }
  return { passes: true, notes: "auto-passed: 3 checks ok" };
}
