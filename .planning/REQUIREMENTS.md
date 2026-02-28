# Requirements: Ship Studio — Project Settings & Toolbar Cleanup

**Defined:** 2026-02-28
**Core Value:** Developers can configure their dev server port per-project so Ship Studio works correctly regardless of which port their framework uses.

## v1 Requirements

### Toolbar

- [x] **TOOL-01**: Restart Server button displays only a refresh icon with no text label
- [x] **TOOL-02**: Settings cog icon button appears next to the restart button in the toolbar

### Project Settings

- [ ] **SETS-01**: Clicking the settings cog opens a Project Settings modal dialog
- [x] **SETS-02**: Project Settings modal contains a Dev Server Port input field
- [x] **SETS-03**: Dev server port defaults to 3000 when no value is configured
- [x] **SETS-04**: Port setting is persisted in `.shipstudio/project.json` per-project
- [ ] **SETS-05**: Changing port restarts the dev server on the new port
- [ ] **SETS-06**: Port change only affects Ship Studio's dev server, not project source code

## v2 Requirements

(None — focused scope)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Modifying project framework config files | Port is Ship Studio-only, not project source |
| Global/app-level settings | This is per-project only |
| Other project settings beyond port | Future milestone |
| Settings search or categories | Only one setting for now |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TOOL-01 | Phase 1 | Complete |
| TOOL-02 | Phase 1 | Complete |
| SETS-01 | Phase 2 | Pending |
| SETS-02 | Phase 2 | Complete |
| SETS-03 | Phase 2 | Complete |
| SETS-04 | Phase 2 | Complete |
| SETS-05 | Phase 2 | Pending |
| SETS-06 | Phase 2 | Pending |

**Coverage:**
- v1 requirements: 8 total
- Mapped to phases: 8
- Unmapped: 0

---
*Requirements defined: 2026-02-28*
*Last updated: 2026-02-28 after roadmap creation*
