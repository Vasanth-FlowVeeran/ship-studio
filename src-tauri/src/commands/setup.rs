//! # Setup/Onboarding Commands
//!
//! Commands for the setup wizard and onboarding flow.
//!
//! ## Testing Modes
//!
//! Two env vars control onboarding testing:
//!
//! ### `SHIPSTUDIO_FORCE_ONBOARDING=1`
//! Forces the onboarding wizard to appear but runs REAL system checks.
//! Items show their actual status. Terminal installs work normally.
//! After completing onboarding, an in-memory flag (`FORCE_ONBOARDING_COMPLETED`)
//! prevents background verification from looping back. Nothing is persisted
//! to disk, so onboarding shows again on next launch.
//!
//! ### `SHIPSTUDIO_FORCE_SETUP=<scenario>`
//! Uses a fully mocked backend. Item statuses are faked based on the scenario.
//! Clicking "Install" triggers a 2-second mock install. Terminal-based items
//! (homebrew, gh_auth, claude, codex) still spawn real processes.
//! Scenarios: `fresh`, `auth-only`, `almost-done`, `both-agents`, `codex-only`,
//! or comma-separated item IDs (e.g. `homebrew,node,git,gh,gh_auth`).

use crate::agent::{get_active_agent, get_agent_by_id, ALL_AGENTS};
use crate::commands::claude::find_binary_by_name;
use crate::commands::github::get_gh_command;
use crate::types::{
    AppState, FullSetupStatus, OptionalAuths, QuickSetupCheck, SetupItemInfo, SetupItemStatus,
};
use crate::utils::{create_command, find_executable, get_brew_command};

#[cfg(windows)]
use crate::utils::{check_winget, get_winget_command};

#[cfg(not(windows))]
use crate::utils::check_homebrew;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ============ App State Persistence ============

/// Get the app state file path
fn get_app_state_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/ShipStudio/app_state.json"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-app-state.json"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ShipStudio/app_state.json"))
            .unwrap_or_else(|| PathBuf::from("C:/temp/ship-studio-app-state.json"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ship-studio/app_state.json"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-app-state.json"))
    }
}

/// Read the persisted app state
pub fn read_app_state() -> AppState {
    let path = get_app_state_path();
    if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        AppState::default()
    }
}

/// Write the app state to disk
pub fn write_app_state(state: &AppState) -> Result<(), String> {
    let path = get_app_state_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app state directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize app state: {}", e))?;

    std::fs::write(&path, json).map_err(|e| format!("Failed to write app state: {}", e))
}

// Mock state for testing - tracks which items have been "installed" in debug mode
lazy_static::lazy_static! {
    static ref MOCK_INSTALLED: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    static ref MOCK_INITIALIZED: Mutex<bool> = Mutex::new(false);
    /// Global registry of spawned auth process PIDs for cleanup
    /// Maps auth type (e.g., "github", "claude") -> OS process ID (PID)
    static ref AUTH_PIDS: Mutex<std::collections::HashMap<String, u32>> = Mutex::new(std::collections::HashMap::new());
    /// Tracks whether onboarding was completed this session in force-onboarding mode.
    /// Once set, stop overriding all_ready so background verification doesn't loop.
    static ref FORCE_ONBOARDING_COMPLETED: Mutex<bool> = Mutex::new(false);
}

/// All setup item IDs in dependency order
const ALL_ITEMS: &[&str] = &[
    "homebrew",
    "node",
    "git",
    "gh",
    "gh_auth",
    "claude",
    "claude_auth",
    "codex",
    "codex_auth",
    "vercel",
    "vercel_auth",
];

/// Tool items (not auth)
const TOOL_ITEMS: &[&str] = &["homebrew", "node", "git", "gh", "claude", "codex", "vercel"];

/// Get items that should be pre-installed for a given scenario
fn get_scenario_items(scenario: &str) -> Vec<&'static str> {
    match scenario {
        // Fresh install - nothing installed (default)
        "1" | "fresh" => vec![],

        // All tools installed, but no auth configured
        "auth-only" => TOOL_ITEMS.to_vec(),

        // Everything except GitHub auth
        "github-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "gh_auth")
            .copied()
            .collect(),

        // Everything except Claude auth
        "claude-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "claude_auth")
            .copied()
            .collect(),

        // Only Homebrew missing (tests dependency blocking)
        "homebrew-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "homebrew")
            .copied()
            .collect(),

        // Almost done - only gh_auth left
        "almost-done" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "gh_auth")
            .copied()
            .collect(),

        // Both agents installed and authed + vercel (tests agent selection screen)
        "both-agents" => ALL_ITEMS.to_vec(),

        // Vercel installed and authed (for testing hosting step)
        "vercel-ready" => vec!["vercel", "vercel_auth"],

        // Only Codex installed (no Claude)
        "codex-only" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "claude" && item != "claude_auth")
            .copied()
            .collect(),

        // Comma-separated list of specific items to pre-install
        // e.g., "homebrew,node,git" or "homebrew,node,git,gh,gh_auth,claude,claude_auth"
        _ => scenario
            .split(',')
            .map(|s| s.trim())
            .filter_map(|s| ALL_ITEMS.iter().find(|&&item| item == s).copied())
            .collect(),
    }
}

