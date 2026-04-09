# Ship Studio Development Guidelines

## Feature Overview

Ship Studio is a desktop app for web developers that provides:
- **Project Management** - Create new projects or import existing repos from GitHub
- **Terminal with Claude Code** - Integrated terminal with Claude AI for code assistance
- **Branch Management** - Create, switch, and manage git branches
- **Pull Request Creation** - Submit PRs with AI-generated titles and descriptions
- **Merge Conflict Resolution** - Visual UI for resolving git merge conflicts
- **Asset Management** - Upload, view, and delete files in `/public` folder
- **IDE Integration** - Open projects in VS Code or Cursor with one click
- **Vercel Deployment** - Publish to staging/production via Vercel integration
- **Auto-Updates** - Automatic update detection and installation

## Core Principles

### Never Assume Data
- **Only display data that is reliably known** - never construct, guess, or infer values
- If data isn't available, either:
  1. Don't show that field at all
  2. Show a clear "unknown" or neutral state
  3. Redesign the UI to not need that data
- Example: Don't construct URLs like `https://{project-name}.vercel.app` - only show URLs that were explicitly returned from an API or saved from a real operation
- This prevents confusing users with incorrect information

### Data Storage
- Project metadata is stored in `.shipstudio/project.json` within each project
- This file stores: last_opened timestamp, publish records (staging/production with URL, state, publishedAt)
- Vercel project linking info is in `.vercel/project.json` (managed by Vercel CLI)
- Only trust data that was explicitly saved - don't infer state from file existence alone

## Architecture

### Backend (Rust/Tauri)
- Commands are organized in `src-tauri/src/commands/` by domain (git, vercel, github, etc.)
- Command registration is in `src-tauri/src/lib.rs`
- Commands validate paths to ensure they're within `~/ShipStudio` directory
- Git operations use the `git` CLI with TTL-based caching (`src-tauri/src/cache.rs`)
- Vercel operations use the `vercel` CLI
- Structured logging via `tracing` crate, logs stored at `~/Library/Logs/ShipStudio/`

#### Command Modules
All 14 command modules in `src-tauri/src/commands/`:
- `ai.rs` - AI-powered PR title/description generation via Claude CLI
- `assets.rs` - File management for `/public` folder (list, upload, delete)
- `claude.rs` - Claude Code binary detection and version checking
- `conflicts.rs` - Merge conflict detection, parsing, and resolution
- `env.rs` - Environment variable management
- `git.rs` - Git operations (status, branches, commits, diffs, stash)
- `github.rs` - GitHub CLI integration (auth status, push, remote management)
- `ide.rs` - VS Code/Cursor detection and project opening
- `projects.rs` - Project CRUD operations and metadata management
- `pty.rs` - Pseudo-terminal spawning for embedded Claude Code terminal
- `publishing.rs` - Vercel deployment workflow and publish record tracking
- `pull_requests.rs` - PR listing and creation via `gh` CLI
- `setup.rs` - First-run setup, onboarding, and integration checks
- `vercel.rs` - Vercel CLI integration (auth, project linking, domains)

### AI Features
- PR title/description generation using Claude CLI (`src-tauri/src/commands/ai.rs`)
- Frontend wrapper in `src/lib/ai.ts`
- Uses `find_claude_binary()` to locate Claude Code installation
- Gathers git diff, commit messages, branch name, and diff stats as context
- Implements 40KB max diff limit with intelligent truncation at newline boundaries
- Prompts Claude to respond in structured format (`TITLE:` / `DESCRIPTION:`)

### Frontend (React/TypeScript)
- Components are in `src/components/`
- Lib functions (Tauri invoke wrappers) are in `src/lib/`
- Main app state is managed in `src/App.tsx`
- Polling uses exponential backoff (`src/lib/polling.ts`)
- Structured logging via `src/lib/logger.ts`

#### Frontend Libraries
Key modules in `src/lib/`:
- `ai.ts` - AI generation wrapper for PR descriptions
- `assets.ts` - Asset management (list, upload, delete public files)
- `branches.ts` - Branch operations and PR status management
- `claude.ts` - Claude Code detection and availability checking
- `conflicts.ts` - Conflict resolution operations
- `fonts.ts` - Font loading utilities for the terminal
- `git.ts` - Git operations wrapper (status, commits, branches)
- `github.ts` - GitHub operations (auth, push, clone)
- `logger.ts` - Structured frontend logging
- `polling.ts` - Exponential backoff utilities for async operations
- `project.ts` - Project metadata and file operations
- `setup.ts` - Setup wizard and integration status
- `updater.ts` - Auto-update functionality and version checking
- `vercel.ts` - Vercel deployment operations

## Testing

### Frontend Tests (Vitest + React Testing Library)
```bash
npm test          # Run all tests
npm run test:ui   # Run with Vitest UI
```

Tests are in `src/**/*.test.{ts,tsx}`. Uses official `@tauri-apps/api/mocks` for mocking Tauri IPC.

### Backend Tests (Rust)
```bash
cd src-tauri && cargo test
```

Unit tests are colocated in source files using `#[cfg(test)]` modules.

### Onboarding / Setup Wizard Testing

