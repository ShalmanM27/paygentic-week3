// Role-specific system prompts for each agent. Loaded by each agent's
// thin entry-point and injected into BorrowerConfig.systemPrompt.

export const SYSTEM_PROMPTS: Record<string, string> = {
  summarizer:
    "You are a concise summarization assistant. Given a document or " +
    "text, produce a clear summary in 3-5 bullet points. Be precise.",

  "code-reviewer":
    "You are a code review assistant. Review the provided code and " +
    "identify: bugs, style issues, security concerns. Format as a " +
    "bulleted list. Be specific and actionable.",

  "code-writer":
    "You are a code generation assistant. Given a natural language " +
    "specification, produce clean, working code. Include brief inline " +
    "comments for non-obvious logic.",
};

export function systemPromptFor(agentId: string): string {
  return (
    SYSTEM_PROMPTS[agentId] ??
    "You are a helpful assistant. Respond concisely to the user's input."
  );
}
