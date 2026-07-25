import { sampleContacts, type Contact } from "./contacts-data";

/**
 * Match a single contact against a lookup string (name or email). Shared by
 * both the seed list and any extra contacts the caller passes through.
 */
function matches(c: Contact, lower: string): boolean {
  return (
    c.name.toLowerCase() === lower ||
    c.name.toLowerCase().includes(lower) ||
    (c.name.split(" ")[0].length >= 3 &&
      lower.includes(c.name.split(" ")[0].toLowerCase())) ||
    (!!c.email && lower === c.email.toLowerCase())
  );
}

/**
 * Find a contact by name or email. Seed contacts are always searched; pass
 * `extra` to also consider user-added contacts from the client's localStorage
 * (forwarded through the request body — they aren't readable server-side
 * otherwise).
 */
export function findContactByName(
  name: string,
  extra: Contact[] = []
): Contact | undefined {
  const lower = name.toLowerCase();
  return (
    extra.find((c) => matches(c, lower)) ||
    sampleContacts().find((c) => matches(c, lower))
  );
}

export function findContactByEmail(
  email: string,
  extra: Contact[] = []
): Contact | undefined {
  const lower = email.toLowerCase();
  return (
    extra.find((c) => c.email?.toLowerCase() === lower) ||
    sampleContacts().find((c) => c.email?.toLowerCase() === lower)
  );
}

export function getPersonaSummary(contact: Contact): string {
  return `${contact.name} (${contact.title}): ${contact.personality.substring(0, 200)}... Motivations: ${contact.whatMakesThemTick.substring(0, 150)}. Watch out: ${contact.watchOut.substring(0, 150)}`;
}

/**
 * Best-effort IANA timezone from a contact's location string.
 * Only used as a fallback when Slack profile tz is unavailable.
 */
export function timezoneFromLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const l = location.toLowerCase();
  // US East
  if (/florida|new york|new jersey|boston|east coast|eastern|atlanta|dc|washington|philadelphia|charlotte|miami|connecticut|massachusetts|maryland|virginia|pennsylvania/.test(l)) return "America/New_York";
  // US Central
  if (/chicago|texas|dallas|houston|austin|minnesota|central|nashville|memphis|kansas|oklahoma|iowa|illinois|wisconsin|michigan|indiana/.test(l)) return "America/Chicago";
  // US Mountain
  if (/denver|colorado|utah|mountain|albuquerque|phoenix|arizona/.test(l)) return "America/Denver";
  // US Pacific
  if (/los angeles|san francisco|california|seattle|portland|pacific|west coast|nevada|las vegas/.test(l)) return "America/Los_Angeles";
  // Mexico
  if (/mexico city|cdmx|mexico/.test(l)) return "America/Mexico_City";
  // Canada
  if (/toronto|ontario|canada east/.test(l)) return "America/Toronto";
  if (/vancouver|british columbia/.test(l)) return "America/Vancouver";
  // Europe
  if (/london|uk|england|scotland|wales|ireland/.test(l)) return "Europe/London";
  if (/paris|france/.test(l)) return "Europe/Paris";
  if (/berlin|germany/.test(l)) return "Europe/Berlin";
  if (/amsterdam|netherlands/.test(l)) return "Europe/Amsterdam";
  if (/dubai|uae/.test(l)) return "Asia/Dubai";
  if (/india|mumbai|bengaluru|delhi/.test(l)) return "Asia/Kolkata";
  if (/singapore/.test(l)) return "Asia/Singapore";
  if (/sydney|australia/.test(l)) return "Australia/Sydney";
  return undefined;
}

export function getAllPersonaSummaries(): string {
  return sampleContacts()
    .map(
      (c) =>
        `- **${c.name}** (${c.title}): Personality: ${c.personality.substring(0, 120)}... Tick: ${c.whatMakesThemTick.substring(0, 80)}. Watch: ${c.watchOut.substring(0, 80)}.`
    )
    .join("\n");
}