/// Initialize mock state from SHIPSTUDIO_FORCE_SETUP env var
fn initialize_mock_state() {
    let mut initialized = MOCK_INITIALIZED.lock().unwrap();
    if *initialized {
        return;
    }
    *initialized = true;

    if let Ok(scenario) = std::env::var("SHIPSTUDIO_FORCE_SETUP") {
        let items = get_scenario_items(&scenario);
        if let Ok(mut set) = MOCK_INSTALLED.lock() {
            for item in items {
                set.insert(item.to_string());
            }
        }
        tracing::info!(scenario = scenario, "Mock mode initialized with scenario");
    }
}

/// Check if we're in mock/debug mode
pub fn is_mock_mode() -> bool {
    let is_mock = std::env::var("SHIPSTUDIO_FORCE_SETUP").is_ok();
    if is_mock {
        initialize_mock_state();
    }
    is_mock
}

/// Check if we're in "force onboarding" mode.
/// Unlike mock mode, this runs REAL system checks but forces the onboarding
/// screen to appear so you can test the wizard flow on a fully set up machine.
/// Once onboarding completes this session, stops overriding so background
/// verification doesn't loop back.
///
/// Usage: SHIPSTUDIO_FORCE_ONBOARDING=1 npm run tauri dev
fn is_force_onboarding_mode() -> bool {
    if std::env::var("SHIPSTUDIO_FORCE_ONBOARDING").is_err() {
        return false;
    }
    // Once onboarding completed this session, stop forcing
    FORCE_ONBOARDING_COMPLETED
        .lock()
        .map(|completed| !*completed)
        .unwrap_or(false)
}

/// Mark an item as mock-installed (for testing)
pub fn mock_install(item_id: &str) {
    if let Ok(mut set) = MOCK_INSTALLED.lock() {
        set.insert(item_id.to_string());
    }
}

/// Check if an item is mock-installed
fn is_mock_installed(item_id: &str) -> bool {
    MOCK_INSTALLED
        .lock()
        .map(|set| set.contains(item_id))
        .unwrap_or(false)
}

