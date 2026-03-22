# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| v2.x    | Yes       |
| v2.x    | No (use v2.x — see [migration notes](CHANGELOG.md)) |
| v1.x    | No        |

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

DM us on [X (@codependent_ai)](https://x.com/codependent_ai) or message the [Telegram channel](https://t.me/+xSE1P_qFPgU4NDhk) with:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)

We'll acknowledge within 48 hours and aim to patch critical issues within 7 days.

## Security model

Mind Cloud runs as a Cloudflare Worker — your deployment, your data.

- **No shared infrastructure** — each deployment is isolated with its own database and secrets
- **No telemetry** — nothing phones home
- **API key authentication** — all endpoints (MCP, REST, daemon trigger) require auth
- **Timing-safe comparisons** — API keys and HMAC signatures use constant-time comparison
- **Signed image URLs** — time-limited, HMAC-signed URLs for image access (no API key exposure)
- **Parameterized queries** — all SQL uses parameterized bindings to prevent injection
- **Error sanitization** — internal errors are logged server-side, generic messages returned to clients

### What to watch for

- **API key strength** — use a long random string for `MIND_API_KEY`, not a dictionary word
- **Separate signing secret** — set `SIGNING_SECRET` in production so image URL signing doesn't share the API key
- **MCP connector secret** — if using Claude.ai connectors, the secret is in the URL path. Use a long random string.
- **CORS origin** — set `DASHBOARD_ALLOWED_ORIGIN` to restrict which domains can call the API
- **Gemini API key** — this is sent to Google's API for embeddings. Treat it as a secret.
- **Neon connection string** — if using Postgres, the connection string contains credentials. Never commit it — use `wrangler secret` or Hyperdrive.

### Rate limiting

Mind Cloud does not implement application-level rate limiting. For production deployments, we recommend using [Cloudflare Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/) at the edge.
