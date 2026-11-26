# Phase 1 development notes

## First implementation milestone

The dashboard runs with synthetic events or Supabase Auth and user-scoped stored events. The schema isolates users, enforces provider and ownership integrity on imports, and gives repeated imports a unique key per source event. The agenda groups copies with matching iCalendar UID and occurrence start. The conflict detector marks overlapping busy intervals and treats an event's end as exclusive. Consumer email domain detection runs in the browser, with a manual selection for custom domains.

The repository includes a dedicated Cloudflare Worker entry point and Supabase migration. The initial deployment will require isolated Cloudflare and Supabase resources. This milestone made no purchases and accessed no live calendar data.

## Verification

The production bundle and five automated tests passed. A local Worker run returned a healthy response and served the built dashboard. A narrow Chromium viewport verified the demo agenda, conflict badges, title hiding, and automatic and manual provider selection. The migration ran in an embedded PostgreSQL instance with synthetic Supabase roles and users. It allowed each user to read only their own calendar rows, blocked account ID reads and client updates, and denied anonymous event access. Hosted Supabase sign-in and provider APIs still need integration testing.

## Read-only onboarding and imports

The Worker issues owner-only OAuth requests with single-use state, a secure browser cookie, and PKCE for Google and Microsoft. Zoho uses a server-based client in one configured data center. Credentials are encrypted with AES-GCM and bound to their owner, provider and provider account ID. The dashboard supports pause, resume and disconnect. Disconnect removes imported rows and the stored credential. Access can also be revoked at the provider.

A Cloudflare cron runs every two minutes and claims one due account with a database lease. The account is eligible again ten minutes after a successful run. Each run fetches an 18-day rolling window. The dashboard exposes the next 14 days. A complete fetch can update events and remove missing rows within the fetched window. A partial or failed fetch leaves the last good snapshot intact. Throttling and transient failures delay the next attempt. Revocation prompts reauthorization. Full-window polling is appropriate for a small personal deployment. Provider cursors, queue fan-out, historical retention cleanup, and all-day date fidelity across time zones remain follow-up work.

The local checks use simulated provider requests and isolated database roles. Live account consent, Graph shared-calendar behavior, Zoho event response variants, and the deployed Free plan's CPU budget need real-account verification. The browser and watch probe use the same HTTPS origin. The watch probe returns a request ID and time and has no access to private data.

## Remaining prototype work

- Set up the dedicated Cloudflare Worker, custom domain and Supabase project, then verify private sign-in and the same live agenda on desktop and iPhone.
- Complete and verify iCloud CalDAV discovery, recurring events and app-specific password enrollment. Keep iCloud disabled until its read-only behavior is verified.
- Install a watchOS build and verify the direct HTTPS check with the paired iPhone powered off. Private Watch agenda access requires device authentication. Ask Watch integration requires identifying the intended product or feature and its supported API.
- Add unified email after the calendar milestone. Live provider writes require separate authorization.
