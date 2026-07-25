import { redirect } from "next/navigation";

/**
 * The standalone Digest page was orphaned (unlinked from nav) and its content is
 * covered by the morning briefing on the home surface. Redirecting to the
 * dashboard removes a divergent, unmaintained parallel view.
 */
export default function DigestRedirect() {
  redirect("/dashboard");
}
