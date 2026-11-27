# Follow-ups register

Everything the story agents and the integrator reported, updated **2026-11-27**. For the consolidated forward-looking roadmap and prioritized blockers, see **[`docs/CHECKPOINT.md`](./CHECKPOINT.md)**. Tick an item (`[x]`) and add the PR number when done.

**Owners:** *integrator* = chore PR; *story X* = fold into that story's PR; *Ashok* = needs a human; *migration* = needs Ashok's OK first.

## A. Integrator chore PR (small wiring stories could not do)

- [x] **"New event" link** on `src/app/routes/events/EventListPage.tsx` pointing to `/events/new`. Nothing links to the page today. _(S3.3)_ — done in integrator chore PR
- [x] **"Schedule and occurrences" link** on `src/app/routes/admin/terms/SeriesPage.tsx` pointing to `/admin/terms/series/:id/schedule`. Nothing links to the screen. _(S3.2)_ — done in integrator chore PR
- [x] **Claims links** on `src/app/routes/money/MoneyPage.tsx` (to `/money/claims`) and `src/app/routes/admin/money/AdminBalances.tsx` (to `/admin/money/claims`), now that the S5.5 screens (#57) are merged. _(S5.5)_ — done in integrator wrap-up PR
- [x] **Passes link** on `src/app/routes/money/MoneyPage.tsx` (to `/money/passes`), if desired. _(S5.3)_ — done in integrator wrap-up PR
- [x] **Privacy link** on `src/app/routes/auth/SignInPage.tsx` (to `/privacy`, PLAN §16), and optional "Erase member" action on `src/app/routes/admin/members/AdminMembers.tsx`. _(S2.5)_ — privacy link done in integrator wrap-up PR
- [x] **Attendance slot visibility after event ends:** remove `!event.readOnly` from `OrganizerToolsSlot` in `src/app/routes/events/EventDetailPage.tsx` (and update `src/app/routes/events/events.test.tsx`) so organizers can mark attendance after `endsAt`. _(S8.1)_ — done in integrator wrap-up PR
- [x] **Post-close exit cancel (optional):** wire `src/worker/rsvp/cancel.ts` (`cancelMemberRsvps`) to also call `lateCancelRsvp` for future closed events when a member is deactivated. _(S4.4a)_ — done in unslop/ponytail polish PR
- [x] **Money → History link:** on `src/app/routes/money/MoneyPage.tsx`, link event-tied ledger items (`item.eventId !== null`) to `/history?eventId=${item.eventId}`. _(S8.2)_ — done in integrator wrap-up PR
- [x] **"Request to join" link** to `/join/event/<slug>` on the event page's 403 state in `EventDetailPage.tsx`. A pending member sees no call to action there. May overlap S7.1. _(S1.3)_ — done in integrator chore PR
- [x] **Complete the saved RSVP after approval:** call `completeJoinRsvpIntent()` (`src/app/routes/join/joinIntent.ts`) from `src/app/shell/AppRoot.tsx`. Today the saved RSVP only completes when the approved member opens `/join`. _(S1.3)_ — done in integrator chore PR
- [x] **Inbox unread badge:** wire `badges.inbox` in the shell; `GET /notifications` already returns `unreadCount`. _(S6.1)_ — done in integrator chore PR
- [x] **Unsubscribe push on sign-out:** call `unsubscribePush()` from `src/sw/push-client.ts`. (S10.2 already re-subscribes on app open.) _(S6.2)_ — done in integrator chore PR
- [x] **Push-permission trigger:** call `noteRsvpSaved()` (`src/app/components/install/`) in `RsvpPanel` after a successful RSVP save. Until then the push card never appears on its own; members can still opt in at `/install`. _(S10.2)_ — done in integrator chore PR
- [x] **Pass holders must not be tier 1 at one-offs:** make `src/worker/rsvp/` use `rsvpTier(event, isPrepaid)` from `src/worker/events/oneoff-rules.ts` instead of reading `isPrepaid` directly. Verified 2026-11-24: nothing calls `rsvpTier` yet. _(S3.3, S4.2)_ — done in integrator chore PR
- [x] **Deactivating a member must cancel their RSVPs:** wire `configureRsvpCancel(rsvpCancelAdapter(db, clock))`. S2.1's port has no db parameter, so this needs per-request wiring or a port change. Until then production runs `noopRsvpCancel`. Add a test that the production default is not the no-op. _(S2.1, S4.2)_ — done in integrator chore PR
- [x] **Exited members can't see how to pay:** add `allowInactive: true` to `GET /settings/public` and `GET /me/profile`. They see their balance but not the bank details or payment reference. _(S5.2)_ — done in integrator chore PR
- [x] **`NotifyPort` link:** optionally add `link?` to `NotifyPort` in `src/worker/core/ports.ts` so callers typed against the port can pass a deep link. _(S6.1)_ — done in integrator chore PR
- [x] **`ChargePort` fields:** optionally add `eventId`, `passId`, `guestId`, `note` to the shared `ChargePort` interface; the production adapter already accepts them. _(S5.1)_ — done in integrator chore PR
- [x] **Move the Clerk origin guard** from a `use("*")` in `src/worker/auth/routes.ts` to `src/worker/app.ts`. Today it only covers areas whose `routes.ts` sorts after `auth`, which is every current area. _(S1.1)_ — done in integrator chore PR
- [x] **Remove the S0.1 probe route** (`src/worker/probe/`, `src/app/routes/probe/`) and its allowlist entry in `src/worker/core/route-guard.test.ts`. _(S0.1)_ — done in integrator chore PR
- [x] **Align `src/worker/ops/health.ts`** with `scheduler/schedule.ts`. It still treats UTC 05–21 as the frequent window, so during UTC 22:00–22:59 the `/healthz/ready` staleness check is lenient (2 h instead of 20 min). Harmless. Use `cronIntervalMs`. _(S6.4)_ — done in integrator chore PR
- [x] **Fold the series slug generator** in `src/worker/terms/routes.ts` into `src/worker/events/slugs.ts` (`randomSlug`, `uniqueSlug`). _(S3.1)_ — done in integrator chore PR
- [x] **Add `FLAG_POLLS`** to `wrangler.jsonc` and `worker-configuration.d.ts`; it does not exist yet, so polls can't be switched on. _(S9.1)_ — done in integrator chore PR
- [x] **Flip flags** `FLAG_EVENTS`, `FLAG_MONEY`, `FLAG_INBOX`, `FLAG_POLLS` to "on" in `wrangler.jsonc` (`fe34f58`).
- [x] **`FLAG_EVENTS` area manual/Playwright verification** across Events, Terms, Recurrence, One-offs, and RSVP (#83, #87, #88, #93).
- [ ] **Decide on gating the broadcast screen:** `/admin/broadcast` has no flag because no admin flag exists. _(S6.6)_
- [ ] **Add `GET /series` access decision:** it allows any active member and returns an empty list for non-captains. Make it admin-and-captain only if wanted (one-line guard change). _(S3.1)_
- [ ] **Account-code keys** in the settings form (`pass`, `adhoc`, `guest`, `payment`) are provisional. Confirm with the treasurer, then lock them (and check whether `club_fee` needs its own account code for S5.6). _(S2.3, S5.6, #86)_
- [ ] **`/config` additions:** if the shell needs non-sensitive fields before sign-in (for example `clubName`), add them to `/config` from `toPublicSettings`. _(S2.3)_

## B. Finish within a story (not a chore)

- [x] **S5.5 screens:** member `src/app/routes/money/claims*` and admin `src/app/routes/admin/money/claims*`. The API (`/me/payment-claims`, `/admin/payment-claims`, confirm and reject) is merged. Add the claim routes to `docs/areas/ledger.md`. _(S5.5)_ — done in #57
- [x] **S4.3** must call `markDue(ctx.kv, rsvp_close_at)` when events get close times, and register its close hook with `registerTickHook`. S4.2 deliberately did not call `markDue`. S3.2 already calls `markDue` for generated events. _(S4.2, S6.4)_ — done in #59
- [x] **S4.3, S5.3 charge inside a transaction:** pass their transaction as `db` to `createLedgerService` or `createChargePort`, with stable keys such as `close:<eventId>:<memberId>` and `reverse:<entryId>`. _(S5.1)_ — done in #59 and #60
- [x] **S5.3** implements `isPrepaid` and replaces `nobodyPrepaid` via `configureRsvpDeps({ prepaid })`. Pass revocation and the "revocable" filter in admin money belong to S5.3. _(S4.2, S5.4)_ — done in #60
- [x] **S7.1** must call `configureEventsDeps({ publishOg })` and remove the no-op `PublishOgPort` default (DoD 8). OG key is `og:event:<slug>`; the value is a JSON snapshot of public fields only. _(S3.0)_ — done in #71
- [x] **S4.2 / S4.4x / S7.1 / S8.x slot fillers** call `registerSlot(name, Component)` from `src/app/routes/events/slots` at module load, in their own `routes.tsx`. Their Owns lines already include the import line in `events/routes.tsx`. _(S3.0)_ — all slot fillers merged (#59–#71)
- [ ] **Event creation API:** `createEvent` is the only insert path. Callers: S3.2 (done), S3.3 (done); anything new must use it. _(S3.0)_
- [x] **S8.2, S2.5** (own attendance, own export) pass `allowInactive` on their own-data routes. _(S2.1)_ — S2.5 done in #61, S8.2 done in #68
- [x] **S6.5b** UI uses S6.5a's API: `/admin/reminder-rules`, `/:id/preview`, and the placeholder list in the list response. S6.5a left "poll closing soon" to S9.1 (done there). _(S6.5a)_ — done in #56
- [x] **S6.5a** payment-reminder interval counts Stockholm calendar days; deleting a rule that already sent returns 409 (disable instead). Reminders use mute categories `new_events` and `payment_due`. Keep when building the UI. _(S6.5a)_ — kept in #56
- [ ] **S5.6** needs the treasurer's manager.io import format before it can start. _(S2.3)_
- [ ] **S10.1 Home** may take over `<InstallPrompt/>` from `AppShell`. _(S10.2)_
- [x] **S11.1 club-week scenarios** should start growing now, not at the end. _(plan)_ — done in #74

## C. Product and design decisions to revisit

- [ ] **Captains and capacity:** captains cannot edit series capacity (admin only, because it moves `pass_cap`). PLAN §4 lists capacity among captain edits. Ask Ashok if he wants captains to have it. _(S3.1)_
- [ ] **Only-admin payment claims:** S5.5 stops an admin confirming or rejecting their own claim even if they are the only admin (stricter than rule A11). They can still record their own payment via `POST /admin/payments`. Confirm that is intended. _(S5.5)_
- [ ] **RSVP audience for broadcasts** excludes cancelled and late-cancelled members; PLAN doesn't say. _(S6.6)_
- [ ] **"At publish" reminder** means "event starts within 7 days", because events have no publish time. Confirm. _(S6.5a)_
- [ ] **Anonymous polls** hide voters from admins too and cannot be switched to named later. Confirm. _(S9.1)_
- [ ] **Push batch cap = 20** (PLAN §11 says at most 10 per run). Revisit after the S0.6 device spike. _(S6.2)_
- [ ] **Google sign-in in the installed iOS app:** `GOOGLE_HIDDEN_IN_INSTALLED_IOS` in `src/app/auth/google.ts` was flipped to `false` in `#80` so SSO buttons show in installed iOS PWAs. Re-verify full OAuth completion against the Clerk production instance during `S0.6`. _(S1.1, #80)_
- [ ] **Sign-in intent expires after 30 minutes;** the join RSVP intent lives 14 days under its own key (`bcq.join-rsvp-intent`) because approval can take days. _(S1.1, S1.3)_
- [x] **Colour contrast:** the install-card axe test turns colour contrast off (`InstallPrompt.test.tsx:57`). Re-enable it and fix any real contrast issue now that the palette changed. _(S10.2, brand)_ — re-enabled and passing in `#76`; `--bcq-muted` also darkened to `#526075` in `#93` for WCAG AA on `#faf8f5`.
- [ ] **Brand:** replace the PNG-derived icons with an SVG logo when one exists; set the Clerk dashboard app name to BOLT HQ; existing home-screen installs keep the old name until re-added. _(brand)_

## D. Technical debt and optional hardening

- [ ] **Optional migrations (need Ashok's OK):** unique index on `rsvp(event_id, member_id)` as a backstop to the row lock _(S4.2)_; index on `audit_log(at desc, id desc)` if the table grows _(S2.4)_.
- [ ] **Vitest pool:** `@cloudflare/vitest-pool-workers` 0.23 is deprecated (now `@cloudflare/vitest-plugin`); migrating may let the db suites back into the Worker pool. _(S0.2)_
- [ ] **`worker-configuration.d.ts`** is hand-edited for the `FLAG_*` vars; a `wrangler types` refresh rewrites 28k lines, so do it alone in its own PR. _(S0.1)_
- [ ] **Playwright sign-in via Clerk testing tokens** was not built (needs Clerk keys in CI and `@clerk/testing`, which is not installed). Vitest covers sign-in behaviour. _(S1.1)_
- [ ] **E2E coverage gaps:** 12 Playwright specs now run in CI across 4 shards (`club-week`, `mobile-responsive-and-shell`, `pwa`, `s2.5-privacy`, `s5.2-member-money`, `s5.3-passes`, `s5.5-claims`, `s6.5b-reminders`, `s7.1-share`, `s9.2-poll-images`, `shell`, `smoke`). Dedicated specs for `AdminMembers`, `AdminApprovals`, `AdminTerms`, `AdminClubFees`, `AdminAudit`, and `NewEvent` one-off flows are still optional additions.
- [ ] **Client bundle code-splitting:** `dist/client/assets/index-*.js` is ~614 KB minified (~167 KB gzipped); lazy-loading admin routes via dynamic `import()` would reduce initial member payload.
- [ ] **Optional `AdminMembers` erase trigger:** `POST /admin/members/:id/erase` (`S2.5`) is implemented and tested on the backend, with no UI button in `AdminMembers` yet.
- [ ] **`link` for notifications:** only in-app paths are stored or followed; anything else falls back to the category's screen. Keep it that way. _(S6.1)_

## E. Operations and accounts (Ashok)

- [ ] See [`docs/CHECKPOINT.md`](./CHECKPOINT.md) and [`docs/LAUNCH.md`](./LAUNCH.md): custom domain + Clerk production instance, `S0.6` real-device spike, off-site 90-day backup store + real restore drill, first Lighthouse run, treasurer format for `S5.6`, GitHub `production` environment required reviewer, optional branch protection.
- [ ] **Public repo hygiene:** the repo is public. Keep `.env.local` and `.audit/` gitignored; confirm Neon password was rotated if ever shared in chat.

## F. Process notes from the agents

- Postgres-backed tests ran only in CI for most stories; a few first-run CI failures were test bugs (for example a missing-key request that sent a default key). Run the `db` project locally when `pg` and Postgres are available.
- Many PRs conflicted on `docs/DECISIONS.md`. Fixed by `merge=union` in `.gitattributes`; still check section order after a merge.
- Stories that mount a sub-app need the integrator to grant one line in the area's `routes.ts`; ask early.
- Playwright "Install browsers" flakes: `gh run rerun <id> --failed`.
