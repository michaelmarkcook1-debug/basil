/**
 * lib/briefing/delivery.ts — push the daily briefing to the user's channels.
 *
 * This is the "intelligence comes TO you" half of the product: instead of the
 * user pulling up the dashboard, the morning brief arrives in their inbox and/or
 * Slack DM. Best-effort per channel; never throws.
 *
 * server-only.
 */

import "server-only";
import type { Briefing } from "@/lib/types/briefing";
import { getSettings } from "@/lib/settings/store";
import { findByUsername } from "@/lib/users";
import { getSlackConfig, sendSlackDM } from "@/lib/slack/client";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { renderBriefingEmail, renderBriefingSlack } from "./render";

function appUrl(): string {
  return (
    process.env.APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

export interface DeliveryResult {
  email: string;
  slack: string;
}

export async function deliverBriefing(username: string, briefing: Briefing): Promise<DeliveryResult> {
  const settings = await getSettings(username).catch(() => null); // ci-ok: settings optional — delivery uses defaults when unreadable
  const firstName = settings?.name?.split(" ")[0] || username.split(/[@._]/)[0] || username;

  // Defaults: email ON (most users have one), Slack OFF (opt-in).
  const wantEmail = settings?.briefingEmail ?? true;
  const wantSlack = settings?.briefingSlack ?? false;

  let email = "off";
  let slack = "off";

  if (wantEmail) {
    if (!isEmailConfigured()) {
      email = "email-not-configured";
    } else {
      const user = await findByUsername(username).catch(() => null); // ci-ok: best-effort — no email means email channel is skipped
      if (!user?.email) {
        email = "no-email";
      } else {
        const { subject, html, text } = renderBriefingEmail(briefing, firstName, appUrl());
        const r = await sendEmail({ to: user.email, subject, html, text });
        email = r.ok ? "sent" : `error:${r.error}`;
      }
    }
  }

  if (wantSlack) {
    const cfg = await getSlackConfig(username).catch(() => null); // ci-ok: best-effort — not connected means Slack channel is skipped
    if (!cfg?.authUserId || !(cfg.userToken || cfg.botToken)) {
      slack = "slack-not-connected";
    } else {
      const text = renderBriefingSlack(briefing, firstName);
      const r = await sendSlackDM(username, cfg.authUserId, text);
      slack = r.ok ? "sent" : `error:${r.error}`;
    }
  }

  console.info(`[briefing/deliver] ${username}: email=${email} slack=${slack}`);
  return { email, slack };
}
