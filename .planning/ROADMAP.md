# Roadmap: Ship Studio — Project Settings & Toolbar Cleanup

## Overview

Two phases deliver a clean toolbar and functional per-project settings. Phase 1 strips the restart button to icon-only and adds the settings cog entry point. Phase 2 builds the modal, port field, persistence, and dev server restart behavior behind that entry point.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Toolbar Cleanup** - Strip restart button to icon-only and add settings cog (completed 2026-02-28)
- [ ] **Phase 2: Project Settings** - Modal with port field, persistence, and dev server restart

## Phase Details

### Phase 1: Toolbar Cleanup
**Goal**: The workspace toolbar is visually clean with a settings entry point
**Depends on**: Nothing (first phase)
**Requirements**: TOOL-01, TOOL-02
**Success Criteria** (what must be TRUE):
  1. The Restart Server button shows only the refresh icon with no text label visible
  2. A settings cog icon button appears next to the restart button in the toolbar
  3. The settings cog button follows the existing `.toolbar-icon-btn` visual style
**Plans**: 1 plan
- [ ] 01-01-PLAN.md — Icon-only restart button and settings cog in terminal toolbar

### Phase 2: Project Settings
**Goal**: Users can open a settings modal and configure their dev server port per-project
**Depends on**: Phase 1
**Requirements**: SETS-01, SETS-02, SETS-03, SETS-04, SETS-05, SETS-06
**Success Criteria** (what must be TRUE):
  1. Clicking the settings cog opens a centered modal dialog labeled "Project Settings"
  2. The modal contains a Dev Server Port input field pre-populated with the current value (or 3000 if unset)
  3. Saving a port value persists it to `.shipstudio/project.json` and survives app restart
  4. After saving, the dev server restarts and the preview connects on the new port
  5. No project source files are modified when changing the port setting
**Plans**: 2 plans
- [ ] 02-01-PLAN.md — Backend data layer (ProjectMetadata field, Tauri commands) and ProjectSettingsModal component
- [ ] 02-02-PLAN.md — Wire settings cog, thread props, load saved port, restart dev server on save

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Toolbar Cleanup | 0/1 | Complete    | 2026-02-28 |
| 2. Project Settings | 0/2 | Not started | - |
