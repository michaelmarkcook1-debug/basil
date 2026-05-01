/**
 * Web search via the Tavily API.
 *
 * Tavily is purpose-built for AI agents — it returns clean, structured results
 * suitable for LLM consumption rather than raw HTML.
 *
 * Requires:  TAVILY_API_KEY environment variable
 * Free tier: 1 000 searches / month — enough for active conversational use.
 *
 * Design:
 * - Never throws — returns an error object on any failure
 * - Results are capped to keep token usage bounded
 * - Each result includes title, URL, and a clean content snippet
 */

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  answer?: string;   // Tavily's AI-synthesised answer (optional)
  results: SearchResult[];
  error?: string;
}

/**
 * Search the web via Tavily and return structured results.
 *
 * @param query       The search query.
 * @param maxResults  Maximum number of results to return (default 5, max 10).
 * @param depth       "basic" (fast, less thorough) or "advanced" (slower, deeper).
 */
export async function webSearch(
  query: string,
  {
    maxResults = 5,
    depth = "basic" as "basic" | "advanced",
    includeAnswer = true,
  } = {}
): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    return {
      query,
      results: [],
      error:
        "Web search is not configured. Add TAVILY_API_KEY in Settings → Environment Variables.",
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: depth,
        include_answer: includeAnswer,
        max_results: Math.min(maxResults, 10),
        // Exclude known low-value domains for business intelligence queries
        exclude_domains: [],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Tavily API HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      answer?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
      }>;
    };

    const results: SearchResult[] = (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url ?? "",
        url: r.url!,
        // Clip content to keep tokens bounded (~800 chars per result)
        content: (r.content ?? "").slice(0, 800).trim(),
        score: r.score,
      }));

    return {
      query,
      answer: data.answer?.trim() || undefined,
      results,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[web-search] failed for "${query}": ${reason}`);
    return {
      query,
      results: [],
      error: reason,
    };
  }
}

/**
 * Fetch and extract readable text from a URL.
 * Uses Tavily's extract endpoint for clean content extraction.
 */
export async function fetchPageContent(url: string): Promise<{
  url: string;
  content: string;
  error?: string;
}> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    return { url, content: "", error: "TAVILY_API_KEY not configured." };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Tavily extract HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      results?: Array<{ url?: string; raw_content?: string }>;
    };

    const raw = data.results?.[0]?.raw_content ?? "";
    return {
      url,
      // Cap at 4 000 chars — enough for a full article without blowing context
      content: raw.slice(0, 4_000).trim(),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { url, content: "", error: reason };
  }
}
