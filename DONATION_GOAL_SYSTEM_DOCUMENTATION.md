# Donation Goal System Documentation

This document is written for another AI/automation agent that needs to understand and safely modify the donation goal system at:

- Editor: `http://localhost:3000/donation-goal.html`
- OBS widget: `http://localhost:3000/widget/donation-goal`

It covers:

1. Architecture and data flow
2. Backend schema and normalization
3. REST API contracts
4. WebSocket events and sync behavior
5. Frontend editor behavior and state model
6. OBS widget rendering logic
7. Integration with donation systems (DonatePay / DonationAlerts)
8. Operational caveats and safe change strategy

---

## 1) High-Level Architecture

The donation goal stack has 3 layers:

- **Ingestion layer** (server-side): receives donor events from DonationAlerts / DonatePay paths.
- **State layer** (SQLite + normalization): stores canonical donation goal/bar state and versioned widget settings.
- **Presentation layer**:
  - Editor (`public/donation-goal.html`)
  - OBS widget (`public/widget/donation-goal.html`)

When a donation is processed:

1. Donation is persisted in generic donation storage.
2. Goal amount and bar amount are updated.
3. Snapshot for rollback/history may be persisted.
4. WebSocket broadcast pushes real-time updates to editor/widget.

---

## 2) Backend Data Model and Settings Schema

Key tables used by this feature:

- `donation_goals`
  - `title`
  - `target_amount`
  - `current_amount`
  - `total_donations`
  - `avg_donation`
  - `last_donation_time`
  - `settings` (JSON text, versioned/normalized)
- `goal_donations` (history of goal updates)
- `donation_bars`
  - `current_amount`
  - `settings` (JSON text)
- `donation_goal_snapshots` (restore points / safety)

### Settings normalization

Backend uses a normalization pipeline:

- `normalizeDonationWidgetSettings(rawSettings)`
- `encodeDonationWidgetSettings(settings)`

This guarantees old/partial settings are upgraded to a complete schema with defaults.

Important: both goal and bar payloads pass through normalization before sending to clients.

---

## 3) Backend Payload Builders and Broadcast

Main helpers:

- `buildDonationGoalPayload(row)`
- `buildDonationBarPayload(row)`
- `broadcastDonationWidgetState(goalRow, barRow)`
- `persistDonationGoalSnapshot(action, goalRow, cb)`

Broadcast emits real-time events:

- `DONATION_GOAL_UPDATE`
- `DONATION_BAR_UPDATE`

Additionally, settings updates are pushed via:

- `WIDGET_SETTINGS_UPDATE` with `scope: 'donation-goal'` and normalized settings.

---

## 4) REST API Contracts (Donation Goal/Bar)

Primary endpoints:

- `GET /api/donation-goal`
- `PUT /api/donation-goal`
- `POST /api/donation-goal/manual-donation`
- `POST /api/donation-goal/reset`
- `GET /api/donation-goal/history`
- `GET /api/donation-goal/export`
- `POST /api/donation-goal/import`
- `GET /api/donation-goal/snapshots`
- `POST /api/donation-goal/snapshots`
- `POST /api/donation-goal/snapshots/:id/restore`

Bar endpoints:

- `GET /api/donation-bar/state`
- `PUT /api/donation-bar/state`
- `POST /api/donation-bar/add`

### Behavior notes

- `PUT /api/donation-goal` normalizes incoming settings and broadcasts:
  - `DONATION_GOAL_UPDATE`
  - `WIDGET_SETTINGS_UPDATE` (scope `donation-goal`)
- Import route restores both goal and bar state when provided.
- Snapshot restore rehydrates saved goal state and rebroadcasts.

---

## 5) Editor (`public/donation-goal.html`) Runtime Model

Core concepts:

- `goalState` = single source of local UI state
- `GoalApi` = frontend REST wrapper
- `normalizeClientSettings(input)` = client-side normalization

### Real-time and anti-overwrite behavior

- Editor connects to `/ws`.
- Handles:
  - `DONATION_GOAL_UPDATE`
  - `WIDGET_SETTINGS_UPDATE` (scope check)
- While user edits custom design, `customDesignDirty` prevents incoming pushes from overwriting unsaved local style changes.
- Debounced autosave (`customDesignAutosaveTimer`) persists custom design quietly.

