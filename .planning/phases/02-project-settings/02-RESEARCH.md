# Phase 2: Project Settings - Research

**Researched:** 2026-02-28
**Domain:** Tauri/React modal UI, project metadata persistence, dev server lifecycle
**Confidence:** HIGH

## Summary

Phase 2 wires the settings cog button (added in Phase 1 as a no-op placeholder) to a new "Project Settings" modal. The modal contains a single field: Dev Server Port. The value persists to `.shipstudio/project.json` and, on save, triggers a dev server restart on the new port.

This is an in-codebase integration task, not a greenfield build. All primitives already exist: modal patterns (CSS + component structure), project metadata read/write (Rust backend + frontend invoke wrappers), dev server restart logic (useDevServer hook), and port state management (useProjectLifecycle hook). The work is connecting these pieces with a new modal component and a new `dev_server_port` field on `ProjectMetadata`.

**Primary recommendation:** Create a `ProjectSettingsModal` component using existing modal-overlay + settings-modal CSS patterns. Add a `dev_server_port` field to `ProjectMetadata` (Rust struct). Wire the save action to persist via `write_project_metadata`, update `devServerPort` state, and trigger `handleRestartDevServer`. Load the saved port on project open in `handleSelectProject`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SETS-01 | Clicking the settings cog opens a Project Settings modal dialog | Phase 1 placed two settings cog buttons with no-op onClick in `WorkspaceView.tsx` (lines ~597, ~617). Replace no-op with state setter to show the modal. Render modal in `WorkspaceModals.tsx`. |
| SETS-02 | Project Settings modal contains a Dev Server Port input field | New `ProjectSettingsModal` component with a numeric input. Follow existing `settings-modal` CSS class from `src/styles/settings.css`. |
| SETS-03 | Dev server port defaults to 3000 when no value is configured | `PREFERRED_DEV_SERVER_PORT = 3000` constant already exists in `useProjectLifecycle.ts` (line 34). Backend `ProjectMetadata.dev_server_port` should be `Option<u16>`, defaulting to `None`. Frontend falls back to 3000 when `None`. |
| SETS-04 | Port setting is persisted in `.shipstudio/project.json` per-project | Add `dev_server_port: Option<u16>` to `ProjectMetadata` struct in `src-tauri/src/types.rs`. Use existing `read_project_metadata`/`write_project_metadata` Tauri commands. Bump `PROJECT_METADATA_SCHEMA_VERSION` to 2 (currently 1). |
| SETS-05 | Changing port restarts the dev server on the new port | Call `setDevServerPort(newPort)` then `handleRestartDevServer()` after saving. The `handleRestartDevServer` in `useDevServer.ts` already reads `devServerPort` from its closure and passes it to `startDevServer`. |
| SETS-06 | Port change only affects Ship Studio's dev server, not project source code | Port is stored in `.shipstudio/project.json` (gitignored). `startDevServer` in `src/lib/project.ts` passes port as a `PORT` env var and `--port` flag — never modifies project files. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | (existing) | Modal component UI | Already used for all components |
| Tauri invoke | (existing) | Frontend-to-backend IPC for metadata read/write | Standard Tauri pattern used throughout |
| serde_json | (existing) | Serialize/deserialize `ProjectMetadata` | Already used for `.shipstudio/project.json` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None | - | - | No new dependencies needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom `set_dev_server_port` Tauri command | Generic `write_project_metadata` | write_project_metadata already exists and handles the full struct. A dedicated command would add unnecessary surface area. Use the generic one. |
| Inline port field in toolbar | Modal dialog | User decision: modal. Inline would be cramped and inconsistent with future settings. |

**Installation:**
```bash
# No new packages needed
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── components/
│   ├── ProjectSettingsModal.tsx    # NEW — modal with port input
│   ├── WorkspaceView.tsx           # MODIFY — wire cog onClick
│   └── WorkspaceModals.tsx         # MODIFY — render ProjectSettingsModal
├── hooks/
│   └── useProjectLifecycle.ts      # MODIFY — load saved port on project open
├── lib/
│   └── project.ts                  # MODIFY — add get/set devServerPort helpers (optional, could use read/write_project_metadata directly)
src-tauri/
├── src/
│   └── types.rs                    # MODIFY — add dev_server_port field to ProjectMetadata
```

