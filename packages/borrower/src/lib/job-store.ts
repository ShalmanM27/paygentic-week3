// In-memory job context store. One borrower process = one Map.
// On crash, in-flight jobs are lost — acceptable for hackathon.

export interface JobContext {
  sessionId: string;
  url: string;
  callbackUrl: string;
  amount: number;
  createdAt: Date;
}

const jobs = new Map<string, JobContext>();

export function rememberJob(ctx: JobContext): void {
  jobs.set(ctx.sessionId, ctx);
}

export function getJob(sessionId: string): JobContext | undefined {
  return jobs.get(sessionId);
}

export function clearJob(sessionId: string): void {
  jobs.delete(sessionId);
}

/**
 * Atomic claim: returns the job and deletes it from the store in one
 * synchronous step. Concurrent processJob calls (e.g. background settle
 * watcher AND a synthesized webhook) won't double-execute.
 */
export function takeJob(sessionId: string): JobContext | undefined {
  const job = jobs.get(sessionId);
  if (job) jobs.delete(sessionId);
  return job;
}

export function _resetJobStore(): void {
  jobs.clear();
}
