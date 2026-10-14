# ADR-0003: A context graph with canonical people, identities and "self"

## Status
Proposed

## Context
"Who is this?" and "is this me?" are answered differently across Basil:
- Contacts match by fuzzy name in one place and by email in another.
- Slack users are matched by unique full name.
- "Self" is the Gmail address in the reply code, but settings plus aliases elsewhere.

Results seen: the user Cc'd on their own reply-all, "Matt" and "Matthew Paquette" as two people, colleagues filed as "external, Unknown — set role", newsletters given relationship tone reads, and "Michael Cook" vs "Michael" ownership confusion.

## Decision
Model **PERSON** (kind: `person | org | bot`) with many **IDENTITY** rows (`email`, `slack_id`, `zoom_email`, `display_name`), unique per user.
- **Self is a PERSON.** Its identities are gathered automatically: Gmail address and send-as aliases, Slack `auth.test` user, profile names.
- **Identity resolution is a pipeline stage** (ADR-0004). It works in this order: exact identifier, then the Slack directory (email and title, which marks internal), then domain rules, then unconfirmed.
- **Merges are rows** (reversible, shown in the UI).
- **Known apps and senders** (calendar apps, newsletter platforms) become `bot` or `org`.

Every "is X me?", "who is X?" and "last contact with X" question goes through this model.

## Consequences
### Positive
- Removes a whole class of errors with one join.
- The People page, Today, tone reads and actions all agree.

### Negative
- Resolution mistakes now affect everything (mitigated by confidence, confirmation and reversible merges).

## Alternatives considered
- **Per-feature matching** (status quo): rejected. It is the source of the inconsistencies.
- **A graph database** (Neo4j): rejected. Relationships are shallow, and Postgres joins suffice.