### Pattern 1: Modal Component (following existing SettingsModal pattern)
**What:** A centered overlay modal using `modal-overlay` + `settings-modal` CSS classes
**When to use:** For project-scoped settings that don't need inline editing
**Example:**
```tsx
// Source: src/components/SettingsModal.tsx (existing pattern)
function ProjectSettingsModal({ isOpen, onClose, currentPort, onSave }: Props) {
  const [port, setPort] = useState(currentPort);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h2>Project Settings</h2>
          <button className="plugins-close-btn" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="settings-modal-body">
          {/* port input here */}
        </div>
      </div>
    </div>
  );
}
```

### Pattern 2: Metadata Persistence (following existing get/set custom_dev_command pattern)
**What:** Read-modify-write cycle on `.shipstudio/project.json`
**When to use:** For per-project settings
**Example:**
```rust
// Source: src-tauri/src/commands/projects/metadata.rs (existing pattern)
// get_custom_dev_command / set_custom_dev_command already does exactly this pattern.
// dev_server_port follows the same read-modify-write pattern on ProjectMetadata.
```

### Pattern 3: Dev Server Restart After Port Change
**What:** Update port state, then trigger restart
**When to use:** When the user saves a new port value
**Example:**
```tsx
// In the save handler:
const handleSavePort = async (newPort: number) => {
  // 1. Persist to project.json via backend
  // 2. Update React state: setDevServerPort(newPort)
  // 3. Trigger restart: handleRestartDevServer()
};
```

### Anti-Patterns to Avoid
- **Writing port to package.json or vite.config**: The port setting is Ship Studio-only. It must never modify project source files (SETS-06).
- **Bypassing metadata read-modify-write**: Don't write partial JSON. Always read existing metadata, modify the field, then write the full struct back. The existing helpers do this correctly.
- **Hardcoding port 3000 in new code**: Use the persisted value from project.json, falling back to `PREFERRED_DEV_SERVER_PORT` constant.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Modal overlay | Custom overlay div/CSS | Existing `modal-overlay` CSS class | Already handles backdrop, centering, z-index |
| Modal body | Custom card styling | Existing `settings-modal` CSS class | Already has border, radius, background, header pattern |
| Metadata persistence | Custom JSON file I/O | Existing `read_project_metadata`/`write_project_metadata` commands | Already handles schema versioning, directory creation, migration |
| Dev server restart | Custom process kill/start | Existing `handleRestartDevServer` from `useDevServer` hook | Already handles timeout, PTY cleanup, static server vs npm |
| Port validation | Complex regex/parser | Simple numeric range check (1-65535) | Port is a u16, just validate the range |

**Key insight:** Every building block for this feature already exists in the codebase. The work is glue code: a new component, a new struct field, and wiring them to existing handlers.

## Common Pitfalls

### Pitfall 1: State Synchronization Between Port Save and Restart
**What goes wrong:** Saving a new port and immediately calling `handleRestartDevServer()` — but the restart reads `devServerPort` from the `useDevServer` hook's closure, which still has the old value because `setDevServerPort` hasn't triggered a re-render yet.
**Why it happens:** React state updates are asynchronous. `setDevServerPort(newPort)` schedules an update but doesn't apply immediately.
**How to avoid:** Either:
- (a) Pass the new port explicitly to the restart function (requires modifying `handleRestartDevServer` to accept an optional port override), OR
- (b) Restructure so the restart is triggered by a `useEffect` that watches `devServerPort` changes (risky — could restart on other port changes like static server), OR
- (c) Have the save handler call `setDevServerPort` and then defer restart to the next tick with a small timeout or callback pattern.

Option (a) is the cleanest. `handleRestartDevServer` in `useDevServer.ts` already uses `devServerPort` from its closure. Adding an optional `portOverride` parameter is minimal and explicit.
**Warning signs:** Dev server restarts on the old port after user saves a new port.

