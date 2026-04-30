// Run one unit of work for an agent.
//
// LIVE mode: calls Google AI Studio's `:generateContent` endpoint directly
// using the agent's GEMINI_API_KEY. Free tier (15 req/min, 1500/day, $0).
// We don't route LLM calls through Locus's wrapped API because the wrapped
// surface charges ~$0.094 USDC per call (verified live 2026-04-30), which
// exceeds the demo budget.
//
// OFFLINE mode: returns a deterministic mock so the demo runs locally
// without any API key.
//
// Architectural note: every BYTE OF VALUE in the system still flows
// through Locus (escrow, agent disbursements, repayments, score sales).
// The LLM call is the WORK the agent performs; its billing substrate
// is a production concern an operator can swap with one env flag.

import { request as httpRequest } from "undici";

export interface DoWorkInput {
  agentId: string;
  agentName: string;
  systemPrompt: string;
  userInput: string;
  geminiModel: string;
  geminiApiKey: string;
  geminiApiBase: string;
  locusOfflineMode: boolean;
}

export interface WorkResult {
  content: string;
  modelUsed: string;
  charsOutput: number;
}

export async function doWork(input: DoWorkInput): Promise<WorkResult> {
  if (input.locusOfflineMode) {
    // Mock: 1s sleep so the demo's lifecycle visibly progresses.
    // No API key needed; deterministic.
    await new Promise((r) => setTimeout(r, 1000));

    // Test hook: MOCK_REFUSE=1 makes the mock emit a refusal-style preamble
    // that the verifier's refusal-pattern check rejects. Used by
    // test-task-flow to drive the verification-failure scenario.
    if (process.env.MOCK_REFUSE === "1") {
      const content = "I cannot help with that request.";
      return { content, modelUsed: "mock-refuse", charsOutput: content.length };
    }

    const trimmed = input.userInput.slice(0, 80);
    const content = `[MOCK ${input.agentId}] ${trimmed}${
      input.userInput.length > 80 ? "…" : ""
    }`;
    return { content, modelUsed: "mock", charsOutput: content.length };
  }

  if (!input.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const base = input.geminiApiBase.replace(/\/+$/, "");
  const url = `${base}/models/${encodeURIComponent(input.geminiModel)}:generateContent?key=${encodeURIComponent(input.geminiApiKey)}`;
  const body = {
    systemInstruction: {
      parts: [{ text: input.systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: input.userInput }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  const res = await httpRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`gemini ${res.statusCode}: ${text.slice(0, 400)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`gemini: non-JSON response: ${text.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;
  const candidates = obj["candidates"] as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(
      `gemini: no candidates returned (body: ${text.slice(0, 200)})`,
    );
  }
  const cand0 = candidates[0]!;
  const finishReason = cand0["finishReason"];
  if (finishReason === "SAFETY") {
    throw new Error("gemini: blocked by safety policy");
  }
  const content = extractContent(cand0);
  if (!content) {
    throw new Error(
      `gemini: empty content in first candidate (body: ${text.slice(0, 200)})`,
    );
  }

  return {
    content,
    modelUsed: input.geminiModel,
    charsOutput: content.length,
  };
}

function extractContent(candidate: Record<string, unknown>): string {
  const content = candidate["content"] as Record<string, unknown> | undefined;
  const parts = content?.["parts"] as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  return parts
    .map((p) => (typeof p["text"] === "string" ? (p["text"] as string) : ""))
    .join("");
}
