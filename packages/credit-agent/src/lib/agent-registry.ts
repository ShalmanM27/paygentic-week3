// Hardcoded registry of known agents. Frontend marketplace consumes this
// via GET /agents/registry. Source of truth for pricing + display metadata.

// Public marketplace shape — what /agents/registry returns to the
// frontend. Mirrors the DB-backed Agent collection (X4) minus internal
// fields like activatedAt / suspendedAt.
import { AgentModel } from "@credit/shared";

export interface AgentRegistryEntry {
  agentId: string;
  displayName: string;
  description: string;
  pricingUsdc: number;
  category: string;
  emoji: string;
  /** Operator is the entity hosting the agent. Multiple agents can
   *  share a single operator (and a single Locus wallet). */
  operatorId: string;
  operatorName: string;
  capabilities: string[];
  serviceUrl: string;
  walletAddress: string;
  isBuiltIn: boolean;
}

// Built-in seed data — written into the `agents` collection at boot if
// the row doesn't already exist. After seeding, the collection is the
// source of truth (the registry endpoint reads from DB).
//
// Six active agents fill the marketplace grid with price variety. Three
// share LLM backends with the live agent services (translator, qa-tester,
// image-creator route through summarizer/reviewer respectively); the
// dispatcher uses agentId-specific system prompts so each persona returns
// distinct output. In production each would deploy independently.
export const BUILTIN_AGENTS: Array<
  Omit<AgentRegistryEntry, "isBuiltIn"> & { isBuiltIn: true }
> = [
  {
    agentId: "summarizer",
    displayName: "Summarizer",
    description: "Summarizes long documents into concise bullet points",
    pricingUsdc: 0.008,
    category: "Text",
    emoji: "📝",
    operatorId: "op-a",
    operatorName: "Operator A",
    capabilities: [
      "Reads up to 4000 chars of input",
      "Outputs 3–5 bullet points",
      "Powered by Gemini Flash",
    ],
    serviceUrl: "http://localhost:4001",
    walletAddress: "0xbuiltin_summarizer",
    isBuiltIn: true,
  },
  {
    agentId: "code-reviewer",
    displayName: "Code Reviewer",
    description: "Reviews code for bugs, style, and security issues",
    pricingUsdc: 0.012,
    category: "Engineering",
    emoji: "🔍",
    operatorId: "op-b",
    operatorName: "Operator B",
    capabilities: [
      "Reviews any code in any language",
      "Identifies bugs, style issues, security concerns",
      "Returns actionable, structured feedback",
    ],
    serviceUrl: "http://localhost:4002",
    walletAddress: "0xbuiltin_code_reviewer",
    isBuiltIn: true,
  },
  {
    agentId: "code-writer",
    displayName: "Code Writer",
    description: "Generates code from natural language specifications",
    pricingUsdc: 0.015,
    category: "Engineering",
    emoji: "⚡",
    operatorId: "op-a",
    operatorName: "Operator A",
    capabilities: [
      "Generates working code from natural-language specs",
      "Includes inline comments for non-obvious logic",
      "Multiple language support",
    ],
    serviceUrl: "http://localhost:4004",
    walletAddress: "0xbuiltin_code_writer",
    isBuiltIn: true,
  },
  {
    agentId: "translator",
    displayName: "Translator",
    description: "Translates text between languages with precision",
    pricingUsdc: 0.01,
    category: "Text",
    emoji: "🌐",
    operatorId: "op-a",
    operatorName: "Operator A",
    capabilities: [
      "20+ languages supported",
      "Preserves tone and idioms",
      "Annotates ambiguous translations",
    ],
    // Routed through the summarizer's backend with a translator prompt.
    serviceUrl: "http://localhost:4001",
    walletAddress: "0xbuiltin_translator",
    isBuiltIn: true,
  },
  {
    agentId: "qa-tester",
    displayName: "QA Tester",
    description: "Tests code/products and reports issues, edge cases, risks",
    pricingUsdc: 0.009,
    category: "Engineering",
    emoji: "🧪",
    operatorId: "op-b",
    operatorName: "Operator B",
    capabilities: [
      "Identifies edge cases and risks",
      "Suggests test scenarios",
      "Categorises severity",
    ],
    // Routed through the code-reviewer's backend with a QA prompt.
    serviceUrl: "http://localhost:4002",
    walletAddress: "0xbuiltin_qa_tester",
    isBuiltIn: true,
  },
  {
    agentId: "image-creator",
    displayName: "Image Creator",
    description: "Describes images in vivid detail from text prompts",
    pricingUsdc: 0.025,
    category: "Creative",
    emoji: "🎨",
    operatorId: "op-a",
    operatorName: "Operator A",
    capabilities: [
      "Vivid, structured visual descriptions",
      "Multiple style presets",
      "Composition + colour palette suggestions",
    ],
    // Routed through summarizer's backend with an image-description prompt.
    serviceUrl: "http://localhost:4001",
    walletAddress: "0xbuiltin_image_creator",
    isBuiltIn: true,
  },
];

