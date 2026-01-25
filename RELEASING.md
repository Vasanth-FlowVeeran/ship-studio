# Releasing Ship Studio

## Quick Release (recommended)

1. Update version in all three files:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`

2. Commit the version bump:
   ```bash
   git commit -am "Bump version to X.Y.Z"
   ```

3. Create and push a tag:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z - Brief description"
   git push origin main && git push origin vX.Y.Z
   ```

4. Wait for GitHub Actions to complete (~8 minutes)

5. Publish both draft releases:
   - Main repo: https://github.com/ship-studio/ship-studio/releases
   - Public releases repo: https://github.com/ship-studio/releases/releases

## What Happens Automatically

When you push a tag starting with `v`, GitHub Actions will:

1. **Build** the app for both ARM64 (Apple Silicon) and Intel Macs
2. **Sign** the app with the Apple Developer certificate
3. **Create** signed update bundles (`.tar.gz` + `.sig`)
4. **Generate** `latest.json` manifest with download URLs pointing to the public repo
5. **Upload** artifacts to both:
   - `ship-studio/ship-studio` (private, for reference)
   - `ship-studio/releases` (public, for auto-updater)
6. **Create** draft releases in both repos

## Why Two Repos?

The main `ship-studio/ship-studio` repo is **private** to protect source code. However, the auto-updater needs public URLs to download updates. The `ship-studio/releases` repo is **public** and only contains:

- `latest.json` - Version manifest for auto-updater
- `ShipStudio_darwin-aarch64.app.tar.gz` - ARM64 update bundle
- `ShipStudio_darwin-x86_64.app.tar.gz` - Intel update bundle

No source code is exposed.

## Required Secrets

These secrets must be configured in the main repo's GitHub settings:

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the certificate |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for update signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `RELEASES_PAT` | Personal Access Token with `repo` scope for cross-repo access |

## Verification Checklist

After the workflow completes:

- [ ] Both draft releases exist (main repo and releases repo)
- [ ] Each release has all 3 files (latest.json + 2 tar.gz files)
- [ ] Publish both releases
- [ ] Verify public URL works:
  ```bash
  curl -sL https://github.com/ship-studio/releases/releases/latest/download/latest.json | jq
  ```
- [ ] Test auto-updater shows update available in-app

## Troubleshooting

### Workflow fails at "Create release in public releases repo"

The `RELEASES_PAT` secret may be missing or expired. Create a new Personal Access Token:
1. Go to https://github.com/settings/tokens
2. Generate new token (classic) with `repo` scope
3. Add it as `RELEASES_PAT` in repo secrets

### Auto-updater doesn't find updates

1. Ensure the release in `ship-studio/releases` is **published** (not draft)
2. Check `latest.json` URLs point to the public repo
3. Verify the app version is lower than the release version
