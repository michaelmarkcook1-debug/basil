import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PM_COOKIE, pmHrefFor } from "@/lib/project-management/views";

// The menu entry for Project management: reopen the view used last.
export default async function ProjectManagementPage() {
  const saved = (await cookies()).get(PM_COOKIE)?.value;
  redirect(pmHrefFor(saved));
}
