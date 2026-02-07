//! # Shared Utilities
//!
//! This module contains shared utility functions used across the Ship Studio backend.

use std::process::Command;

/// Creates a `Command` that won't spawn a visible console window on Windows.
/// On non-Windows platforms, this is identical to `Command::new()`.
pub fn create_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Returns the platform-specific PATH separator (`:` for Unix, `;` for Windows)
fn get_path_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

/// Builds an extended PATH that includes common tool installation locations.
/// macOS apps launched from Finder don't inherit the user's shell PATH,
/// so we need to explicitly add Homebrew, npm global, and NVM paths.
/// On Windows, adds common program installation paths.
pub fn get_extended_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();

    #[cfg(windows)]
    let mut paths: Vec<String> = {
        let mut windows_paths = Vec::new();

        // Add Windows-specific paths
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            windows_paths.push(format!("{}\\Microsoft\\WindowsApps", local_app_data));
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            windows_paths.push(format!("{}\\npm", app_data));
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            windows_paths.push(format!("{}\\Git\\bin", program_files));
            windows_paths.push(format!("{}\\nodejs", program_files));
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            windows_paths.push(format!("{}\\Git\\bin", program_files_x86));
            windows_paths.push(format!("{}\\nodejs", program_files_x86));
        }

        // User-specific paths
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            windows_paths.push(format!("{}\\AppData\\Local\\Programs\\Git\\bin", home_str));
            windows_paths.push(format!("{}\\AppData\\Roaming\\npm", home_str));
            windows_paths.push(format!(r"{}\.local\bin", home_str));
        }

        windows_paths
    };

    #[cfg(not(windows))]
    let mut paths: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(), // Homebrew (Apple Silicon)
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(), // Homebrew (Intel) / manual installs
        "/usr/local/sbin".to_string(),
    ];

    // Add user-specific paths (Unix only, Windows handled above)
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        paths.push(format!("{}/.npm-global/bin", home_str));
        paths.push(format!("{}/.local/bin", home_str)); // Official Claude installer location
        paths.push(format!("{}/n/bin", home_str));

        // Add NVM current/default version if it exists
        // First try the default alias, then fall back to finding the latest version
        let nvm_dir = home.join(".nvm");
        let nvm_default = nvm_dir.join("alias/default");
        let nvm_versions = nvm_dir.join("versions/node");

        if nvm_versions.exists() {
            // Check if there's a default alias
            let default_version = std::fs::read_to_string(&nvm_default)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            if let Some(version) = default_version {
                // Default alias might be "lts/iron" or a version like "v20.10.0"
                // Try to resolve it to an actual path
                let version_path = if version.starts_with("lts/") || version.starts_with("node") {
                    // For lts aliases, we'd need to read more files - just use latest version
                    None
                } else {
                    // Direct version reference
                    let path = nvm_versions.join(&version);
                    if path.exists() {
                        Some(path)
                    } else {
                        None
                    }
                };

                if let Some(path) = version_path {
                    paths.push(format!("{}/bin", path.to_string_lossy()));
                }
            }

            // If no default found or couldn't resolve, find the latest installed version
            if paths.iter().all(|p| !p.contains(".nvm/versions/node")) {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    // Get all version directories and sort to find the latest
                    let mut versions: Vec<_> = entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().is_dir())
                        .collect();

                    // Sort by version (descending) - versions are like "v20.10.0"
                    versions.sort_by(|a, b| {
                        let a_name = a.file_name().to_string_lossy().to_string();
                        let b_name = b.file_name().to_string_lossy().to_string();
                        b_name.cmp(&a_name) // Reverse order for descending
                    });

                    // Use the latest version only
                    if let Some(latest) = versions.first() {
                        paths.push(format!("{}/bin", latest.path().to_string_lossy()));
                    }
                }
            }
        }

        // Add Claude desktop app's bundled CLI paths
        let claude_app_base = home.join("Library/Application Support/Claude/claude-code");
        if claude_app_base.exists() {
            if let Ok(entries) = std::fs::read_dir(&claude_app_base) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        paths.push(entry.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // Append existing PATH
    if !current_path.is_empty() {
        paths.push(current_path);
    }

    paths.join(get_path_separator())
}

/// Finds an executable by checking common installation paths.
/// This is needed because bundled macOS apps don't inherit the user's shell PATH.
/// On Windows, checks standard Program Files and AppData locations.
pub fn find_executable(cmd: &str) -> Option<std::path::PathBuf> {
    // First try which (works in dev and if PATH is set)
    if let Ok(path) = which::which(cmd) {
        return Some(path);
    }

    #[cfg(windows)]
    {
        // On Windows, also try with .exe extension
        let cmd_exe = format!("{}.exe", cmd);
        if let Ok(path) = which::which(&cmd_exe) {
            return Some(path);
        }

        // Check common Windows installation paths
        let mut windows_paths = Vec::new();

        // Program Files paths
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("nodejs")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("Git\\bin")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("GitHub CLI")
                    .join(&cmd_exe),
            );
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            windows_paths.push(
                std::path::PathBuf::from(&program_files_x86)
                    .join("nodejs")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&program_files_x86)
                    .join("Git\\bin")
                    .join(&cmd_exe),
            );
        }

        // User-specific paths
        if let Some(home) = dirs::home_dir() {
            windows_paths.push(
                home.join("AppData\\Local\\Programs\\Git\\bin")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                home.join("AppData\\Local\\Programs")
                    .join(cmd)
                    .join(&cmd_exe),
            );
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            // npm global binaries (uses .cmd wrapper on Windows)
            let cmd_cmd = format!("{}.cmd", cmd);
            windows_paths.push(
                std::path::PathBuf::from(&app_data)
                    .join("npm")
                    .join(&cmd_cmd),
            );
            windows_paths.push(
                std::path::PathBuf::from(&app_data)
                    .join("npm")
                    .join(&cmd_exe),
            );
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            windows_paths.push(
                std::path::PathBuf::from(&local_app_data)
                    .join("Microsoft\\WindowsApps")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join(cmd)
                    .join(&cmd_exe),
            );
        }

        for path in windows_paths {
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(not(windows))]
    {
        // Check common installation paths for macOS/Linux
        let common_paths = vec![
            std::path::PathBuf::from("/opt/homebrew/bin").join(cmd), // Homebrew (Apple Silicon)
            std::path::PathBuf::from("/usr/local/bin").join(cmd),    // Homebrew (Intel) / manual
            std::path::PathBuf::from("/usr/bin").join(cmd),          // System
        ];

        for path in common_paths {
            if path.exists() {
                return Some(path);
            }
        }

        // For npm-installed tools (like claude), check additional locations
        if let Some(home) = dirs::home_dir() {
            let npm_paths = vec![
                home.join(".npm-global/bin").join(cmd),
                home.join("n/bin").join(cmd), // n version manager
            ];

            for path in npm_paths {
                if path.exists() {
                    return Some(path);
                }
            }

            // Check NVM installations (glob for any node version)
            let nvm_base = home.join(".nvm/versions/node");
            if nvm_base.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_base) {
                    for entry in entries.flatten() {
                        let bin_path = entry.path().join("bin").join(cmd);
                        if bin_path.exists() {
                            return Some(bin_path);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Validates that a project path is inside the ~/ShipStudio directory
/// or is a registered external project.
/// Prevents path traversal attacks where frontend could pass arbitrary paths.
pub fn validate_project_path(project_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(project_path);
    let canonical = dunce::canonicalize(path).map_err(|e| format!("Invalid path: {}", e))?;

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    // Allow paths inside ~/ShipStudio
    if canonical.starts_with(&shipstudio_dir) {
        return Ok(canonical);
    }

    // Allow registered external project paths
    if crate::commands::external_projects::is_registered_external_path(&canonical)? {
        return Ok(canonical);
    }

    Err(format!(
        "Security error: path '{}' is outside ShipStudio directory",
        project_path
    ))
}

/// Check if Homebrew is installed
pub fn check_homebrew() -> (bool, Option<String>) {
    let paths = [
        std::path::PathBuf::from("/opt/homebrew/bin/brew"),
        std::path::PathBuf::from("/usr/local/bin/brew"),
    ];

    for path in paths {
        if path.exists() {
            // Get version
            let version = create_command(&path)
                .args(["--version"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let out = String::from_utf8_lossy(&o.stdout);
                        out.lines().next().map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                });
            return (true, version);
        }
    }
    (false, None)
}

/// Get Homebrew command path
pub fn get_brew_command() -> Option<std::path::PathBuf> {
    let paths = [
        std::path::PathBuf::from("/opt/homebrew/bin/brew"),
        std::path::PathBuf::from("/usr/local/bin/brew"),
    ];
    paths.into_iter().find(|p| p.exists())
}

/// Check if Winget is installed (Windows only)
#[cfg(windows)]
pub fn check_winget() -> (bool, Option<String>) {
    if let Ok(path) = which::which("winget") {
        // Get version
        let version = create_command(&path)
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let out = String::from_utf8_lossy(&o.stdout);
                    // Winget version output is like "v1.6.3482" - extract the version
                    out.trim()
                        .strip_prefix('v')
                        .map(|s| format!("v{}", s))
                        .or_else(|| Some(out.trim().to_string()))
                } else {
                    None
                }
            });
        return (true, version);
    }
    (false, None)
}

#[cfg(not(windows))]
pub fn check_winget() -> (bool, Option<String>) {
    (false, None)
}

/// Get Winget command path (Windows only)
#[cfg(windows)]
pub fn get_winget_command() -> Option<std::path::PathBuf> {
    which::which("winget").ok()
}

#[cfg(not(windows))]
pub fn get_winget_command() -> Option<std::path::PathBuf> {
    None
}

/// Helper to format relative time
pub fn format_relative_time(timestamp_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    format_relative_time_from_now(timestamp_ms, now)
}

/// Internal helper for formatting relative time (testable with controlled "now" value)
fn format_relative_time_from_now(timestamp_ms: u64, now_ms: u64) -> String {
    let diff_ms = now_ms.saturating_sub(timestamp_ms);
    let seconds = diff_ms / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;

    if days > 0 {
        format!("{}d ago", days)
    } else if hours > 0 {
        format!("{}h ago", hours)
    } else if minutes > 0 {
        format!("{}m ago", minutes)
    } else {
        "just now".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod format_relative_time {
        use super::*;

        #[test]
        fn test_just_now() {
            let now = 100_000_000u64;
            assert_eq!(format_relative_time_from_now(now, now), "just now");
            assert_eq!(format_relative_time_from_now(now - 30_000, now), "just now"); // 30 seconds ago
            assert_eq!(format_relative_time_from_now(now - 59_000, now), "just now");
            // 59 seconds ago
        }

        #[test]
        fn test_minutes_ago() {
            let now = 100_000_000u64; // Large enough for 59 minutes
            assert_eq!(format_relative_time_from_now(now - 60_000, now), "1m ago"); // 1 minute ago
            assert_eq!(format_relative_time_from_now(now - 120_000, now), "2m ago"); // 2 minutes ago
            assert_eq!(
                format_relative_time_from_now(now - 59 * 60_000, now),
                "59m ago"
            ); // 59 minutes ago
        }

        #[test]
        fn test_hours_ago() {
            let now = 1000000000u64;
            assert_eq!(
                format_relative_time_from_now(now - 60 * 60_000, now),
                "1h ago"
            ); // 1 hour ago
            assert_eq!(
                format_relative_time_from_now(now - 2 * 60 * 60_000, now),
                "2h ago"
            ); // 2 hours ago
            assert_eq!(
                format_relative_time_from_now(now - 23 * 60 * 60_000, now),
                "23h ago"
            ); // 23 hours ago
        }

        #[test]
        fn test_days_ago() {
            let now = 1000000000u64;
            assert_eq!(
                format_relative_time_from_now(now - 24 * 60 * 60_000, now),
                "1d ago"
            ); // 1 day ago
            assert_eq!(
                format_relative_time_from_now(now - 7 * 24 * 60 * 60_000, now),
                "7d ago"
            ); // 7 days ago
        }

        #[test]
        fn test_future_timestamp() {
            let now = 1000000u64;
            // Future timestamps should show "just now" (saturating subtraction)
            assert_eq!(format_relative_time_from_now(now + 60_000, now), "just now");
        }
    }

    mod get_extended_path {
        use super::*;

        #[test]
        fn test_includes_expected_paths() {
            let path = get_extended_path();
            #[cfg(not(windows))]
            {
                assert!(path.contains("/opt/homebrew/bin"));
                assert!(path.contains("/usr/local/bin"));
            }
            #[cfg(windows)]
            {
                // On Windows, should include WindowsApps or npm paths
                assert!(
                    path.contains("WindowsApps") || path.contains("npm") || path.contains("Git")
                );
            }
        }

        #[test]
        fn test_preserves_existing_path() {
            // The extended path should include the current PATH
            let current = std::env::var("PATH").unwrap_or_default();
            if !current.is_empty() {
                let extended = get_extended_path();
                assert!(extended.contains(&current));
            }
        }
    }

    mod find_executable {
        use super::*;

        #[test]
        fn test_finds_git() {
            // Git should be available on most systems
            let result = find_executable("git");
            assert!(result.is_some());
            assert!(result.unwrap().exists());
        }

        #[test]
        fn test_nonexistent_command() {
            let result = find_executable("this-command-definitely-does-not-exist-12345");
            assert!(result.is_none());
        }
    }
}