/// Get full setup status for all items
#[tauri::command]
pub async fn get_full_setup_status() -> FullSetupStatus {
    // Debug/mock mode: return mock state for testing onboarding flow
    if is_mock_mode() {
        let items = vec![
            ("homebrew", "Package Manager", None),
            ("node", "Node.js", Some("homebrew")),
            ("git", "Git", Some("homebrew")),
            ("gh", "GitHub CLI", Some("homebrew")),
            ("gh_auth", "GitHub Account", Some("gh")),
            ("claude", "Claude Code", None),
            ("claude_auth", "Claude Account", Some("claude")),
            ("codex", "Codex", None),
            ("codex_auth", "Codex Account", Some("codex")),
            ("vercel", "Vercel CLI", None),
            ("vercel_auth", "Vercel Account", Some("vercel")),
        ];

        let mock_items: Vec<SetupItemInfo> = items
            .iter()
            .map(|(id, name, dep)| {
                let is_ready = is_mock_installed(id);
                let dep_ready = dep.map(is_mock_installed).unwrap_or(true);
                let is_auth = id.ends_with("_auth");

                SetupItemInfo {
                    id: id.to_string(),
                    friendly_name: name.to_string(),
                    status: if is_ready {
                        SetupItemStatus::Ready
                    } else if !dep_ready {
                        SetupItemStatus::NotInstalled
                    } else if is_auth {
                        SetupItemStatus::NotAuthenticated
                    } else {
                        SetupItemStatus::NotInstalled
                    },
                    version: if is_ready && !is_auth {
                        Some("mock-1.0.0".to_string())
                    } else {
                        None
                    },
                    username: if is_ready && is_auth {
                        Some("mock-user".to_string())
                    } else {
                        None
                    },
                    error_message: None,
                }
            })
            .collect();

        // In mock mode, check which items are ready for optional_auths
        let github_authenticated = mock_items
            .iter()
            .find(|i| i.id == "gh_auth")
            .map(|i| matches!(i.status, SetupItemStatus::Ready))
            .unwrap_or(false);

        // Required base items for setup completion
        const REQUIRED_ITEMS_MOCK: &[&str] = &["homebrew", "node", "git", "gh"];

        let base_ready = mock_items
            .iter()
            .filter(|i| REQUIRED_ITEMS_MOCK.contains(&i.id.as_str()))
            .all(|i| matches!(i.status, SetupItemStatus::Ready));

        // Check which agent pairs are fully ready
        let mut detected_agents = Vec::new();
        for agent in ALL_AGENTS {
            let binary_ready = mock_items
                .iter()
                .find(|i| i.id == agent.setup_item_ids.0)
                .map(|i| matches!(i.status, SetupItemStatus::Ready))
                .unwrap_or(false);
            let auth_ready = mock_items
                .iter()
                .find(|i| i.id == agent.setup_item_ids.1)
                .map(|i| matches!(i.status, SetupItemStatus::Ready))
                .unwrap_or(false);
            if binary_ready && auth_ready {
                detected_agents.push(agent.id.to_string());
            }
        }

        let at_least_one_agent = !detected_agents.is_empty();
        // In mock mode, also require all items ready so the wizard shows
        // for any incomplete step (including optional ones like hosting).
        // The wizard handles skippable steps internally.
        let all_items_ready = mock_items
            .iter()
            .all(|i| matches!(i.status, SetupItemStatus::Ready));
        let all_ready = base_ready && at_least_one_agent && all_items_ready;

        return FullSetupStatus {
            all_ready,
            items: mock_items,
            optional_auths: OptionalAuths {
                github_authenticated,
            },
            detected_agents,
        };
    }

    let mut items = Vec::new();

    // 1. Package Manager (Homebrew on macOS/Linux, Winget on Windows)
    #[cfg(windows)]
    let (pkg_mgr_installed, pkg_mgr_version) = check_winget();
    #[cfg(not(windows))]
    let (pkg_mgr_installed, pkg_mgr_version) = check_homebrew();

    #[cfg(windows)]
    let pkg_mgr_name = "Winget";
    #[cfg(not(windows))]
    let pkg_mgr_name = "Package Manager";

    items.push(SetupItemInfo {
        id: "homebrew".to_string(), // Keep ID for backward compatibility
        friendly_name: pkg_mgr_name.to_string(),
        status: if pkg_mgr_installed {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: pkg_mgr_version,
        username: None,
        error_message: None,
    });

    // 2. Node.js
    let node_path = find_executable("node");
    let node_version = node_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    });
    let node_installed = node_path.is_some();
    items.push(SetupItemInfo {
        id: "node".to_string(),
        friendly_name: "Node.js".to_string(),
        status: if node_installed {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: node_version,
        username: None,
        error_message: None,
    });

    // 2b. npm cache permissions (only check if Node is installed)
    if node_installed {
        let npm_cache_ok = if let Some(home) = dirs::home_dir() {
            let npm_cache = home.join(".npm");
            if !npm_cache.exists() {
                true
            } else {
                let test_file = npm_cache.join(".shipstudio-write-test");
                match std::fs::write(&test_file, "test") {
                    Ok(_) => {
                        let _ = std::fs::remove_file(&test_file);
                        true
                    }
                    Err(_) => false,
                }
            }
        } else {
            true
        };

        if !npm_cache_ok {
            items.push(SetupItemInfo {
                id: "npm_fix".to_string(),
                friendly_name: "Fix npm Permissions".to_string(),
                status: SetupItemStatus::NotInstalled,
                version: None,
                username: None,
                error_message: Some(
                    "npm cache has incorrect permissions. Click to fix.".to_string(),
                ),
            });
        }
    }

    // 3. Git
    let git_path = find_executable("git");
    let git_version = git_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    });
    items.push(SetupItemInfo {
        id: "git".to_string(),
        friendly_name: "Git".to_string(),
        status: if git_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: git_version,
        username: None,
        error_message: None,
    });

    // 4. GitHub CLI
    let gh_path = find_executable("gh");
    let gh_version = gh_path.as_ref().and_then(|p| {
        create_command(p)
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
            })
    });
    items.push(SetupItemInfo {
        id: "gh".to_string(),
        friendly_name: "GitHub CLI".to_string(),
        status: if gh_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: gh_version,
        username: None,
        error_message: None,
    });

    // 5. GitHub Auth
    let gh_auth = if gh_path.is_some() {
        get_gh_command()
            .args(["auth", "status"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };
    let gh_username = if gh_auth {
        get_gh_command()
            .args(["api", "user", "--jq", ".login"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    } else {
        None
    };
    items.push(SetupItemInfo {
        id: "gh_auth".to_string(),
        friendly_name: "GitHub Account".to_string(),
        status: if gh_auth {
            SetupItemStatus::Ready
        } else if gh_path.is_some() {
            SetupItemStatus::NotAuthenticated
        } else {
            SetupItemStatus::NotInstalled
        },
        version: None,
        username: gh_username,
        error_message: None,
    });

    // 6-7. Agent CLIs and Auth — check ALL agents
    let mut detected_agents = Vec::new();

    for agent in ALL_AGENTS {
        let agent_path = find_binary_by_name(agent.binary_name);
        let agent_version = agent_path.as_ref().and_then(|p| {
            create_command(p)
                .args([agent.version_flag])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
        });
        let binary_ready = agent_path.is_some();
        items.push(SetupItemInfo {
            id: agent.setup_item_ids.0.to_string(),
            friendly_name: agent.setup_display_names.0.to_string(),
            status: if binary_ready {
                SetupItemStatus::Ready
            } else {
                SetupItemStatus::NotInstalled
            },
            version: agent_version,
            username: None,
            error_message: None,
        });

        // Agent Auth
        let agent_auth = if binary_ready {
            if let Some(home) = dirs::home_dir() {
                let agent_dir = home.join(agent.auth_config_dir);
                agent.auth_indicators.iter().any(|indicator| {
                    let path = agent_dir.join(indicator);
                    path.exists()
                })
            } else {
                false
            }
        } else {
            false
        };
        items.push(SetupItemInfo {
            id: agent.setup_item_ids.1.to_string(),
            friendly_name: agent.setup_display_names.1.to_string(),
            status: if agent_auth {
                SetupItemStatus::Ready
            } else if binary_ready {
                SetupItemStatus::NotAuthenticated
            } else {
                SetupItemStatus::NotInstalled
            },
            version: None,
            username: None,
            error_message: None,
        });

        if binary_ready && agent_auth {
            detected_agents.push(agent.id.to_string());
        }
    }

    // 8. Vercel CLI
    let vercel_path = find_executable("vercel");
    let vercel_version = vercel_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    });
    items.push(SetupItemInfo {
        id: "vercel".to_string(),
        friendly_name: "Vercel CLI".to_string(),
        status: if vercel_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: vercel_version,
        username: None,
        error_message: None,
    });

    // 9. Vercel Auth
    let vercel_auth = if vercel_path.is_some() {
        find_executable("vercel")
            .map(|p| {
                create_command(&p)
                    .args(["whoami"])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    } else {
        false
    };
    let vercel_username = if vercel_auth {
        find_executable("vercel").and_then(|p| {
            create_command(&p)
                .args(["whoami"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
        })
    } else {
        None
    };
    items.push(SetupItemInfo {
        id: "vercel_auth".to_string(),
        friendly_name: "Vercel Account".to_string(),
        status: if vercel_auth {
            SetupItemStatus::Ready
        } else if vercel_path.is_some() {
            SetupItemStatus::NotAuthenticated
        } else {
            SetupItemStatus::NotInstalled
        },
        version: None,
        username: vercel_username,
        error_message: None,
    });

    // Required base items for setup completion (GitHub auth and individual agent items are optional)
    const REQUIRED_ITEMS: &[&str] = &["homebrew", "node", "git", "gh"];

    let base_ready = items
        .iter()
        .filter(|i| REQUIRED_ITEMS.contains(&i.id.as_str()) || i.id == "npm_fix")
        .all(|i| matches!(i.status, SetupItemStatus::Ready));

    // At least one agent pair must be fully ready
    let at_least_one_agent = !detected_agents.is_empty();
    let all_ready = base_ready && at_least_one_agent;

    // Track optional auth status separately
    let github_authenticated = items
        .iter()
        .find(|i| i.id == "gh_auth")
        .map(|i| matches!(i.status, SetupItemStatus::Ready))
        .unwrap_or(false);

    // Force onboarding mode: run real checks but always report not-all-ready
    // so the onboarding wizard is shown with real item statuses
    let all_ready = if is_force_onboarding_mode() {
        false
    } else {
        all_ready
    };

    FullSetupStatus {
        all_ready,
        items,
        optional_auths: OptionalAuths {
            github_authenticated,
        },
        detected_agents,
    }
}

/// Quick setup check - only checks binary/file existence (no subprocess calls)
/// This is ~10ms vs 2-5 seconds for full setup check
#[tauri::command]
pub async fn quick_setup_check() -> QuickSetupCheck {
    // Force onboarding mode: always show onboarding with real checks
    if is_force_onboarding_mode() {
        return QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Mock mode: always show onboarding so the mock scenario is visible
    if is_mock_mode() {
        return QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Check persisted state first
    let app_state = read_app_state();

    if !app_state.setup_complete {
        return QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Fast Tier-1 checks: binary existence only (no --version calls)
    #[cfg(windows)]
    let pkg_mgr_present = check_winget().0;
    #[cfg(not(windows))]
    let pkg_mgr_present = check_homebrew().0;

    let node_present = find_executable("node").is_some();
    let git_present = find_executable("git").is_some();
    let gh_present = find_executable("gh").is_some();

    // Check ALL agents — at least one pair must be present
    let at_least_one_agent = ALL_AGENTS.iter().any(|agent| {
        let binary_present = find_binary_by_name(agent.binary_name).is_some();
        if !binary_present {
            return false;
        }
        if let Some(home) = dirs::home_dir() {
            let agent_dir = home.join(agent.auth_config_dir);
            agent
                .auth_indicators
                .iter()
                .any(|indicator| agent_dir.join(indicator).exists())
        } else {
            false
        }
    });

    // For gh_auth, we trust the cached state since checking requires subprocess
    // It will be verified in the background after showing projects

    let all_present =
        pkg_mgr_present && node_present && git_present && gh_present && at_least_one_agent;

    QuickSetupCheck {
        all_present,
        setup_complete_cached: true,
    }
}

/// Mark setup as complete (persists to disk)
#[tauri::command]
pub async fn mark_setup_complete() -> Result<(), String> {
    // Force onboarding / mock mode: don't persist to disk
    if is_force_onboarding_mode() {
        if let Ok(mut completed) = FORCE_ONBOARDING_COMPLETED.lock() {
            *completed = true;
        }
        tracing::info!("Force onboarding mode: skipping setup complete persistence");
        return Ok(());
    }
    if is_mock_mode() {
        tracing::info!("Mock mode: skipping setup complete persistence");
        return Ok(());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Read existing state to preserve other fields (e.g., compact_mode)
    let mut state = read_app_state();
    state.setup_complete = true;
    state.setup_completed_at = Some(timestamp);

    write_app_state(&state)?;
    tracing::info!("Setup marked as complete");
    Ok(())
}

/// Clear setup complete flag (for testing/reset)
#[tauri::command]
pub async fn reset_setup_state() -> Result<(), String> {
    // Read existing state to preserve other fields (e.g., compact_mode)
    let mut state = read_app_state();
    state.setup_complete = false;
    state.setup_completed_at = None;

    write_app_state(&state)?;
    tracing::info!("Setup state reset");
    Ok(())
}

/// Get the default agent ID from persisted AppState.
/// Returns None if not set (frontend should fall back to Claude Code).
#[tauri::command]
pub async fn get_default_agent_id() -> Option<String> {
    read_app_state().default_agent_id
}

/// Set the default agent ID. Persists to AppState and updates in-memory cache.
#[tauri::command]
pub async fn set_default_agent_id(agent_id: String) -> Result<(), String> {
    let mut state = read_app_state();
    state.default_agent_id = Some(agent_id.clone());
    write_app_state(&state)?;
    crate::agent::set_default_agent_cached(&agent_id);
    tracing::info!("Default agent set to: {}", agent_id);
    Ok(())
}

/// Install Homebrew
#[tauri::command]
pub async fn install_homebrew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "homebrew",
            "message": "Installing package manager..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("homebrew");
        return Ok(());
    }

    let output = create_command("bash")
        .args(["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""])
        .env("NONINTERACTIVE", "1")
        .output()
        .map_err(|e| format!("Failed to run Homebrew installer: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Homebrew installation failed: {}", stderr));
    }

    Ok(())
}

/// Install Node.js via Homebrew
#[tauri::command]
pub async fn install_node_via_brew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "node",
            "message": "Installing Node.js..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("node");
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = create_command(&brew)
        .args(["install", "node"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // Skip auto-update for faster install
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install Node.js: {}", stderr));
    }

    Ok(())
}

/// Install Git via Homebrew
#[tauri::command]
pub async fn install_git_via_brew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "git",
            "message": "Installing Git..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("git");
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = create_command(&brew)
        .args(["install", "git"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // Skip auto-update for faster install
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install Git: {}", stderr));
    }

    Ok(())
}

/// Install GitHub CLI via Homebrew
#[tauri::command]
pub async fn install_gh_via_brew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "gh",
            "message": "Installing GitHub CLI..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("gh");
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = create_command(&brew)
        .args(["install", "gh"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // Skip auto-update for faster install
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install GitHub CLI: {}", stderr));
    }

    Ok(())
}

/// Batch install multiple Homebrew packages in a single command.
/// This is faster than individual installs because:
/// 1. Auto-update only runs once
/// 2. Homebrew can download bottles in parallel
///
/// Mapping from item IDs to brew package names:
/// - node -> node
/// - git -> git
/// - gh -> gh
#[tauri::command]
pub async fn install_brew_packages(
    app: tauri::AppHandle,
    packages: Vec<String>,
) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }

    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "brew_batch",
            "message": format!("Installing {}...", packages.join(", "))
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        for pkg in &packages {
            mock_install(pkg);
        }
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let brew_packages: Vec<&str> = packages.iter().map(|p| p.as_str()).collect();

    let mut args = vec!["install"];
    args.extend(brew_packages.iter().copied());

    let output = create_command(&brew)
        .args(&args)
        // Allow auto-update since it only runs once for all packages
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to install packages: {}",
            stderr.lines().next().unwrap_or("Unknown error")
        ));
    }

    Ok(())
}

/// Batch install multiple packages via Winget (Windows only).
/// This is the Windows equivalent of install_brew_packages.
///
/// Mapping from item IDs to winget package IDs:
/// - node -> OpenJS.NodeJS
/// - git -> Git.Git
/// - gh -> GitHub.cli
#[cfg(windows)]
#[tauri::command]
pub async fn install_winget_packages(
    app: tauri::AppHandle,
    packages: Vec<String>,
) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }

    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "winget_batch",
            "message": format!("Installing {}...", packages.join(", "))
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        for pkg in &packages {
            mock_install(pkg);
        }
        return Ok(());
    }

    let winget = get_winget_command().ok_or("Winget not found")?;

    // Map item IDs to actual winget package IDs
    let winget_packages: Vec<&str> = packages
        .iter()
        .filter_map(|p| match p.as_str() {
            "node" => Some("OpenJS.NodeJS"),
            "git" => Some("Git.Git"),
            "gh" => Some("GitHub.cli"),
            _ => None,
        })
        .collect();

    if winget_packages.is_empty() {
        return Ok(());
    }

    // Install packages one at a time (winget doesn't support batch installs well)
    for package in winget_packages {
        let output = create_command(&winget)
            .args([
                "install",
                "--id",
                package,
                "--exact",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .output()
            .map_err(|e| format!("Failed to run winget: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Don't fail if package is already installed
            if !stdout.contains("already installed") && !stderr.contains("already installed") {
                return Err(format!(
                    "Failed to install {}: {}",
                    package,
                    stderr
                        .lines()
                        .next()
                        .unwrap_or(&stdout.lines().next().unwrap_or("Unknown error"))
                ));
            }
        }
    }

    Ok(())
}

// Stub for non-Windows platforms
#[cfg(not(windows))]
#[tauri::command]
pub async fn install_winget_packages(
    _app: tauri::AppHandle,
    _packages: Vec<String>,
) -> Result<(), String> {
    Err("Winget is only available on Windows".to_string())
}

/// Check if the npm cache directory (~/.npm) is writable by the current user.
/// Returns "ok" if writable or doesn't exist, "not_writable" if it exists but isn't writable.
#[tauri::command]
pub async fn check_npm_cache_permissions() -> String {
    if let Some(home) = dirs::home_dir() {
        let npm_cache = home.join(".npm");
        if !npm_cache.exists() {
            return "ok".to_string();
        }

        // Try to create and delete a temp file to test write access
        let test_file = npm_cache.join(".shipstudio-write-test");
        match std::fs::write(&test_file, "test") {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_file);
                "ok".to_string()
            }
            Err(_) => "not_writable".to_string(),
        }
    } else {
        "ok".to_string()
    }
}

/// Start GitHub authentication (opens browser)
#[tauri::command]
pub async fn start_github_auth(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "gh_auth",
            "message": "Opening browser..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("gh_auth");
        return Ok("Mock auth completed".to_string());
    }

    let gh_path = find_executable("gh").ok_or("GitHub CLI not installed")?;

    let child = create_command(&gh_path)
        .args([
            "auth",
            "login",
            "--web",
            "--git-protocol",
            "https",
            "--clipboard",
        ])
        .spawn()
        .map_err(|e| format!("Failed to start GitHub auth: {}", e))?;

    // Store the process PID for potential cleanup instead of forgetting it
    let pid = child.id();
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.insert("github".to_string(), pid);
    }
    // Spawn a thread to wait for the process and clean up the registry when it exits
    std::thread::spawn(move || {
        let _ = child.wait_with_output();
        if let Ok(mut pids) = AUTH_PIDS.lock() {
            pids.remove("github");
        }
    });

    Ok("A code has been copied to your clipboard. Paste it in the browser to connect.".to_string())
}

