# Donation Goal LLM Spec

Version: `1.0`  
Scope: donation goal editor + OBS widget + donation integrations  
Primary URLs:

- Editor: `http://localhost:3000/donation-goal.html`
- OBS widget: `http://localhost:3000/widget/donation-goal`

---

## 1. Purpose

This specification is intended for an AI agent that must modify or extend the donation goal system without breaking existing behavior.

---

## 2. System Boundaries

### In Scope

- Donation goal state and rendering
- Donation bar state and rendering
- Goal settings persistence and normalization
- Real-time synchronization via WebSocket
- DonationAlerts and DonatePay ingestion paths that affect goal/bar
- Import/export/snapshots related to goal config/state

### Out of Scope

- Unrelated widgets not tied to donation goal/bar
- Global stream overlays unless directly consuming goal/bar contracts

---

## 3. Canonical Files

- Backend: `server.js`
- Editor UI/runtime: `public/donation-goal.html`
- OBS widget runtime: `public/widget/donation-goal.html`
- Legacy redirect: `public/widget-donation-goal.html`

---

## 4. Core Entities and Data Contracts

## 4.1 Donation Goal Entity

Canonical fields expected in payload:

- `id`
- `title`
- `targetAmount`
- `currentAmount`
- `totalDonations`
- `avgDonation`
- `lastDonationTime`
- `settings` (normalized object)

Notes:

- Values in DB may be snake_case; API payload uses normalized/expected frontend format.
- `settings` MUST be normalized before returning to clients.

## 4.2 Donation Bar Entity

Canonical fields expected in payload:

- `id`
- `currentAmount`
- `settings` (normalized object)

## 4.3 Settings Object

`settings` is versioned JSON stored as TEXT in DB and normalized by backend and client.

Required behavior:

- Missing keys receive defaults.
- Legacy values are mapped to current schema.
- Unknown keys are tolerated unless explicitly unsafe.

---

## 5. API Contracts

## 5.1 Goal Endpoints

- `GET /api/donation-goal`
  - Returns current normalized goal payload.
- `PUT /api/donation-goal`
  - Accepts updates including `settings`.
  - MUST normalize settings before persist + response.
  - MUST broadcast realtime updates after success.
- `POST /api/donation-goal/manual-donation`
  - Adds manual donation and updates goal state.
- `POST /api/donation-goal/reset`
  - Resets goal counters/state as implemented.
- `GET /api/donation-goal/history`
  - Returns goal donation history.
- `GET /api/donation-goal/export`
  - Returns exportable config/state package.
- `POST /api/donation-goal/import`
  - Restores config/state package.
  - MUST preserve compatibility checks.
- `GET /api/donation-goal/snapshots`
- `POST /api/donation-goal/snapshots`
- `POST /api/donation-goal/snapshots/:id/restore`

## 5.2 Bar Endpoints

- `GET /api/donation-bar/state`
- `PUT /api/donation-bar/state`
- `POST /api/donation-bar/add`

## 5.3 API Invariants

- Always return normalized `settings`.
- Do not silently drop required numeric fields.
- Keep response keys stable for existing frontend consumers.

---

## 6. WebSocket Protocol

Socket endpoint: `/ws`

Relevant event types:

- `DONATION_GOAL_UPDATE`
- `DONATION_BAR_UPDATE`
- `WIDGET_SETTINGS_UPDATE`

`WIDGET_SETTINGS_UPDATE` requirements:

- include `scope: 'donation-goal'`
- include normalized `settings`

Protocol invariants:

- Event names are backward-compatible and stable.
- Goal/bar update payload shape must remain consistent.
- If settings changed, clients should receive settings update without polling dependency.

---

## 7. Editor Runtime Contract (`public/donation-goal.html`)

Core modules/behaviors:

- Local state container: `goalState`
- API adapter: `GoalApi`
- Client settings normalization: `normalizeClientSettings`
- Save path: `saveGoal(...)`
- WebSocket connect/reconnect: `connectWebSocket()`
- Visual engine: `applyBarVisualTheme(...)`

Concurrency contract:

- `customDesignDirty` prevents incoming WS/API state from overwriting active local custom edits.
- Debounced autosave (`customDesignAutosaveTimer`) persists custom style changes.
- `customDesignSaveInFlight` avoids duplicate overlapping silent saves.

Do not break:

- live preview updates,
- undo/redo/snapshot compatibility,
- profile/media settings persistence.

---

## 8. OBS Widget Contract (`public/widget/donation-goal.html`)

Startup flow:

1. Fetch initial goal state from REST.
2. Connect WS and apply live updates.
3. Render values and style.

Render contract:

- Text values (title/current/target/percent) must map to goal payload.
- Fill width derives from current/target ratio.
- Style path:
  - custom design -> `applyCustomDesign(...)`
  - preset fallback -> `applyPreset(...)`
  - final style application -> `applyBarVisualThemeWidget(...)`

Profile/media contract:

- Optional query param `?profile=<id>` may override visual/media settings.
- Media can be image/video background with overlay.

