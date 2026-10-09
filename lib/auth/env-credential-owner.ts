/**
 * Deployment-level integration credentials (GOOGLE_TOKENS, SLACK_BOT_TOKEN,
 * SLACK_USER_TOKEN) are ONE person's accounts. Before this guard, every login
 * without its own connection silently fell back to them — so a second account
 * ingested the owner's mailbox, calendar and Slack every morning.
 *
 * Only the owner may use them. Everyone else must connect their own account.
 * Fails closed: with neither variable set, nobody gets the fallback.
 */
export function isEnvCredentialOwner(username: string | null | undefined): boolean {
  if (!username) return false;
  const owner = (process.env.PRIMARY_OWNER_USERNAME || process.env.ADMIN_USERNAME || "").trim().toLowerCase(); // basil-ci-allow-hardcoded-user: empty default = no owner (fail closed), not a username
  return owner !== "" && username.trim().toLowerCase() === owner;
}
