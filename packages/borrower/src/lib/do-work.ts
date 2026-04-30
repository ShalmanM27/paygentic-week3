// Mocked unit of work — sleep 1s, return canned scrape result.

export interface WorkResult {
  content: string;
  at: string;
}

export async function doWork(input: { url: string }): Promise<WorkResult> {
  await new Promise((r) => setTimeout(r, 1000));
  return {
    content: `Mock scraped content for ${input.url}`,
    at: new Date().toISOString(),
  };
}
