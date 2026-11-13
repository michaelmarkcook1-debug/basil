/**
 * Next.js instrumentation: runs once when a server instance starts.
 * Every console line on the Node runtime is passed through
 * lib/security/log-redact.ts so a provider error can never print a token.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installLogRedaction } = await import("./lib/security/log-redact");
    installLogRedaction();
  }
}
