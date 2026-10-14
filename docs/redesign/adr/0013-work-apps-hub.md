# ADR-0013: One "Work Apps" tab with pluggable app adapters

## Status
Accepted (requested by Michael, 2026-10-14)

## Context
Linear and AI coding-tool tracking ("AI Tools": Claude Code, Claude.ai projects, GitHub) are separate left-hand navigation items with separate pages and code paths. Michael wants them under **one tab** that toggles between apps, and that can take **any other app he chooses to add**. Linear issues should *not* become commitments (they feed the project radar).

## Decision
- **One left-hand navigation item, "Work Apps".** It opens a hub with a segmented toggle across the apps the user has added (e.g. **Linear | Code | + Add app**). The last-selected app is remembered per user.
- **Each app is an adapter** behind one interface in the `apps` module:
  ```ts
  interface WorkAppAdapter {
    id: string; name: string; icon: string;
    connect(user): ConnectFlow;            // OAuth / API key / none
    sync(user, cursor): Promise<SyncResult>; // → cached rows in app_items
    view: AppViewConfig;                   // list columns, filters, item detail
    toRadar?(items): ProjectSignal[];      // optional: feed the project radar
  }
  ```
- **Synced items land in a generic `app_items` table** (`user_id`, `app_id`, `external_id`, `title`, `status`, `url`, `updated_at`, `data jsonb`). The hub renders from it: no live fan-out (ADR-0007), with "as of".
- **Adding an app** means registering an adapter. The user enables it from "+ Add app" (connect flow included). The first adapters are **Linear** and **Code**.
- **Apps never write commitments directly.** They may contribute project signals (`toRadar`), and the user can turn an item into a commitment by hand.

## Consequences
### Positive
- One place for work tools; new apps are an adapter, not a new page plus route plus nav item.
- Consistent caching, "as of" and connect flows.

### Negative
- A generic view can't do everything a bespoke page can (mitigated by `AppViewConfig` and a per-app detail slot).

## Alternatives considered
- **A page per app** (status quo): rejected. It duplicates the nav and plumbing every time.
- **Embedding the apps' own UIs** (iframes): rejected. Auth and CSP friction, and nothing feeds Basil's context.
