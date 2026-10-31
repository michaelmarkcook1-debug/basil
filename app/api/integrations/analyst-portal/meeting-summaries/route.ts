import { meetingSummaries } from '@/lib/integrations/analyst-portal';
import { findByEmail, findByUsername } from '@/lib/users';
import { readUserStore } from '@/lib/storage/user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return meetingSummaries(request, {
    token: process.env.AG_PORTAL_SUMMARIES_TOKEN,
    account: process.env.AG_PORTAL_SUMMARIES_ACCOUNT,
    resolveAccount: async identity => identity.includes('@') ? findByEmail(identity) : findByUsername(identity),
    read: username => readUserStore<unknown>(username, 'sage-memory.json', null, { fresh: true }),
  });
}
