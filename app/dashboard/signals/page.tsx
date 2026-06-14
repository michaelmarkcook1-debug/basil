import { redirect } from "next/navigation";

/**
 * Signals were folded into the Today page — Today is now the single home for
 * signal intelligence (Signal Radar, Recent Threads, Basil Intelligence), so
 * there's one place rather than two competing models. This route redirects so
 * any existing bookmarks or links land in the right place.
 */
export default function SignalsPage() {
  redirect("/dashboard");
}
