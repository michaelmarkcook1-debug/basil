/**
 * Project management is one menu tab with two views: Linear and AI tools.
 * Both keep their own URLs so deep links and Cmd-K still land directly; the
 * tab entry (/dashboard/project-management) reopens whichever was used last,
 * remembered in a cookie.
 */

export const PM_COOKIE = "basil_pm_view";
export const PM_ENTRY = "/dashboard/project-management";

export const PM_VIEWS = [
  { key: "linear", href: "/dashboard/linear", label: "Linear", blurb: "Issues, projects and blockers." },
  { key: "ai-tools", href: "/dashboard/ai-projects", label: "AI tools", blurb: "Recent work across your AI and dev platforms." },
] as const;

export type PmView = (typeof PM_VIEWS)[number];

/** The view a path belongs to, or undefined outside Project management. */
export function pmViewFor(pathname: string): PmView | undefined {
  return PM_VIEWS.find((v) => pathname === v.href || pathname.startsWith(v.href + "/"));
}

/** Where the tab entry should land: the remembered view, else Linear. */
export function pmHrefFor(saved: string | undefined): string {
  return (PM_VIEWS.find((v) => v.key === saved) ?? PM_VIEWS[0]).href;
}

/** True on any page that belongs to the Project management tab. */
export function inProjectManagement(pathname: string): boolean {
  return pathname === PM_ENTRY || pmViewFor(pathname) !== undefined;
}