### Pitfall 2: Port Not Loaded on Project Open
**What goes wrong:** User saves port 5173, reopens project, but dev server starts on 3000.
**Why it happens:** `handleSelectProject` in `useProjectLifecycle.ts` currently finds an available port starting from `PREFERRED_DEV_SERVER_PORT = 3000` and uses that. It doesn't read the saved port from project.json.
**How to avoid:** During project open (in `handleSelectProject`), read `dev_server_port` from project metadata BEFORE the port reservation step. Use the saved port as the preferred port for `findAndReservePort()`, falling back to 3000 if unset. This is straightforward — the metadata read infrastructure already exists.
**Warning signs:** Saved port is ignored on app restart.

### Pitfall 3: Port Already in Use
**What goes wrong:** User sets port 8080, but another process is already using it.
**Why it happens:** The saved port is a preference, not a reservation.
**How to avoid:** `findAndReservePort` already handles this — it takes a preferred port and finds the next available one. If the saved port is unavailable, the system will use the next available port and `setDevServerPort` will reflect the actual port used. Consider showing a toast if the saved port wasn't available.
**Warning signs:** Silent fallback to a different port with no user notification.

### Pitfall 4: Schema Migration Not Bumped
**What goes wrong:** Adding `dev_server_port` to `ProjectMetadata` without bumping `PROJECT_METADATA_SCHEMA_VERSION` means existing project.json files won't trigger migration.
**Why it happens:** Forgetting the schema version bump.
**How to avoid:** Increment `PROJECT_METADATA_SCHEMA_VERSION` to 2 in `types.rs`. The field is `Option<u16>` with `skip_serializing_if = "Option::is_none"` and `#[serde(default)]`, so existing files will deserialize fine (default `None`). The version bump is still good practice for tracking.
**Warning signs:** N/A — actually, since the field is `Option` with default, this won't cause deserialization failures. But the version bump is still correct practice.

### Pitfall 5: Port Input Validation Edge Cases
**What goes wrong:** User enters 0, negative numbers, decimals, or values > 65535.
**Why it happens:** HTML number inputs allow all numeric values.
**How to avoid:** Validate on save: port must be an integer between 1 and 65535. Use `min`/`max` attributes on the `<input type="number">`. Block save if invalid and show inline error.
**Warning signs:** Backend receives invalid port, dev server fails to start.

## Code Examples

Verified patterns from the existing codebase:

### Modal with Close Button (existing pattern)
```tsx
// Source: src/components/SettingsModal.tsx
<div className="modal-overlay" onClick={onClose}>
  <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
    <div className="settings-modal-header">
      <h2>Project Settings</h2>
      <button className="plugins-close-btn" onClick={onClose}>
        <CloseIcon size={16} />
      </button>
    </div>
    <div className="settings-modal-body">
      <div className="settings-section">
        {/* content */}
      </div>
    </div>
  </div>
</div>
```

### Input Field (following DevCommandModal pattern)
```tsx
// Source: src/components/DevCommandModal.tsx
<input
  type="number"
  value={port}
  onChange={(e) => setPort(Number(e.target.value))}
  min={1}
  max={65535}
  style={{
    width: '100%',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  }}
/>
```

### Metadata Field Addition (existing pattern in types.rs)
```rust
// Source: src-tauri/src/types.rs — ProjectMetadata struct
// Follow the exact same pattern as custom_dev_command:
#[serde(skip_serializing_if = "Option::is_none")]
pub dev_server_port: Option<u16>,
```

### Wiring Settings Cog (replacing Phase 1 placeholder)
```tsx
// Source: src/components/WorkspaceView.tsx lines ~597, ~617
// Phase 1 placeholder:
onClick={() => { /* Phase 2 will wire to settings modal */ }}
// Phase 2 replacement:
onClick={() => openProjectSettingsModal()}
```

