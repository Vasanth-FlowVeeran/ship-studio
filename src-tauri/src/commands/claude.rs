//! # Claude CLI Integration Commands
//!
//! Commands for checking Claude CLI status and installation.

use crate::commands::setup::is_mock_mode;
use crate::types::ClaudeCliStatus;
use crate::utils::{create_command, get_extended_path};

/// Finds the Claude CLI binary by checking common installation paths.
pub fn find_claude_binary() -> Option<std::path::PathBuf> {
    // First try which
    if let Ok(path) = which::which("claude") {
        return Some(path);
    }

    #[cfg(windows)]
    {
        // On Windows, also try with .exe extension
        if let Ok(path) = which::which("claude.exe") {
            return Some(path);
        }

        // Check Windows-specific paths
        if let Some(home) = dirs::home_dir() {
            let windows_paths = vec![
                home.join("AppData\\Local\\Programs\\Claude\\claude.exe"),
                home.join("AppData\\Local\\Programs\\Claude Code\\claude.exe"),
                home.join(r".local\bin\claude.exe"),
            ];

            for path in windows_paths {
                if path.exists() {
                    return Some(path);
                }
            }
        }

        // Check npm global (uses .cmd wrapper on Windows)
        if let Ok(app_data) = std::env::var("APPDATA") {
            let npm_paths = vec![
                std::path::PathBuf::from(&app_data).join("npm\\claude.cmd"),
                std::path::PathBuf::from(&app_data).join("npm\\claude.exe"),
            ];
            for path in npm_paths {
                if path.exists() {
                    return Some(path);
                }
            }
        }

        // Check Program Files
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            let path = std::path::PathBuf::from(&program_files).join("Claude\\claude.exe");
            if path.exists() {
                return Some(path);
            }
        }

        // Check npm prefix on Windows
        if let Ok(output) = create_command("npm")
            .args(["prefix", "-g"])
            .env("PATH", get_extended_path())
            .output()
        {
            if output.status.success() {
                let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let claude_path = std::path::PathBuf::from(&prefix).join("claude.cmd");
                if claude_path.exists() {
                    return Some(claude_path);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        // Check common installation locations (Unix)
        if let Some(home) = dirs::home_dir() {
            let common_paths = vec![
                home.join(".local/bin/claude"), // New official installer location
                home.join(".npm-global/bin/claude"),
                home.join(".nvm/versions/node").join("*").join("bin/claude"), // NVM
                home.join("n/bin/claude"),                                    // n version manager
                std::path::PathBuf::from("/usr/local/bin/claude"),
                std::path::PathBuf::from("/opt/homebrew/bin/claude"),
            ];

            for path in common_paths {
                if path.exists() {
                    return Some(path);
                }
            }

            // Check Claude desktop app's bundled CLI (~/Library/Application Support/Claude/claude-code/{version}/claude)
            let claude_app_base = home.join("Library/Application Support/Claude/claude-code");
            if claude_app_base.exists() {
                if let Ok(entries) = std::fs::read_dir(&claude_app_base) {
                    // Find the latest version directory
                    let mut versions: Vec<_> =
                        entries.flatten().filter(|e| e.path().is_dir()).collect();
                    // Sort by semantic version (descending) to get latest first
                    // Parse version components numerically to avoid lexicographic issues (e.g., v2.9.0 vs v2.10.0)
                    versions.sort_by_key(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let parts: Vec<u64> = name
                            .trim_start_matches('v')
                            .split('.')
                            .map(|p| p.parse().unwrap_or(0))
                            .collect();
                        std::cmp::Reverse(parts)
                    });

                    for entry in versions {
                        let claude_path = entry.path().join("claude");
                        if claude_path.exists() {
                            return Some(claude_path);
                        }
                    }
                }
            }

            // Check npm prefix
            if let Ok(output) = create_command("npm")
                .args(["prefix", "-g"])
                .env("PATH", get_extended_path())
                .output()
            {
                if output.status.success() {
                    let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let claude_path = std::path::PathBuf::from(&prefix).join("bin/claude");
                    if claude_path.exists() {
                        return Some(claude_path);
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub async fn check_claude_cli_status() -> ClaudeCliStatus {
    // Check if claude CLI is installed
    let claude_path = match find_claude_binary() {
        Some(path) => path,
        None => {
            return ClaudeCliStatus {
                installed: false,
                version: None,
            };
        }
    };

    // Get version
    let version = create_command(&claude_path)
        .args(["--version"])
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        });

    ClaudeCliStatus {
        installed: true,
        version,
    }
}

#[tauri::command]
pub async fn install_claude_cli() -> Result<(), String> {
    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        crate::commands::setup::mock_install("claude");
        return Ok(());
    }

    #[cfg(windows)]
    {
        // On Windows, Claude Code requires manual installer download
        // We return an error that will prompt the user to download manually
        return Err(
            "Please download Claude Code from https://claude.ai and run the installer.".to_string(),
        );
    }

    #[cfg(not(windows))]
    {
        // Install Claude Code via official installer script (Unix)
        let output = create_command("bash")
            .args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"])
            .env("PATH", get_extended_path())
            .output()
            .map_err(|e| format!("Failed to run installer: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to install Claude Code: {}", stderr));
        }

        Ok(())
    }
}
