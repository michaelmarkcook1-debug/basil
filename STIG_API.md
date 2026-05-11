# Embedded Stig API

Basil now contains The Stig as an internal API layer. There is no separate FastAPI/localhost backend required.

## Endpoints

| Endpoint | Method | Use |
|---|---:|---|
| `/api/stig/status` | GET | Check embedded API readiness, model config, source state, project-truth counts |
| `/api/stig/ask` | POST | General Stig reasoning over Basil context |
| `/api/stig/siri` | POST | Voice-friendly plain-text response for Apple Shortcuts/Siri |
| `/api/stig/briefing` | POST | All-source daily operating briefing |

## Auth

Dashboard/browser calls use the normal Basil session cookie.

External/phone/Siri calls can use a bearer token:

```bash
Authorization: Bearer $STIG_API_TOKEN
```

Set these environment variables for external access:

```bash
STIG_API_TOKEN=<long-random-token>
STIG_API_USERNAME=<basil-username-to-run-as>
```

`STIG_API_USERNAME` may fall back to `PRIMARY_OWNER_USERNAME` or `ADMIN_USERNAME`, but setting it explicitly is safer.

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Example ask call

```bash
curl -X POST "$APP_URL/api/stig/ask" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $STIG_API_TOKEN" \
  -d '{"question":"What needs my attention today?","mode":"briefing","includeSources":true}'
```

## Example Siri call

Use Apple Shortcuts → Get Contents of URL:

- URL: `https://your-basil-domain.com/api/stig/siri`
- Method: `POST`
- Headers:
  - `Content-Type: application/json`
  - `Authorization: Bearer <STIG_API_TOKEN>`
- JSON body:
  - `question`: dictated text

The endpoint returns `text/plain` so Shortcuts can pass it straight into Speak Text.

## Source order

The Stig API builds a live source pack from:

1. Slack Command Centre
2. Project Truth Layer
3. Calendar
4. Gmail
5. Actions
6. Decisions
7. Memory

It obeys Basil's existing factuality rules: no source, no claim. Elegant. Annoying. Correct.