/// Start agent authentication.
/// If `agent_id` is provided, authenticate that specific agent. Otherwise, use the active agent.
#[tauri::command]
pub async fn start_claude_auth(
    app: tauri::AppHandle,
    agent_id: Option<String>,
) -> Result<String, String> {
    let agent = match agent_id.as_deref() {
        Some(id) => get_agent_by_id(id),
        None => get_active_agent(),
    };

    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": agent.setup_item_ids.1,
            "message": "Opening browser..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install(agent.setup_item_ids.1);
        return Ok("Mock auth completed".to_string());
    }

    let agent_path = find_binary_by_name(agent.binary_name)
        .ok_or(format!("{} not installed", agent.display_name))?;

    let child = create_command(&agent_path)
        .args(agent.auth_trigger_args)
        .spawn()
        .map_err(|e| format!("Failed to start {} auth: {}", agent.display_name, e))?;

    // Store the process PID for potential cleanup instead of forgetting it
    let pid = child.id();
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.insert(agent.id.to_string(), pid);
    }
    // Spawn a thread to wait for the process and clean up the registry when it exits
    let agent_id_str = agent.id.to_string();
    std::thread::spawn(move || {
        let _ = child.wait_with_output();
        if let Ok(mut pids) = AUTH_PIDS.lock() {
            pids.remove(&agent_id_str);
        }
    });

    Ok(format!(
        "Browser opened. Log in to your {} account to continue.",
        agent.display_name
    ))
}