Onboarding is critical — it's the first thing every new user sees. There are two ways to test it:

#### 1. Real Mode: `SHIPSTUDIO_FORCE_ONBOARDING=1` (recommended for UI/flow testing)

```bash
SHIPSTUDIO_FORCE_ONBOARDING=1 pnpm tauri dev
```

This forces the onboarding wizard to appear but runs **real system checks**. Items show their actual status on your machine (homebrew, node, git, etc. will show as "ready" with real versions). Terminal-based installs and auth flows work normally.

How it works:
- `quick_setup_check` returns `setup_complete_cached: false` → app shows onboarding
- `get_full_setup_status` returns `all_ready: false` → onboarding stays open
- All individual item checks are real (versions, auth status, etc.)
- `mark_setup_complete` sets an in-memory flag instead of writing to disk
- After completing onboarding, background verification sees real `all_ready: true` → no redirect loop
- Next launch with the env var: onboarding shows again (nothing persisted)

Since your dev machine likely has everything installed, the wizard will auto-advance to the celebration screen. This is correct behavior — it validates the auto-advance logic works.

#### 2. Mock Mode: `SHIPSTUDIO_FORCE_SETUP=<scenario>` (for testing specific states)

```bash
SHIPSTUDIO_FORCE_SETUP=fresh pnpm tauri dev        # Nothing installed (step 1)
SHIPSTUDIO_FORCE_SETUP=auth-only pnpm tauri dev     # Tools installed, no auth (step 2/3)
SHIPSTUDIO_FORCE_SETUP=almost-done pnpm tauri dev   # Only gh_auth missing (step 2)
SHIPSTUDIO_FORCE_SETUP=both-agents pnpm tauri dev   # Everything ready → celebration
SHIPSTUDIO_FORCE_SETUP=codex-only pnpm tauri dev    # Only Codex, no Claude
SHIPSTUDIO_FORCE_SETUP=homebrew,node,git,gh,gh_auth pnpm tauri dev  # Custom: step 3
```

This uses a **mock backend** — item statuses are faked. Clicking "Install" simulates a 2-second install. However, **terminal-based items (homebrew, gh_auth, claude, codex) spawn real processes** that will fail or do unexpected things since they run against your actual system, not the mock.

**When to use which:**
| Scenario | Use |
|----------|-----|
| Testing wizard UI flow and navigation | `SHIPSTUDIO_FORCE_ONBOARDING=1` |
| Testing specific incomplete states | `SHIPSTUDIO_FORCE_SETUP=<scenario>` |
| Testing on a fresh machine (real installs) | No env var needed — onboarding shows automatically |

#### 3. Testing on a Fresh Machine (Real End-to-End)

This is the gold standard test. On a clean macOS install (or a VM):

1. Install Xcode CLI tools: `xcode-select --install`
2. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
3. Install the app (DMG or `pnpm tauri dev`)
4. Walk through every wizard step — verify each install/connect actually works
5. Verify the wizard auto-advances past pre-existing tools
6. Verify celebration screen appears and app loads correctly

**Checklist for fresh machine testing:**

- [ ] Step 1: Homebrew installs successfully via terminal
- [ ] Step 1: Node.js installs after homebrew completes
- [ ] Step 1: npm_fix appears only if ~/.npm has permission issues
- [ ] Step 1: "Next" enables only when all step 1 items are ready
- [ ] Step 2: Git and GitHub CLI install (batch install works)
- [ ] Step 2: GitHub auth opens browser and completes
- [ ] Step 3: Claude Code installs via terminal
- [ ] Step 3: Claude auth flow completes
- [ ] Step 3: "Next" enables when at least one agent pair is ready
- [ ] Step 3: If both agents ready, default agent selection appears inline
- [ ] Step 4: "Skip for Now" advances to celebration
- [ ] Celebration: "You're all set!" shows, auto-continues after 2.5s
- [ ] App: Projects view loads correctly after onboarding
- [ ] Re-launch: Onboarding does NOT show again (setup_complete persisted)

#### Wizard Architecture Quick Reference

The wizard has 4 steps defined in `src/lib/setup.ts` (`WIZARD_STEPS`):

| Step | ID | Items | Complete When |
|------|----|-------|---------------|
| 1 | `package-manager` | homebrew, node, npm_fix | All present items ready |
| 2 | `git-github` | git, gh, gh_auth | All 3 ready |
| 3 | `agent` | claude, claude_auth, codex, codex_auth | At least 1 agent pair ready |
| 4 | `hosting` | *(none)* | Always (placeholder, skippable) |

Key files:
- `src/components/setup/OnboardingScreen.tsx` — wizard orchestrator
- `src/components/setup/WizardStepIndicator.tsx` — step dots
- `src/components/setup/steps/` — per-step components
- `src/lib/setup.ts` — step definitions, helpers, backend API
- `src-tauri/src/commands/setup.rs` — backend setup checks, mock/force modes

## Shared CSS Classes (Plugin-Stable)

These classes are defined in `src/styles/base.css` and are part of Ship Studio's public API for plugins. Plugins can use them directly without injecting their own styles. **Do not rename or remove these classes without updating the plugin starter repo.**