### Rendering logic

- `applyBarVisualTheme(...)` is the canonical style renderer for preview.
- Presets and custom config route through this function.
- Fill types include standard + advanced effects; legacy values are mapped where needed.

---

## 6) OBS Widget (`public/widget/donation-goal.html`) Behavior

Core flow:

1. `loadGoalState()` pulls initial state from API.
2. WebSocket `/ws` subscribes to live updates:
   - `DONATION_GOAL_UPDATE`
   - `WIDGET_SETTINGS_UPDATE`
3. `updateDisplay()` updates title, numbers, percentage, fill width.
4. Style is applied via:
   - `applyCustomDesign(...)` or
   - `applyPreset(...)`
   both converging into:
   - `applyBarVisualThemeWidget(...)`

### Profile/media support

- Query parameter `?profile=<id>` is supported.
- `applyProfileOverridesFromSettings()` overlays profile-specific custom design/media.
- `applyWidgetMedia()` supports image/video backgrounds with overlay opacity.

---

## 7) Donation Integrations (DonationAlerts / DonatePay)

## 7.1 DonationAlerts

Server includes OAuth flow:

- Auth start: `/auth/donationalerts`
- Callback: `/oauth/donationalerts/callback`

Token is stored in app state and polling is started once configured.

## 7.2 DonatePay

Supported channels:

- API polling (transactions/events)
- optional realtime path via Centrifugo
- webhook endpoint:
  - `POST /webhook/donatepay`

Server startup attempts DonatePay initialization via `initializeDonatePay()`.

## 7.3 Unified donation processing

Regardless of source, processed donation ultimately updates:

- generic donation records
- donation goal (`updateDonationGoal(donation)`)
- donation bar (`updateDonationBar(donation)`)

Then broadcasts to editor/widget via WebSocket.

---

## 8) End-to-End Update Sequence

Typical donor event:

1. External event ingested (DA/DP poll or webhook/realtime).
2. Donation normalized to internal object (`amount`, `username`, `message`, metadata).
3. `updateDonationGoal` increments:
   - `current_amount`
   - `total_donations`
   - `avg_donation`
4. `updateDonationBar` increments current bar amount.
5. Snapshot persisted (goal path).
6. WS broadcast sends new goal/bar/settings state.
7. Editor + OBS widget repaint.

---

## 9) Performance / Reliability Considerations

- Do not bypass settings normalization on backend.
- Avoid introducing duplicate render engines; use existing:
  - editor: `applyBarVisualTheme`
  - widget: `applyBarVisualThemeWidget`
- If adding new `fillType`, update:
  1. editor select options
  2. editor renderer logic
  3. widget renderer logic
  4. preset mapping
  5. compatibility mapping for legacy values
- Keep websocket event names stable; old widgets depend on them.
- For heavy media fields, avoid resending large payloads every poll unless changed.

---

## 10) Safe Modification Checklist for Another AI

Before changing logic:

1. Confirm current event names and API response keys are unchanged.
2. Preserve normalization in both backend and editor.
3. Keep `customDesignDirty` semantics intact (prevents user edits from being overwritten).
4. Mirror any visual engine changes in both preview and OBS widget.
5. Run lints for touched files.
6. Verify real-time behavior:
   - manual donation
   - settings save
   - import/export
   - snapshot restore

---

## 11) Quick File Map

- Backend core:
  - `server.js`
- Editor:
  - `public/donation-goal.html`
- OBS goal widget:
  - `public/widget/donation-goal.html`
- Legacy redirect page:
  - `public/widget-donation-goal.html`
- Related bar widget:
  - `public/widget-donation-bar.html`

---

## 12) Recommended Test Plan

1. Open editor and OBS widget simultaneously.
2. Change preset and custom design; ensure both update live.
3. Trigger manual donation; verify amount increments and WS update.
4. Reset goal; confirm bar/goal consistency.
5. Export config -> import config; verify full restore.
6. Create snapshot -> modify -> restore snapshot.
7. Validate no overwrite during active custom design editing.

---

If another AI is asked to refactor this system, it should prioritize protocol/schema compatibility and avoid behavioral changes to the WS update contract unless both clients are updated in lockstep.