### Read Metadata on Project Open
```tsx
// Source: src/hooks/useProjectLifecycle.ts handleSelectProject
// After existing Step 5 (fetch auto-accept mode), add:
let savedPort = PREFERRED_DEV_SERVER_PORT;
try {
  const metadata = await invoke<ProjectMetadata | null>('read_project_metadata', { projectPath: project.path });
  if (metadata?.dev_server_port) {
    savedPort = metadata.dev_server_port;
  }
} catch {
  // Fall back to default
}
// Use savedPort as preferred port for findAndReservePort
```

### Save Footer Buttons (following DevCommandModal pattern)
```tsx
// Source: src/components/DevCommandModal.tsx
<div className="notification-settings-footer">
  <button className="notification-settings-cancel" onClick={onClose}>
    Cancel
  </button>
  <button className="notification-settings-save" onClick={handleSave}>
    Save
  </button>
</div>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded port 3000 everywhere | `findAndReservePort` with preferred port | Already in codebase | Multi-window support, prevents port conflicts |
| No per-project settings | `ProjectMetadata` in `.shipstudio/project.json` | Already in codebase | Extensible settings storage per-project |

**Deprecated/outdated:**
- None — this is internal application code, not a library upgrade.

## Open Questions

1. **Should save+restart be one button or two?**
   - What we know: Requirements say "Saving a port value persists it" and "After saving, the dev server restarts." This implies a single Save action does both.
   - What's unclear: Whether users might want to save without restarting (unlikely for a single setting).
   - Recommendation: Single "Save" button that persists AND restarts. This matches the requirements literally.

2. **Should we add a dedicated `get_dev_server_port` / `set_dev_server_port` backend command, or use generic metadata read/write?**
   - What we know: The codebase has both patterns — dedicated commands (e.g., `get_custom_dev_command`) and generic (`read_project_metadata` / `write_project_metadata`).
   - What's unclear: Whether the planner prefers consistency with the dedicated pattern or minimalism.
   - Recommendation: Add dedicated `get_dev_server_port` / `set_dev_server_port` backend commands for consistency with the existing pattern (matches `get_custom_dev_command`, `get_auto_accept_mode`, etc.). This also keeps the frontend simple — one invoke call vs. read-modify-write.

3. **Should the port change be reflected immediately in the Preview component, or only after dev server restart completes?**
   - What we know: The Preview component's `key` includes `devServerPort`, so changing `devServerPort` will unmount/remount the Preview. The Preview starts health-checking against the new port immediately.
   - What's unclear: Whether the Preview should show a loading state while the dev server restarts.
   - Recommendation: `setDevServerPort(newPort)` will cause the Preview to remount and start polling the new port. The existing retry logic in `usePreviewConnection` will handle the gap while the server restarts. No additional work needed.

## Sources

### Primary (HIGH confidence)
- `src/components/SettingsModal.tsx` — existing app-level settings modal pattern (CSS class, layout, close button)
- `src/components/DevCommandModal.tsx` — existing project-level command modal with input + save/cancel
- `src/components/WorkspaceModals.tsx` — modal rendering container, prop pattern for adding new modals
- `src/hooks/useDevServer.ts` — dev server port state, restart logic, custom command save pattern
- `src/hooks/useProjectLifecycle.ts` — project open flow, port reservation, auto-accept mode load pattern
- `src/lib/project.ts` — `startDevServer()` function, port parameter, env var passing
- `src-tauri/src/types.rs` — `ProjectMetadata` struct definition, schema version, serde annotations
- `src-tauri/src/commands/projects/metadata.rs` — `read_project_metadata`, `write_project_metadata`, `get_custom_dev_command`, `set_custom_dev_command`
- `src/styles/settings.css` — CSS classes for settings modal
- `src/styles/modal.css` — CSS for `.modal-overlay`

### Secondary (MEDIUM confidence)
- None needed — all evidence is from the existing codebase.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all existing codebase patterns
- Architecture: HIGH — follows exact patterns from `SettingsModal`, `DevCommandModal`, `custom_dev_command`
- Pitfalls: HIGH — identified from reading actual code flow in `useDevServer.ts` and `useProjectLifecycle.ts`

**Research date:** 2026-02-28
**Valid until:** 2026-03-30 (stable — internal application code, no external API changes)
