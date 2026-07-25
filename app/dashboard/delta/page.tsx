import { redirect } from "next/navigation";

/**
 * The standalone Delta page was an orphaned, unlinked surface that kept its OWN
 * "seen" state (POST /api/delta/seen) which no other surface honoured — so it
 * showed a divergent view of "what's new". Its content is fully covered by the
 * home Radar feed (/dashboard), which is the single attention authority. Any
 * bookmark now lands on that canonical feed instead of a stale parallel one.
 */
export default function DeltaRedirect() {
  redirect("/dashboard");
}