/// Check if an agent is authenticated.
/// If `agent_id` is provided, check that specific agent. Otherwise, use the active agent.
#[tauri::command]
pub async fn check_claude_auth_status(agent_id: Option<String>) -> bool {
    let agent = match agent_id.as_deref() {
        Some(id) => get_agent_by_id(id),
        None => get_active_agent(),
    };

    if is_mock_mode() {
        return is_mock_installed(agent.setup_item_ids.1);
    }

    if find_binary_by_name(agent.binary_name).is_none() {
        return false;
    }

    if let Some(home) = dirs::home_dir() {
        let agent_dir = home.join(agent.auth_config_dir);
        return agent.auth_indicators.iter().any(|indicator| {
            let path = agent_dir.join(indicator);
            path.exists()
        });
    }

    false
}

/// Kill all tracked auth processes (synchronous helper).
///
/// This is useful for cleanup when closing the app to prevent orphaned processes.
/// Returns the number of processes that were killed.
pub fn cleanup_auth_processes_sync() -> u32 {
    let pids: Vec<(String, u32)> = {
        match AUTH_PIDS.lock() {
            Ok(pids) => pids.iter().map(|(k, &v)| (k.clone(), v)).collect(),
            Err(_) => return 0,
        }
    };

    let count = pids.len() as u32;

    for (_auth_type, pid) in pids {
        #[cfg(unix)]
        {
            // Send SIGTERM for graceful shutdown
            let _ = create_command("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
        }

        #[cfg(windows)]
        {
            let _ = create_command("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }
    }

    // Clear the registry
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.clear();
    }

    count
}

/// Kill all tracked auth processes (Tauri command wrapper).
///
/// This is useful for cleanup when closing the app to prevent orphaned processes.
/// Returns the number of processes that were killed.
#[tauri::command]
pub async fn cleanup_auth_processes() -> Result<u32, String> {
    Ok(cleanup_auth_processes_sync())
}

/// Get the system CPU architecture (e.g., "aarch64" or "x86_64").
#[tauri::command]
pub fn get_system_arch() -> String {
    std::env::consts::ARCH.to_string()
}

/// Download and install a specific app version (for downgrading/rewinding).
///
/// On macOS: downloads the .tar.gz update bundle, extracts, and swaps the .app bundle.
/// On Windows: downloads the .nsis.zip, extracts, and runs the NSIS installer silently.
/// The frontend should call `relaunch()` after this completes (macOS only;
/// on Windows the installer handles restart).
#[tauri::command]
pub async fn install_version(app: tauri::AppHandle, version: String) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Version rewind is only available in production builds.".to_string());
    }

    let _ = app.emit(
        "rewind-progress",
        serde_json::json!({ "stage": "downloading" }),
    );

    // Create temp directory
    let temp_dir = std::env::temp_dir().join("shipstudio-rewind");
    let _ = std::fs::remove_dir_all(&temp_dir);
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Cannot create temp dir: {e}"))?;

    let result = install_version_platform(&app, &version, &temp_dir).await;

    // Always cleanup temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    result?;

    tracing::info!("Rewind: v{} installed successfully", version);
    let _ = app.emit("rewind-progress", serde_json::json!({ "stage": "done" }));

    Ok(())
}

