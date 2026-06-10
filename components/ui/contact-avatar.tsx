"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface ContactAvatarProps {
  /** Display initials shown in the fallback (e.g. "MC"). */
  initials: string;
  /** Tailwind bg class for the fallback circle (e.g. "bg-signal-info"). */
  color: string;
  /** URL to the contact's headshot. AvatarImage falls back to initials on error (e.g. Gravatar 404). */
  photoUrl?: string;
  /** Size class(es) applied to the Avatar root — defaults to "h-8 w-8". */
  className?: string;
  /** Extra class(es) applied to AvatarFallback text. */
  fallbackClassName?: string;
}

/**
 * Renders a contact's avatar: real headshot when available, coloured initials otherwise.
 * Suitable for any size — pass a Tailwind sizing class via `className`.
 *
 * Usage:
 *   <ContactAvatar initials={c.initials} color={c.color} photoUrl={photos[c.email ?? ""]} className="h-10 w-10" />
 */
export function ContactAvatar({
  initials,
  color,
  photoUrl,
  className = "h-8 w-8",
  fallbackClassName = "text-xs",
}: ContactAvatarProps) {
  return (
    <Avatar className={className}>
      {photoUrl && (
        <AvatarImage
          src={photoUrl}
          alt={initials}
          referrerPolicy="no-referrer"
        />
      )}
      <AvatarFallback className={`text-white font-medium ${color} ${fallbackClassName}`}>
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
