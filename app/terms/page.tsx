import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "Terms of Service — Basil" };

export default function TermsPage() {
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
          <h1 className="basil-display text-3xl sm:text-4xl mb-2">Terms of Service</h1>
          <p className="text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
        </div>

        <div className="prose prose-sm max-w-none space-y-6 text-foreground [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_p]:text-muted-foreground [&_p]:leading-relaxed [&_ul]:text-muted-foreground [&_ul]:space-y-1 [&_li]:leading-relaxed">

          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your use of Basil, an executive
            operating system. By creating an account or using the service, you agree
            to these Terms.
          </p>

          <h2>1. Acceptable use</h2>
          <p>You agree to use Basil only for lawful purposes and in accordance with these Terms. You must not:</p>
          <ul>
            <li>Use the service to process or store data in violation of applicable laws.</li>
            <li>Attempt to gain unauthorised access to any part of the system.</li>
            <li>Interfere with or disrupt the service or its infrastructure.</li>
            <li>Share your account credentials with others.</li>
          </ul>

          <h2>2. Account responsibility</h2>
          <p>
            You are responsible for maintaining the confidentiality of your account
            credentials and for all activity that occurs under your account. Notify
            your administrator immediately if you suspect unauthorised access.
          </p>

          <h2>3. Third-party integrations</h2>
          <p>
            Basil connects to third-party services (Google, Microsoft, Slack, Anthropic)
            on your behalf. Your use of those services remains subject to their own
            terms of service. We are not responsible for the availability, accuracy,
            or conduct of third-party services.
          </p>

          <h2>4. AI-generated content</h2>
          <p>
            Basil uses AI to generate suggestions, drafts, and summaries. AI-generated
            content may be inaccurate or incomplete. You are solely responsible for
            reviewing and approving any content before acting on it or sending it to
            others. Basil will never send messages or take irreversible actions without
            your explicit approval.
          </p>

          <h2>5. Data and privacy</h2>
          <p>
            Your use of Basil is also governed by our{" "}
            <Link href="/privacy" className="text-[oklch(0.72_0.15_85)] hover:underline">
              Privacy Policy
            </Link>
            , which is incorporated into these Terms by reference.
          </p>

          <h2>6. Disclaimer of warranties</h2>
          <p>
            Basil is provided &ldquo;as is&rdquo; without warranties of any kind, express or
            implied. We do not warrant that the service will be uninterrupted,
            error-free, or that any defects will be corrected.
          </p>

          <h2>7. Limitation of liability</h2>
          <p>
            To the fullest extent permitted by law, we shall not be liable for any
            indirect, incidental, special, consequential, or punitive damages arising
            from your use of, or inability to use, the service.
          </p>

          <h2>8. Changes to these Terms</h2>
          <p>
            We reserve the right to modify these Terms at any time. Continued use of
            the service after changes are posted constitutes acceptance of the revised
            Terms.
          </p>

          <h2>9. Governing law</h2>
          <p>
            These Terms are governed by the laws of the jurisdiction in which the
            service operator is based, without regard to conflict of law principles.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about these Terms should be directed to your Basil administrator.
          </p>
        </div>

        <div className="mt-10 pt-6 border-t border-border flex items-center gap-4 text-xs text-muted-foreground">
          <Link href="/privacy" className="hover:text-foreground">Privacy Policy</Link>
          <Link href="/login" className="hover:text-foreground">Back to app</Link>
        </div>
      </div>
    </div>
  );
}