---

## 9. Donation Integration Contracts

## 9.1 DonationAlerts

- OAuth authorization + callback flow on backend.
- Access token persisted in app state.
- Polling starts when credentials/token are valid.

## 9.2 DonatePay

Supported ingestion channels:

- API-based polling
- optional realtime (Centrifugo path)
- webhook: `POST /webhook/donatepay`

Webhook contract:

- If secret configured, signature verification is enforced.
- Invalid signature must not mutate goal/bar state.

## 9.3 Unified Internal Donation Object

Before applying to goal/bar, normalize donor event to canonical object:

- `amount` (number > 0)
- `username` (string fallback allowed)
- `message` (string, optional)
- source metadata (`platform`, ids, timestamps)

---

## 10. State Transition Rules

On accepted donation:

1. Persist donation in donation storage/history.
2. Apply `updateDonationGoal(donation)`:
   - increment `current_amount`,
   - increment `total_donations`,
   - recompute `avg_donation`,
   - set `last_donation_time`.
3. Apply `updateDonationBar(donation)`:
   - increment bar amount.
4. Persist snapshot when applicable.
5. Broadcast WS updates.

If any DB step fails:

- log error with context,
- avoid partial silent success response,
- preserve system recoverability.

---

## 11. Invariants (Must Hold)

1. Backend settings normalization always runs on read/write boundaries.
2. Editor and widget render engines remain behaviorally aligned.
3. WS updates are eventual-consistent with persisted DB state.
4. Manual donation path and external donation path produce equivalent goal/bar updates.
5. Import/restore operations keep schema compatibility.
6. New style features do not crash legacy settings payloads.

---

## 12. Failure Modes and Recovery

## 12.1 Common Failure Modes

- Invalid/expired OAuth token (DonationAlerts)
- Rate limit / network error (Donation APIs)
- Invalid webhook signature
- Partial settings object from old clients
- WS disconnect / reconnect loops
- Concurrent edit overwrite (editor vs remote updates)

## 12.2 Required Recovery Behavior

- Retry polling with safe delay/backoff strategy.
- Keep serving last known persisted state.
- Reconnect WS with delay; no tight loop.
- Never discard local custom edit session while `customDesignDirty` is active.
- Normalize and sanitize incoming settings before applying.

---

## 13. Backward Compatibility Rules

When adding any new field or fill type:

1. Add backend default in normalization.
2. Add editor support (controls + renderer).
3. Add OBS widget renderer support.
4. Add fallback mapping for legacy values where needed.
5. Ensure existing presets still render correctly.

---

## 14. Performance Constraints

- Avoid repeated creation of dynamic style nodes when not needed.
- Avoid animation restarts caused by changing keyframe names on every update.
- Keep WS payloads compact and focused.
- Avoid unnecessary full-state polling if WS already provides updates.

---

## 15. Security and Validation

- Validate numeric amounts (`> 0`) before state mutation.
- Validate webhook signature when secret configured.
- Sanitize external strings before rendering in HTML contexts.
- Do not expose secrets in logs/responses.

---

## 16. Acceptance Tests (Required)

1. Open editor + OBS widget; verify both receive live changes.
2. Save custom design; refresh both pages; verify persistence.
3. Trigger manual donation; verify goal/bar increments and WS updates.
4. Import/export roundtrip; verify no schema loss.
5. Snapshot create -> mutate -> restore; verify exact rollback.
6. Simulate WS reconnect; verify state remains consistent.
7. Validate legacy settings payload still renders.

---

## 17. AI Agent Execution Rules

If asked to modify donation goal system:

1. Read backend normalization and payload builder functions first.
2. Identify if change affects editor, widget, or both.
3. Implement mirrored visual logic in both runtimes if style-related.
4. Preserve event names and payload keys.
5. Run lint/checks for touched files.
6. Provide migration/fallback logic for legacy settings.

Do not:

- rename WS event types without coordinated client updates,
- bypass settings normalization,
- introduce one-sided visual behavior only in editor or only in widget.

---

## 18. Traceability Map

Primary functions/symbols to inspect before edits:

- Backend:
  - `normalizeDonationWidgetSettings`
  - `buildDonationGoalPayload`
  - `buildDonationBarPayload`
  - `broadcastDonationWidgetState`
  - `persistDonationGoalSnapshot`
  - `updateDonationGoal`
  - `updateDonationBar`
  - `startPollingDonationAlerts`
  - `checkForNewDonations`
- Editor:
  - `GoalApi`
  - `normalizeClientSettings`
  - `saveGoal`
  - `connectWebSocket`
  - `applyBarVisualTheme`
  - `applyCustomDesign`
- Widget:
  - `connectWebSocket`
  - `applyBarVisualThemeWidget`
  - `applyPreset`
  - `applyCustomDesign`

---

## 19. Output Format Expected from Future AI Changes

When an AI proposes a change, it should provide:

1. impacted contracts (API/WS/settings),
2. compatibility impact,
3. rollback plan,
4. test evidence for editor + widget + donation ingestion path.

