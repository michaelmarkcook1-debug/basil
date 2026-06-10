/**
 * lib/briefing/render.ts — render a cached Briefing into email + Slack.
 *
 * The same masthead-led edition format Basil shows on the dashboard is rendered
 * here for email and Slack, so the brief is recognizably Basil in every channel
 * (a signature motif). Generation already happened (and was paid for) — this
 * only formats the cached JSON.
 *
 * server-only.
 */

import "server-only";
import type { Briefing } from "@/lib/types/briefing";

const SECTIONS: { key: keyof Briefing; label: string }[] = [
  { key: "criticalToday", label: "Needs your attention" },
  { key: "meetingsNeedingPrep", label: "Meetings to prep" },
  { key: "followUps", label: "Follow-ups" },
  { key: "decisionsToWatch", label: "Decisions to watch" },
  { key: "projectRadar", label: "Project radar" },
  { key: "peopleAndAccounts", label: "People & accounts" },
  { key: "inboxSlack", label: "Inbox & Slack" },
];

function presentSections(b: Briefing): { label: string; body: string }[] {
  return SECTIONS
    .map(({ key, label }) => ({ label, body: (b[key] as string | null) ?? "" }))
    .filter((s) => s.body.trim().length > 0);
}

function editionLine(b: Briefing): string {
  const d = new Date(b.generatedAt || Date.now());
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return `${weekday} Edition — ${date}`;
}

// ── Slack (mrkdwn) ──────────────────────────────────────────────────────────────

export function renderBriefingSlack(b: Briefing, firstName: string): string {
  const sections = presentSections(b);
  const lines: string[] = [];
  lines.push(`📋 *${editionLine(b)}*`);
  lines.push(`Good morning ${firstName} — here's what matters today.`);
  for (const s of sections) {
    lines.push("");
    lines.push(`*${s.label}*`);
    // Light markdown → Slack mrkdwn: **bold** → *bold*.
    lines.push(s.body.replace(/\*\*(.+?)\*\*/g, "*$1*").trim());
  }
  if (sections.length === 0) {
    lines.push("");
    lines.push("_A quiet morning — no urgent signals across your connected sources._");
  }
  lines.push("");
  lines.push("Open Basil for the full briefing →");
  return lines.join("\n");
}

// ── Email (HTML + text) ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal markdown → HTML for the prose sections (bold, bullet lines, paragraphs). */
function proseToHtml(prose: string): string {
  const blocks = prose.trim().split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      const isList = lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l));
      if (isList) {
        const items = lines
          .map((l) => `<li style="margin:0 0 6px;">${inline(l.replace(/^[-*•]\s+/, ""))}</li>`)
          .join("");
        return `<ul style="margin:0 0 14px;padding-left:20px;color:#C6CEDB;font-size:14px;line-height:1.6;">${items}</ul>`;
      }
      return `<p style="margin:0 0 14px;color:#C6CEDB;font-size:14px;line-height:1.6;">${inline(block.replace(/\n/g, "<br>"))}</p>`;
    })
    .join("");
}

function inline(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong style=\"color:#F3EFE7;\">$1</strong>");
}

export function renderBriefingEmail(
  b: Briefing,
  firstName: string,
  appUrl: string
): { subject: string; html: string; text: string } {
  const sections = presentSections(b);
  const edition = editionLine(b);

  const sectionHtml = sections.length
    ? sections
        .map(
          (s) => `
        <tr><td style="padding:0 32px;">
          <p style="margin:22px 0 8px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#C8A96B;font-weight:600;">${esc(s.label)}</p>
          ${proseToHtml(s.body)}
        </td></tr>`
        )
        .join("")
    : `<tr><td style="padding:0 32px;"><p style="color:#C6CEDB;font-size:14px;">A quiet morning — no urgent signals across your connected sources.</p></td></tr>`;

  const html = `
  <div style="background:#07111F;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#0B1730;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
      <tr><td style="padding:28px 32px 6px;">
        <p style="margin:0;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#C8A96B;">${esc(edition)}</p>
        <h1 style="margin:6px 0 2px;font-family:Georgia,'Times New Roman',serif;font-size:26px;color:#F3EFE7;font-weight:500;">Good morning, ${esc(firstName)}.</h1>
        <p style="margin:0;color:#AAB3C5;font-size:13px;">Here's what matters today.</p>
      </td></tr>
      <tr><td style="padding:0 32px;"><div style="height:1px;background:rgba(255,255,255,0.08);margin:16px 0 0;"></div></td></tr>
      ${sectionHtml}
      <tr><td style="padding:24px 32px 28px;">
        <a href="${esc(appUrl)}/dashboard/briefing" style="display:inline-block;background:#C8A96B;color:#07111F;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px;">Open the full briefing →</a>
        <p style="margin:18px 0 0;color:#6B7689;font-size:11px;">You're receiving this because daily briefing email is on. Turn it off in Basil → Settings.</p>
      </td></tr>
    </table>
  </div>`;

  const text =
    `${edition}\nGood morning, ${firstName}. Here's what matters today.\n\n` +
    (sections.length
      ? sections.map((s) => `${s.label.toUpperCase()}\n${s.body.replace(/\*\*/g, "")}`).join("\n\n")
      : "A quiet morning — no urgent signals across your connected sources.") +
    `\n\nOpen the full briefing: ${appUrl}/dashboard/briefing`;

  return { subject: `${edition} — your Basil briefing`, html, text };
}
