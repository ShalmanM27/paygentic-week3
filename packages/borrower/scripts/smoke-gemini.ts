// One-shot smoke against Google AI Studio's direct generative API.
// Loads agent-summarizer's .env (where GEMINI_API_KEY is configured),
// sends a tiny test prompt, prints raw response + extracted content.
//
// Run from repo root:  pnpm smoke:gemini
//
// Cost: $0 (Google AI Studio free tier — 15 req/min, 1500/day).
// Refuses to run if GEMINI_API_KEY is missing or doesn't start with "AIza".

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "undici";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../../agent-summarizer/.env");
loadDotenv({ path: ENV_PATH });

async function main(): Promise<void> {
  console.log("smoke-gemini — Google AI Studio direct call");
  console.log("Env file:", ENV_PATH);
  console.log("");

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey || !apiKey.startsWith("AIza")) {
    console.error(
      "Refusing — GEMINI_API_KEY missing or not in AIza… format. " +
        "Paste your Google AI Studio API key into agent-summarizer/.env",
    );
    process.exit(1);
  }
  const apiBase =
    process.env.GEMINI_API_BASE ??
    "https://generativelanguage.googleapis.com/v1beta";
  const model = process.env.AGENT_GEMINI_MODEL ?? "gemini-1.5-flash";

  const baseTrim = apiBase.replace(/\/+$/, "");
  const endpoint = `${baseTrim}/models/${encodeURIComponent(model)}:generateContent`;

  console.log("Using key :", apiKey.slice(0, 8) + "…");
  console.log("Endpoint  :", endpoint, "(key passed via ?key= query)");
  console.log("Model     :", model);
  console.log("");

  const body = {
    systemInstruction: {
      parts: [
        {
          text:
            "You are a concise summarization assistant. Reply in one short sentence.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: "What is 2 + 2?" }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  console.log("── POST", endpoint);
  console.log("body:", JSON.stringify(body, null, 2));
  console.log("");

  const url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;
  const t0 = Date.now();
  const res = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;
  const text = await res.body.text();
  console.log("── response:");
  console.log("  status :", res.statusCode);
  console.log("  time   :", elapsed, "ms");
  console.log("");
  console.log("raw body:");
  console.log(text);
  console.log("");

  if (res.statusCode === 200) {
    try {
      const parsed = JSON.parse(text) as {
        candidates?: Array<{
          finishReason?: string;
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      console.log("parsed (pretty):");
      console.log(JSON.stringify(parsed, null, 2));
      console.log("");
      const cand = parsed.candidates?.[0];
      if (cand) {
        const parts = cand.content?.parts ?? [];
        const extracted = parts.map((p) => p.text ?? "").join("");
        console.log("── extractContent ──");
        console.log("  finishReason:", cand.finishReason);
        console.log("  charsOutput :", extracted.length);
        console.log("  content     :", extracted);
      } else {
        console.log("(no candidates[0])");
      }
    } catch (err) {
      console.log("(non-JSON response)", err);
    }
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
