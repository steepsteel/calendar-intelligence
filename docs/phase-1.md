# Phase 1 development notes

## First implementation milestone

The dashboard runs with synthetic events or Supabase Auth and user-scoped stored events. The schema isolates users, enforces provider and ownership integrity on imports, and gives repeated imports a unique key per source event. The agenda groups copies with matching iCalendar UID and occurrence start. The conflict detector marks overlapping busy intervals and treats an event's end as exclusive. Consumer email domain detection runs in the browser, with a manual selection for custom domains.

The repository includes a dedicated Cloudflare Worker entry point and Supabase migration. The initial deployment will require isolated Cloudflare and Supabase resources. This milestone made no purchases and accessed no live calendar data.

## Verification

The production bundle and five automated tests passed. A local Worker run returned a healthy response and served the built dashboard. A narrow Chromium viewport verified the demo agenda, conflict badges, title hiding, and automatic and manual provider selection. The migration ran in an embedded PostgreSQL instance with synthetic Supabase roles and users. It allowed each user to read only their own calendar rows, blocked account ID reads and client updates, and denied anonymous event access. Hosted Supabase sign-in and provider APIs still need integration testing.

## Prototype work remaining

- Implement read-only Google and Microsoft OAuth with callback state bound to the signed-in user, PKCE where supported, and encrypted refresh token storage. Implement Zoho OAuth with region-aware endpoints and verify Apple iCloud CalDAV discovery and app-specific-password handling.
- Add paginated imports and provider-specific event normalization, including recurring exceptions, cancelled events, source time zones and all-day dates. Provider identifiers and cursor storage must support safe retries.
- Use a Worker cron trigger and Cloudflare Queue for per-connection sync. Use an atomic database claim or lease to avoid concurrent processing, idempotent upserts for redelivery, and delayed retries for throttling. Distinguish transient failures from credentials that require reauthorization.
- Add pause, disconnect and data deletion controls. Validate sign-in, tenant isolation and sync against dedicated test accounts before a personal deployment.
- Verify Apple Watch requirements with a small watchOS agenda prototype. The browser dashboard's narrow layout is an initial accessibility step. Investigate the intended Ask Watch product or feature and its supported interface before selecting an integration approach.

A usable connected prototype still requires provider app registrations, test credentials, and deployed isolated infrastructure. Confirm recurring costs and obtain approval before purchases.