// Per-agent system prompt overrides used by the dispatcher when routing
// virtual agents (translator/qa-tester/image-creator) through shared
// backends. Keys are agentIds; values are full system prompts injected
// into /work-with-input requests.
//
// Demo lie acknowledged: in production each agent would deploy
// independently. For the hackathon these share LLM backends but present
// distinct personas via prompt injection.
export const VIRTUAL_AGENT_PROMPTS: Record<string, string> = {
  translator:
    "You are a precise translator. Translate the input to English unless the user specifies a target language. Preserve tone, idioms, and cultural nuance. Annotate any ambiguous renderings in parentheses.",
  "qa-tester":
    "You are a QA tester. Review the input (code, product spec, or description) and identify potential issues, edge cases, and risks. Categorise findings by severity (critical/high/medium/low). Suggest concrete test scenarios.",
  "image-creator":
    "You are an image-description generator. Image generation isn't supported live, so describe in vivid detail what the requested image would contain: composition, colour palette, lighting, mood, key elements. Be evocative.",
};

// Legacy compatibility shim — pre-X4 callers indexed by agentId.
// Kept so isKnownAgent() / getAgentRegistry() lookups continue to work
// without a DB round-trip during the X4 transition.
export const AGENTS: Record<string, AgentRegistryEntry> = Object.fromEntries(
  BUILTIN_AGENTS.map((a) => [a.agentId, a]),
);

function toEntry(doc: Record<string, unknown>): AgentRegistryEntry {
  return {
    agentId: String(doc.agentId),
    displayName: String(doc.displayName),
    description: String(doc.description),
    pricingUsdc: Number(doc.pricingUsdc),
    category: String(doc.category),
    emoji: String(doc.emoji),
    operatorId: String(doc.operatorId),
    operatorName: String(doc.operatorName),
    capabilities: Array.isArray(doc.capabilities)
      ? (doc.capabilities as string[])
      : [],
    serviceUrl: String(doc.serviceUrl ?? ""),
    walletAddress: String(doc.walletAddress ?? ""),
    isBuiltIn: Boolean(doc.isBuiltIn),
  };
}

/** Read one agent from the DB (any isActive state). */
export async function getAgentRegistry(
  agentId: string,
): Promise<AgentRegistryEntry | null> {
  const doc = await AgentModel.findOne({ agentId }).lean();
  return doc ? toEntry(doc as unknown as Record<string, unknown>) : null;
}

/** List all isActive=true agents. Public marketplace surface. */
export async function listAgents(): Promise<AgentRegistryEntry[]> {
  const docs = await AgentModel.find({ isActive: true })
    .sort({ isBuiltIn: -1, createdAt: 1 })
    .lean();
  return docs.map((d) => toEntry(d as unknown as Record<string, unknown>));
}

/** Check whether an agent exists in the DB and is currently active. */
export async function isKnownAgent(agentId: string): Promise<boolean> {
  const doc = await AgentModel.findOne({ agentId, isActive: true })
    .select({ agentId: 1 })
    .lean();
  return Boolean(doc);
}

/** Idempotent: upsert all built-ins on boot. Built-ins always end up as
 *  isActive=true with the latest registry metadata (pricing changes,
 *  capabilities, etc. flow through on next boot). Operator-registered
 *  agents are untouched. */
export async function seedBuiltInAgents(): Promise<{
  seeded: string[];
  refreshed: string[];
}> {
  const seeded: string[] = [];
  const refreshed: string[] = [];
  for (const a of BUILTIN_AGENTS) {
    const existing = await AgentModel.findOne({ agentId: a.agentId });
    if (existing) {
      // Refresh metadata that the registry now declares — prices, prompts,
      // capabilities can evolve. Built-ins are always active.
      existing.displayName = a.displayName;
      existing.description = a.description;
      existing.category = a.category as "Text" | "Engineering" | "Creative" | "Research";
      existing.emoji = a.emoji;
      existing.pricingUsdc = a.pricingUsdc;
      existing.capabilities = a.capabilities;
      existing.serviceUrl = a.serviceUrl;
      existing.walletAddress = a.walletAddress;
      existing.operatorId = a.operatorId;
      existing.operatorName = a.operatorName;
      existing.isBuiltIn = true;
      existing.isActive = true;
      if (!existing.activatedAt) existing.activatedAt = new Date();
      await existing.save();
      refreshed.push(a.agentId);
      continue;
    }
    await AgentModel.create({
      ...a,
      isActive: true,
      activatedAt: new Date(),
    });
    seeded.push(a.agentId);
  }
  return { seeded, refreshed };
}
