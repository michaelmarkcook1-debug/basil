import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "Privacy Policy — Basil" };

export default function PrivacyPage() {
  const lastUpdated = "25 April 2026";

  return (
    <div className="min-h-screen basil-surface">
      <div className="max-w-2xl mx-auto px-4 py-12 sm:px-6">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>

        <div className="mb-8">
          <p className="basil-eyebrow mb-2">Legal</p>
          <h1 className="basil-display text-3xl sm:text-4xl mb-2">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
        </div>

        <div className="prose prose-sm max-w-none space-y-6 text-foreground [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_p]:text-muted-foreground [&_p]:leading-relaxed [&_ul]:text-muted-foreground [&_ul]:space-y-1 [&_li]:leading-relaxed">

          <p>
            Basil (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) is an executive operating system
            that connects to your calendar, email, and messaging tools to help you
            manage your work. This policy explains what data we collect, how we use
            it, and your rights over it.
          </p>

          <h2>1. What data we collect</h2>
          <ul>
            <li><strong>Account data:</strong> Name, email address, username, and a hashed password created during registration.</li>
            <li><strong>Profile data:</strong> Job title, company, timezone, working hours, and communication preferences you provide during onboarding or in Settings.</li>
            <li><strong>Connected services:</strong> OAuth tokens for Google (Calendar, Gmail) and Microsoft (Outlook, Calendar) that you explicitly authorise. We store only the access and refresh tokens — not your credentials.</li>
            <li><strong>Operational data:</strong> Calendar events, emails, and Slack messages fetched to power the Briefing, Schedule, and Chat features. This data is processed in memory and stored in your account&rsquo;s secure data store.</li>
            <li><strong>Usage data:</strong> Session logs and last-login timestamps used for security and account management.</li>
          </ul>

          <h2>2. How we use your data</h2>
          <ul>
            <li>To provide the core features of Basil (briefings, scheduling, AI chat).</li>
            <li>To authenticate you and maintain secure sessions.</li>
            <li>To send AI-generated content to third-party AI providers (Anthropic Claude) solely to generate responses. We do not train models on your data.</li>
            <li>To display contact relationship signals and proactive suggestions.</li>
          </ul>

          <h2>3. Data sharing</h2>
          <p>
            We do not sell your data. We share data only with:
          </p>
          <ul>
            <li><strong>AI providers (Anthropic):</strong> Message content is sent to generate AI responses. Subject to Anthropic&rsquo;s <a href="https://www.anthropic.com/privacy" className="text-[oklch(0.72_0.15_85)] hover:underline" target="_blank" rel="noopener noreferrer">privacy policy</a>.</li>
            <li><strong>Google and Microsoft:</strong> OAuth tokens are exchanged directly with their APIs. We act as an authorised client on your behalf.</li>
            <li><strong>Hosting (Vercel):</strong> Application infrastructure. Subject to Vercel&rsquo;s <a href="https://vercel.com/legal/privacy-policy" className="text-[oklch(0.72_0.15_85)] hover:underline" target="_blank" rel="noopener noreferrer">privacy policy</a>.</li>
          </ul>

          <h2>4. Data retention</h2>
          <p>
            Your data is retained for as long as your account is active. You may request
            deletion at any time by contacting the administrator or using the account
            deletion feature in the admin panel. OAuth tokens are revocable from your
            Google or Microsoft account settings at any time.
          </p>

          <h2>5. Security</h2>
          <p>
            Passwords are hashed using bcrypt (cost factor 12). Sessions use signed JWTs
            with a 30-day expiry. All data in transit is encrypted via TLS. We do not
            store plaintext passwords.
          </p>

          <h2>6. Your rights</h2>
          <p>
            Depending on your jurisdiction you may have rights to access, correct, port,
            or delete your personal data. Contact your Basil administrator to exercise
            these rights.
          </p>

          <h2>7. Changes to this policy</h2>
          <p>
            We may update this policy from time to time. The &ldquo;last updated&rdquo; date at the
            top of this page will reflect any changes.
          </p>

          <h2>8. Contact</h2>
          <p>
            Questions about this policy should be directed to your Basil administrator.
          </p>
        </div>

        <div className="mt-10 pt-6 border-t border-border flex items-center gap-4 text-xs text-muted-foreground">
          <Link href="/terms" className="hover:text-foreground">Terms of Service</Link>
          <Link href="/login" className="hover:text-foreground">Back to app</Link>
        </div>
      </div>
    </div>
  );
}