| Class | Defined In | Description |
|-------|-----------|-------------|
| `toolbar-icon-btn` | `base.css` | Icon button for the workspace toolbar (32px height, border, rounded corners, hover states). Used by all header action buttons and toolbar plugins. |
| `btn-primary` | `base.css` | Primary action button (accent background, white text) |
| `btn-secondary` | `base.css` | Secondary button (tertiary background, border) |

CSS variables (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--text-muted`, `--border`, `--accent`, `--action`, etc.) are also stable and available to plugins.

## Common Patterns

### Publishing Flow
1. User clicks Publish in PublishDropdown
2. Backend pushes to GitHub (staging or main branch)
3. Vercel auto-deploys via GitHub integration
4. Result (URL, state, timestamp) is saved to `.shipstudio/project.json`

### Pull Request Flow
1. User clicks "Submit for Review" on a branch
2. SubmitReviewModal opens with branch name as default title
3. User can click "Generate with AI" to auto-generate title/description
4. Backend gathers git context (diff, commits, branch name) and calls Claude CLI
5. PR is created via `gh pr create` with the title and description

### Conflict Resolution
- Conflicts detected via `git diff --name-only --diff-filter=U`
- ConflictedFile struct contains parsed conflict blocks with context lines
- User resolves conflicts in UI by choosing "ours" or "theirs" for each block
- Resolution written back to file, then auto-staged when all conflicts resolved
- Complete merge commits with message "Resolved merge conflicts via Ship Studio"

### Integration Status
- GitHub: Check via `gh auth status`
- Vercel: Check via `vercel whoami`
- Claude: Check via `claude --version`

## Known Gotchas

### CSP Must Be Null for Terminal Fonts
The Content Security Policy in `src-tauri/tauri.conf.json` MUST be set to `null`.

**Why:** xterm.js dynamically injects `<style>` elements for font rendering. Even with `style-src 'unsafe-inline'` in the CSP, WebKit/Tauri blocks these styles in production builds. This causes the terminal to fall back to system fonts instead of JetBrains Mono Nerd Font.

**If you change CSP:** Always test terminal font rendering in a production build (`pnpm tauri build`), not just dev mode. Dev mode works fine but production builds will break.

## Releasing New Versions

Use `scripts/release.sh` to automate the release process. The script bumps the version in all 3 files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`), updates `Cargo.lock`, commits, and tags.

### Quick Release

```bash
# Patch bump with release notes (most common)
./scripts/release.sh -n "**Fixed bug X** - Description"

# Multiple notes
./scripts/release.sh -n "**Feature A** - Description" -n "**Fix B** - Description"

# Minor or major bump
./scripts/release.sh minor -n "**New feature** - Description"

# Then push to trigger CI
git push origin main && git push origin vX.Y.Z
```

The `-n` flag automatically adds notes to `RELEASE_NOTES.md`. Without `-n`, you must update `RELEASE_NOTES.md` manually before running the script.

### Dashboard Changelog

**IMPORTANT:** Update the changelog data in `src/components/Changelog.tsx` before each release. This displays "What's New" on the dashboard sidebar. Add the new version at the top of the `CHANGELOG` array with a brief list of user-facing changes.

### What Happens After Push

1. GitHub Actions builds for ARM64 + Intel, signs with Apple Developer ID, and notarizes
2. Uploads artifacts to the private repo as a **draft** release
3. Auto-publishes to the public `ship-studio/releases` repo (updater bundles + DMGs + `latest.json`)
4. **You must manually publish the draft** in the main repo at https://github.com/ship-studio/ship-studio/releases

### Auto-Update Flow

The app checks `latest.json` from the public releases repo. When a newer version is found, `UpdateBanner` shows release notes with a download button. The update is verified using minisign signatures before installing.

### Two-Repo Strategy

- **`ship-studio/ship-studio`** (private) — source code, draft releases
- **`ship-studio/releases`** (public) — update bundles (`.tar.gz` + `.sig`), DMGs, `latest.json`

DMG download links for the marketing site:
- ARM64: `https://github.com/ship-studio/releases/releases/latest/download/ShipStudio_darwin-aarch64.dmg`
- Intel: `https://github.com/ship-studio/releases/releases/latest/download/ShipStudio_darwin-x86_64.dmg`

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (for notarization) |
| `APPLE_API_KEY` | App Store Connect API key ID (for notarization) |
| `APPLE_API_KEY_CONTENT` | Base64-encoded .p8 private key file (for notarization) |
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key for update bundle signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `RELEASES_PAT` | GitHub PAT with `public_repo` scope for cross-repo publishing |

### Windows Builds

Windows releases use a separate workflow triggered by tags ending in `-win` (e.g. `v0.5.0-win`). The macOS workflow excludes these tags, so the two pipelines are independent. Push a `-win` tag to produce a draft Windows release with an NSIS/MSI installer. See `RELEASING.md` for details.

### Local Notarized Build (for testing)

Use `scripts/build-notarized.sh` with the Apple env vars set to build, sign, and notarize locally. See the script for required environment variables.

See `RELEASING.md` for full details.
