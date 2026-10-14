# ADR-0009: Outbound actions only via approved pending operations

## Status
Proposed

## Context
Approval state lives inside chat-history parts (`approval-requested`). An unanswered approval followed by a new message broke the conversation: the first fix (0d55d99) covered live parts, but not parts restored from History (fixed f644200). Sends (email reply, RSVP, Slack) are triggered from several screens and tools, with different auditing.

## Decision
Every outbound effect — send email, RSVP, propose time, schedule meeting, Slack post — is a **`pending_operation`** row: kind, payload, recipients, preview, status (`proposed | approved | denied | expired | done | failed`), approver and timestamps.
- The UI and chat render proposals from this table.
- Only **Effects** executes, and only `approved` rows.
- Each execution is audited and ingested back (so a sent reply closes its needs-reply).
- Chat history stores a reference to the operation, never its state.

## Consequences
### Positive
- No conversation can be broken by approval state.
- One audit trail; approvals work the same from Today, Inbox and chat.

### Negative
- An extra round trip for tool flows that the AI SDK's approval mechanism handled inline.

## Alternatives considered
- **AI SDK `needsApproval` parts as the source of truth** (status quo): rejected after two production breakages.