/// Download a file from the releases repo using curl.
async fn download_release_artifact(url: &str, dest: &std::path::Path) -> Result<(), String> {
    tracing::info!("Rewind: downloading {}", url);

    let download = tokio::process::Command::new("curl")
        .args(["-L", "--fail", "-o", dest.to_str().unwrap(), url])
        .output()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !download.status.success() {
        let stderr = String::from_utf8_lossy(&download.stderr);
        return Err(format!(
            "Download failed. This version may not be available.\n{}",
            stderr.lines().next().unwrap_or("")
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
async fn install_version_platform(
    app: &tauri::AppHandle,
    version: &str,
    temp_dir: &std::path::Path,
) -> Result<(), String> {
    let arch = std::env::consts::ARCH;
    let arch_suffix = if arch == "aarch64" {
        "aarch64"
    } else {
        "x86_64"
    };

    let url = format!(
        "https://github.com/ship-studio/releases/releases/download/v{}/ShipStudio_darwin-{}.app.tar.gz",
        version, arch_suffix
    );

    // Find current app bundle path (e.g., /Applications/Ship Studio.app)
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find app path: {e}"))?;
    let app_bundle = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Ship Studio.app
        .ok_or("Could not determine app bundle path")?
        .to_path_buf();

    tracing::info!("Rewind: app bundle at {:?}", app_bundle);

    // Download the update bundle
    let tar_path = temp_dir.join("update.tar.gz");
    download_release_artifact(&url, &tar_path).await?;

    tracing::info!("Rewind: download complete, extracting");
    let _ = app.emit(
        "rewind-progress",
        serde_json::json!({ "stage": "installing" }),
    );

    // Extract the tar.gz
    let extract_dir = temp_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("Cannot create extract dir: {e}"))?;

    let extract = tokio::process::Command::new("tar")
        .args([
            "xzf",
            tar_path.to_str().unwrap(),
            "-C",
            extract_dir.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| format!("Extraction failed: {e}"))?;

    if !extract.status.success() {
        let stderr = String::from_utf8_lossy(&extract.stderr);
        return Err(format!("Extraction failed: {}", stderr));
    }

    // Find the extracted .app bundle
    let extracted_app = extract_dir.join("Ship Studio.app");
    if !extracted_app.exists() {
        return Err("Extracted app bundle not found".to_string());
    }

    // Swap the app bundle: rename current -> .old, move new -> current, delete .old
    let backup_path = app_bundle.with_extension("app.old");
    let _ = std::fs::remove_dir_all(&backup_path);

    // Rename current app to .old (macOS allows renaming a running app)
    std::fs::rename(&app_bundle, &backup_path)
        .map_err(|e| format!("Cannot move current app: {e}"))?;

    // Move extracted app into place
    if let Err(e) = std::fs::rename(&extracted_app, &app_bundle) {
        // Restore backup on failure
        let _ = std::fs::rename(&backup_path, &app_bundle);
        return Err(format!("Cannot install new version: {e}"));
    }

    // Cleanup backup
    let _ = std::fs::remove_dir_all(&backup_path);

    Ok(())
}

#[cfg(target_os = "windows")]
async fn install_version_platform(
    app: &tauri::AppHandle,
    version: &str,
    temp_dir: &std::path::Path,
) -> Result<(), String> {
    let url = format!(
        "https://github.com/ship-studio/releases/releases/download/v{}/ShipStudio_windows-x86_64.nsis.zip",
        version
    );

    // Download the NSIS zip
    let zip_path = temp_dir.join("update.nsis.zip");
    download_release_artifact(&url, &zip_path).await?;

    tracing::info!("Rewind: download complete, extracting");
    let _ = app.emit(
        "rewind-progress",
        serde_json::json!({ "stage": "installing" }),
    );

    // Extract using PowerShell
    let extract_dir = temp_dir.join("extracted");
    let extract = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip_path.display(),
                extract_dir.display()
            ),
        ])
        .output()
        .await
        .map_err(|e| format!("Extraction failed: {e}"))?;

    if !extract.status.success() {
        let stderr = String::from_utf8_lossy(&extract.stderr);
        return Err(format!("Extraction failed: {}", stderr));
    }

    // Find the setup exe inside the extracted directory
    let setup_exe = find_setup_exe(&extract_dir)?;
    tracing::info!("Rewind: running installer {:?}", setup_exe);

    // Run the NSIS installer silently — it will close the current app,
    // install the new version, and relaunch automatically
    let install = tokio::process::Command::new(&setup_exe)
        .args(["/S", "--update"])
        .spawn()
        .map_err(|e| format!("Cannot run installer: {e}"))?;

    // Detach — the installer will handle closing this process and relaunching
    drop(install);

    Ok(())
}

/// Find the NSIS setup .exe inside an extracted directory.
#[cfg(target_os = "windows")]
fn find_setup_exe(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for entry in walkdir::WalkDir::new(dir).max_depth(2) {
        if let Ok(entry) = entry {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with("-setup.exe") {
                    return Ok(path.to_path_buf());
                }
            }
        }
    }
    Err("Setup installer not found in downloaded archive".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn install_version_platform(
    _app: &tauri::AppHandle,
    _version: &str,
    _temp_dir: &std::path::Path,
) -> Result<(), String> {
    Err("Version rewind is not yet available on this platform.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ get_scenario_items ============

    #[test]
    fn scenario_fresh_returns_empty() {
        let items = get_scenario_items("fresh");
        assert!(items.is_empty());
    }

    #[test]
    fn scenario_1_alias_returns_empty() {
        let items = get_scenario_items("1");
        assert!(items.is_empty());
    }

    #[test]
    fn scenario_auth_only_returns_tool_items() {
        let items = get_scenario_items("auth-only");
        assert_eq!(items, TOOL_ITEMS.to_vec());
    }

    #[test]
    fn scenario_both_agents_returns_all_items() {
        let items = get_scenario_items("both-agents");
        assert_eq!(items, ALL_ITEMS.to_vec());
    }

    #[test]
    fn scenario_codex_only_excludes_claude() {
        let items = get_scenario_items("codex-only");
        assert!(!items.contains(&"claude"));
        assert!(!items.contains(&"claude_auth"));
        assert!(items.contains(&"codex"));
        assert!(items.contains(&"codex_auth"));
    }

    #[test]
    fn scenario_github_missing_excludes_gh_auth() {
        let items = get_scenario_items("github-missing");
        assert!(!items.contains(&"gh_auth"));
        assert!(items.contains(&"gh"));
    }

    #[test]
    fn scenario_homebrew_missing_excludes_homebrew() {
        let items = get_scenario_items("homebrew-missing");
        assert!(!items.contains(&"homebrew"));
        assert!(items.contains(&"node"));
    }

    #[test]
    fn scenario_comma_separated_returns_exact_items() {
        let items = get_scenario_items("homebrew,node,git");
        assert_eq!(items.len(), 3);
        assert!(items.contains(&"homebrew"));
        assert!(items.contains(&"node"));
        assert!(items.contains(&"git"));
    }

    #[test]
    fn scenario_unknown_item_in_csv_returns_empty() {
        let items = get_scenario_items("unknown_item");
        assert!(items.is_empty());
    }

    #[test]
    fn all_items_contains_11_items_including_codex_and_vercel() {
        assert_eq!(ALL_ITEMS.len(), 11);
        assert!(ALL_ITEMS.contains(&"codex"));
        assert!(ALL_ITEMS.contains(&"codex_auth"));
        assert!(ALL_ITEMS.contains(&"vercel"));
        assert!(ALL_ITEMS.contains(&"vercel_auth"));
    }

    #[test]
    fn tool_items_contains_7_items_including_codex_and_vercel() {
        assert_eq!(TOOL_ITEMS.len(), 7);
        assert!(TOOL_ITEMS.contains(&"codex"));
        assert!(TOOL_ITEMS.contains(&"claude"));
        assert!(TOOL_ITEMS.contains(&"vercel"));
    }

    // ============ AppState ============

    #[test]
    fn app_state_default_has_no_default_agent_id() {
        let state = AppState::default();
        assert!(state.default_agent_id.is_none());
        assert!(!state.setup_complete);
    }

    #[test]
    fn app_state_deserializes_without_default_agent_id() {
        // Simulate a legacy JSON without the default_agent_id field
        let json = r#"{"setupComplete": true, "setupCompletedAt": 12345}"#;
        let state: AppState = serde_json::from_str(json).unwrap();
        assert!(state.setup_complete);
        assert!(state.default_agent_id.is_none());
    }

    #[test]
    fn app_state_deserializes_with_default_agent_id() {
        let json = r#"{"setupComplete": true, "defaultAgentId": "codex"}"#;
        let state: AppState = serde_json::from_str(json).unwrap();
        assert_eq!(state.default_agent_id, Some("codex".to_string()));
    }
}
