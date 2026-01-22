//! # Marketingstack Backend
//!
//! This module contains all Tauri commands for the Marketingstack desktop app.
//! Commands are organized into these categories:
//!
//! - **Project Management**: Create, list, delete projects in ~/Marketingstack
//! - **Dev Server & Terminal**: PTY management for Claude Code terminal
//! - **GitHub Integration**: Check status, create repos, commit and push
//! - **Vercel Integration**: Check status, deploy projects
//! - **Environment Variables**: Read/write .env files with validation
//! - **Native Webview**: Child webview for Sanity CMS (OAuth support)
//! - **Utilities**: Screenshots, IDE launcher, prerequisite checks

use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::io::{BufRead, BufReader};
use tauri::{Emitter, Manager};

/// Counter for generating unique PTY IDs
static PTY_ID_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Builds an extended PATH that includes common tool installation locations.
/// macOS apps launched from Finder don't inherit the user's shell PATH,
/// so we need to explicitly add Homebrew, npm global, and NVM paths.
fn get_extended_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();

    let mut paths: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),      // Homebrew (Apple Silicon)
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),         // Homebrew (Intel) / manual installs
        "/usr/local/sbin".to_string(),
    ];

    // Add user-specific paths
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        paths.push(format!("{}/.npm-global/bin", home_str));
        paths.push(format!("{}/n/bin", home_str));

        // Add NVM current version if it exists
        let nvm_base = home.join(".nvm/versions/node");
        if nvm_base.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_base) {
                for entry in entries.flatten() {
                    paths.push(format!("{}/bin", entry.path().to_string_lossy()));
                }
            }
        }
    }

    // Append existing PATH
    if !current_path.is_empty() {
        paths.push(current_path);
    }

    paths.join(":")
}

/// Result of checking if a prerequisite tool is installed
#[derive(Serialize)]
struct PrerequisiteCheck {
    name: String,
    available: bool,
    path: Option<String>,
}

/// Finds an executable by checking common installation paths.
/// This is needed because bundled macOS apps don't inherit the user's shell PATH.
fn find_executable(cmd: &str) -> Option<std::path::PathBuf> {
    // First try which (works in dev and if PATH is set)
    if let Ok(path) = which::which(cmd) {
        return Some(path);
    }

    // Check common installation paths for macOS
    let common_paths = vec![
        std::path::PathBuf::from("/opt/homebrew/bin").join(cmd),  // Homebrew (Apple Silicon)
        std::path::PathBuf::from("/usr/local/bin").join(cmd),     // Homebrew (Intel) / manual
        std::path::PathBuf::from("/usr/bin").join(cmd),           // System
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
            home.join("n/bin").join(cmd),  // n version manager
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

    None
}

/// Checks if required tools (node, npm, git, gh, vercel, claude) are installed.
/// Returns availability and path for each tool.
#[tauri::command]
async fn check_prerequisites() -> Vec<PrerequisiteCheck> {
    let commands = vec!["node", "npm", "git", "gh", "vercel", "claude"];
    let mut results = Vec::new();

    for cmd in commands {
        let (available, path) = match find_executable(cmd) {
            Some(p) => (true, Some(p.to_string_lossy().to_string())),
            None => (false, None),
        };
        results.push(PrerequisiteCheck {
            name: cmd.to_string(),
            available,
            path,
        });
    }

    results
}

/// Returns the path to ~/Marketingstack directory
#[tauri::command]
async fn get_marketingstack_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");
    Ok(marketingstack_dir.to_string_lossy().to_string())
}

/// Creates ~/Marketingstack directory if it doesn't exist
#[tauri::command]
async fn ensure_marketingstack_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir).map_err(|e| e.to_string())?;
    }

    Ok(marketingstack_dir.to_string_lossy().to_string())
}

/// Validates that a project path is inside the ~/Marketingstack directory.
/// Prevents path traversal attacks where frontend could pass arbitrary paths.
fn validate_project_path(project_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(project_path);
    let canonical = path.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    if !canonical.starts_with(&marketingstack_dir) {
        return Err(format!(
            "Security error: path '{}' is outside Marketingstack directory",
            project_path
        ));
    }

    Ok(canonical)
}

/// Project metadata returned by list_projects
#[derive(Serialize)]
struct ProjectInfo {
    name: String,
    path: String,
    /// Asset protocol URL to thumbnail image, if it exists
    thumbnail: Option<String>,
    /// Unix timestamp (ms) when project was last opened
    last_opened: Option<u64>,
}

// ============ Project Metadata (Publish State Persistence) ============

/// Record of a single publish event (staging or production)
#[derive(Serialize, Deserialize, Clone)]
struct PublishRecord {
    url: String,
    state: String,
    #[serde(rename = "publishedAt")]
    published_at: u64,
}

/// Publish metadata for staging and production
#[derive(Serialize, Deserialize, Clone, Default)]
struct PublishMetadata {
    staging: Option<PublishRecord>,
    production: Option<PublishRecord>,
}

/// Project metadata stored in .marketingstack/project.json
#[derive(Serialize, Deserialize)]
struct ProjectMetadata {
    #[serde(rename = "_description")]
    description: String,
    publish: PublishMetadata,
    /// Unix timestamp (ms) when project was last opened
    #[serde(skip_serializing_if = "Option::is_none")]
    last_opened: Option<u64>,
    /// Whether to prefix branch names with username (default true)
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_prefix_username: Option<bool>,
}

impl Default for ProjectMetadata {
    fn default() -> Self {
        ProjectMetadata {
            description: "Marketingstack project metadata. Auto-generated - safe to delete if needed, will be recreated.".to_string(),
            publish: PublishMetadata::default(),
            last_opened: None,
            branch_prefix_username: None,
        }
    }
}

/// Reads project metadata from .marketingstack/project.json
/// Returns None if file doesn't exist (not an error)
#[tauri::command]
async fn read_project_metadata(project_path: String) -> Result<Option<ProjectMetadata>, String> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".marketingstack").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read project metadata: {}", e))?;

    let metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {}", e))?;

    Ok(Some(metadata))
}

/// Writes project metadata to .marketingstack/project.json
/// Creates the .marketingstack directory if needed
#[tauri::command]
async fn write_project_metadata(project_path: String, metadata: ProjectMetadata) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let marketingstack_dir = project.join(".marketingstack");

    // Ensure .marketingstack directory exists
    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir)
            .map_err(|e| format!("Failed to create .marketingstack directory: {}", e))?;
    }

    let metadata_path = marketingstack_dir.join("project.json");
    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;

    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Marks a project as opened by updating its last_opened timestamp
#[tauri::command]
async fn mark_project_opened(project_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let marketingstack_dir = project.join(".marketingstack");
    let metadata_path = marketingstack_dir.join("project.json");

    // Read existing metadata or create default
    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    // Update last_opened to current time
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    metadata.last_opened = Some(now);

    // Ensure .marketingstack directory exists
    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir)
            .map_err(|e| format!("Failed to create .marketingstack directory: {}", e))?;
    }

    // Write updated metadata
    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Gets the branch prefix username preference (defaults to true if not set)
#[tauri::command]
async fn get_branch_prefix_preference(project_path: String) -> Result<bool, String> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".marketingstack").join("project.json");

    if !metadata_path.exists() {
        return Ok(true); // Default to true
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.branch_prefix_username.unwrap_or(true))
}

/// Sets the branch prefix username preference
#[tauri::command]
async fn set_branch_prefix_preference(project_path: String, prefix: bool) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let marketingstack_dir = project.join(".marketingstack");
    let metadata_path = marketingstack_dir.join("project.json");

    // Read existing metadata or create default
    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    // Update preference
    metadata.branch_prefix_username = Some(prefix);

    // Ensure .marketingstack directory exists
    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir)
            .map_err(|e| format!("Failed to create .marketingstack directory: {}", e))?;
    }

    // Write updated metadata
    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Deletes a project directory. Only allows deletion from ~/Marketingstack.
#[tauri::command]
async fn delete_project(path: String) -> Result<(), String> {
    let project_path = std::path::Path::new(&path);

    // Safety check: only allow deleting from Marketingstack directory
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    if !project_path.starts_with(&marketingstack_dir) {
        return Err("Can only delete projects from Marketingstack directory".to_string());
    }

    if !project_path.exists() {
        return Err("Project not found".to_string());
    }

    std::fs::remove_dir_all(project_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ensures .marketingstack/ is in the project's .gitignore
/// This prevents the metadata directory from being tracked and causing phantom changes
#[tauri::command]
async fn ensure_gitignore_has_marketingstack(project_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let gitignore_path = project.join(".gitignore");

    let entry = ".marketingstack/";

    // Read existing .gitignore content
    let content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)
            .map_err(|e| format!("Failed to read .gitignore: {}", e))?
    } else {
        String::new()
    };

    // Check if .marketingstack/ is already in gitignore
    let already_ignored = content.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == entry || trimmed == ".marketingstack" || trimmed == "/.marketingstack/" || trimmed == "/.marketingstack"
    });

    if already_ignored {
        return Ok(());
    }

    // Append .marketingstack/ to .gitignore
    let new_content = if content.is_empty() {
        format!("# Marketingstack metadata\n{}\n", entry)
    } else if content.ends_with('\n') {
        format!("{}\n# Marketingstack metadata\n{}\n", content, entry)
    } else {
        format!("{}\n\n# Marketingstack metadata\n{}\n", content, entry)
    };

    std::fs::write(&gitignore_path, new_content)
        .map_err(|e| format!("Failed to write .gitignore: {}", e))?;

    Ok(())
}

/// Sync helper for ensuring .marketingstack/ is in gitignore (used by get_dashboard_projects)
fn ensure_gitignore_has_marketingstack_sync(project: &std::path::Path) -> Result<(), String> {
    let gitignore_path = project.join(".gitignore");
    let entry = ".marketingstack/";

    let content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path).unwrap_or_default()
    } else {
        String::new()
    };

    let already_ignored = content.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == entry || trimmed == ".marketingstack" || trimmed == "/.marketingstack/" || trimmed == "/.marketingstack"
    });

    if already_ignored {
        return Ok(());
    }

    let new_content = if content.is_empty() {
        format!("# Marketingstack metadata\n{}\n", entry)
    } else if content.ends_with('\n') {
        format!("{}\n# Marketingstack metadata\n{}\n", content, entry)
    } else {
        format!("{}\n\n# Marketingstack metadata\n{}\n", content, entry)
    };

    std::fs::write(&gitignore_path, new_content).ok();
    Ok(())
}

/// Next.js page route information
#[derive(Serialize)]
struct PageInfo {
    /// URL route (e.g., "/about", "/blog/[slug]")
    route: String,
    /// Path to the page file
    file_path: String,
}

/// Scans a Next.js project's app directory for page routes.
/// Supports both `/app` and `/src/app` directory structures.
#[tauri::command]
async fn list_pages(project_path: String) -> Result<Vec<PageInfo>, String> {
    let project = validate_project_path(&project_path)?;
    let app_dir = project.join("app");

    if !app_dir.exists() {
        // Try src/app for projects with src directory
        let src_app_dir = project.join("src").join("app");
        if !src_app_dir.exists() {
            return Ok(Vec::new());
        }
        return scan_pages(&src_app_dir, &src_app_dir);
    }

    scan_pages(&app_dir, &app_dir)
}

#[tauri::command]
async fn check_sanity_installed(project_path: String) -> Result<bool, String> {
    let path = validate_project_path(&project_path)?;

    // Check for sanity.config.ts or sanity.config.js
    if path.join("sanity.config.ts").exists() || path.join("sanity.config.js").exists() {
        return Ok(true);
    }

    // Check package.json for sanity dependency
    let pkg_path = path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"sanity\"") || contents.contains("\"next-sanity\"") {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

#[tauri::command]
async fn check_sanity_env_keys(project_path: String) -> Result<Vec<String>, String> {
    let path = validate_project_path(&project_path)?;

    // Required Sanity env var keys (we only check if keys exist, never read values)
    let required_keys = [
        "NEXT_PUBLIC_SANITY_PROJECT_ID",
        "NEXT_PUBLIC_SANITY_DATASET",
    ];

    let mut missing_keys: Vec<String> = required_keys.iter().map(|s| s.to_string()).collect();

    // Check .env.local first (most common), then .env
    let env_files = [".env.local", ".env"];

    for env_file in env_files {
        let env_path = path.join(env_file);
        if env_path.exists() {
            if let Ok(contents) = std::fs::read_to_string(&env_path) {
                for line in contents.lines() {
                    let line = line.trim();
                    // Skip comments and empty lines
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    // Extract key (everything before '=')
                    if let Some(key) = line.split('=').next() {
                        let key = key.trim();
                        missing_keys.retain(|k| k != key);
                    }
                }
            }
        }
    }

    Ok(missing_keys)
}

// ============ Environment Variables ============

#[derive(Serialize)]
struct EnvFile {
    name: String,
    path: String,
}

#[derive(Serialize, Deserialize)]
struct EnvVar {
    key: String,
    value: String,
}

#[tauri::command]
async fn list_env_files(project_path: String) -> Result<Vec<EnvFile>, String> {
    let project = validate_project_path(&project_path)?;
    let mut env_files = Vec::new();

    // Common env file names to look for
    let env_names = [
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".env.production",
        ".env.production.local",
        ".env.test",
        ".env.test.local",
    ];

    for name in env_names {
        let env_path = project.join(name);
        if env_path.exists() {
            env_files.push(EnvFile {
                name: name.to_string(),
                path: env_path.to_string_lossy().to_string(),
            });
        }
    }

    Ok(env_files)
}

#[tauri::command]
async fn read_env_file(file_path: String) -> Result<Vec<EnvVar>, String> {
    let contents = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut vars = Vec::new();

    for line in contents.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Parse KEY=VALUE format
        if let Some(eq_pos) = line.find('=') {
            let key = line[..eq_pos].trim().to_string();
            let value = line[eq_pos + 1..].trim().to_string();

            // Remove surrounding quotes if present
            let value = if (value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\''))
            {
                value[1..value.len() - 1].to_string()
            } else {
                value
            };

            vars.push(EnvVar { key, value });
        }
    }

    Ok(vars)
}

/// Writes environment variables to a .env file with validation.
/// Validates that variable names are alphanumeric/underscore and don't start with numbers.
/// Auto-quotes values containing spaces or special characters.
#[tauri::command]
async fn write_env_file(file_path: String, vars: Vec<EnvVar>) -> Result<(), String> {
    let mut contents = String::new();

    for var in vars {
        // Validate env variable key: must be alphanumeric or underscore, can't start with number
        if var.key.is_empty() {
            return Err("Environment variable name cannot be empty".to_string());
        }
        if !var.key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("Invalid environment variable name: {}. Only letters, numbers, and underscores allowed.", var.key));
        }
        if var.key.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            return Err(format!("Environment variable name cannot start with a number: {}", var.key));
        }

        // Quote values that contain spaces or special characters
        let value = if var.value.contains(' ') || var.value.contains('#') || var.value.contains('=') {
            format!("\"{}\"", var.value)
        } else {
            var.value
        };
        contents.push_str(&format!("{}={}\n", var.key, value));
    }

    std::fs::write(&file_path, contents).map_err(|e| e.to_string())?;
    Ok(())
}

/// Creates a new .env file in the project directory.
/// Validates both project path (must be in Marketingstack) and filename.
#[tauri::command]
async fn create_env_file(project_path: String, file_name: String) -> Result<String, String> {
    // Validate project path is inside Marketingstack directory
    let project = validate_project_path(&project_path)?;

    // Validate filename to prevent path traversal attacks
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("Invalid filename: path separators not allowed".to_string());
    }
    if !file_name.starts_with('.') || !file_name.contains("env") {
        return Err("Invalid filename: must be an env file (e.g., .env, .env.local)".to_string());
    }

    let env_path = project.join(&file_name);

    // Double-check the resolved path is still within the project
    if !env_path.starts_with(&project) {
        return Err("Invalid filename: path traversal detected".to_string());
    }

    if env_path.exists() {
        return Err(format!("{} already exists", file_name));
    }

    std::fs::write(&env_path, "").map_err(|e| e.to_string())?;
    Ok(env_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_env_file(file_path: String) -> Result<(), String> {
    // Validate the file is inside Marketingstack directory
    let path = std::path::Path::new(&file_path);
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    let canonical = path.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical.starts_with(&marketingstack_dir) {
        return Err("Security error: cannot delete files outside Marketingstack directory".to_string());
    }

    std::fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct IdeAvailability {
    vscode: bool,
    cursor: bool,
}

#[tauri::command]
async fn check_ide_availability() -> IdeAvailability {
    #[cfg(target_os = "macos")]
    {
        // Check if apps exist in /Applications
        let vscode = std::path::Path::new("/Applications/Visual Studio Code.app").exists();
        let cursor = std::path::Path::new("/Applications/Cursor.app").exists();
        IdeAvailability { vscode, cursor }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Check if commands are in PATH
        let vscode = which::which("code").is_ok();
        let cursor = which::which("cursor").is_ok();
        IdeAvailability { vscode, cursor }
    }
}

// =============================================================================
// Native Webview for Sanity CMS
// =============================================================================
// Uses Tauri's unstable child webview feature to create a native webview
// that can handle OAuth flows (unlike iframes which block cross-origin auth).
// The webview is positioned absolutely over the main window.

use std::sync::Mutex;
use tauri::{WebviewUrl, Webview};

/// Tracks whether a preview webview currently exists
static PREVIEW_WEBVIEW_EXISTS: Mutex<bool> = Mutex::new(false);

/// Creates a native child webview at the specified position.
/// Used for Sanity Studio to support OAuth authentication.
/// Only one preview webview can exist at a time.
#[tauri::command]
async fn create_preview_webview(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview_window = app.get_webview_window("main").ok_or("Main window not found")?;
    // Access the underlying Window through the Webview
    let webview_ref: &Webview<tauri::Wry> = webview_window.as_ref();
    let window = webview_ref.window();

    // Check if webview already exists
    let mut exists = PREVIEW_WEBVIEW_EXISTS.lock().unwrap();
    if *exists {
        // Just navigate the existing webview
        if let Some(webview) = app.get_webview("preview") {
            let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
            webview.navigate(parsed_url).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Create the preview webview
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new(
        "preview",
        WebviewUrl::External(parsed_url)
    )
    .auto_resize();

    window.add_child(
        builder,
        tauri::LogicalPosition::new(x, y),
        tauri::LogicalSize::new(width, height),
    ).map_err(|e| format!("Failed to create webview: {}", e))?;

    *exists = true;
    Ok(())
}

#[tauri::command]
async fn navigate_preview_webview(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview") {
        let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn resize_preview_webview(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview") {
        webview.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        webview.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn destroy_preview_webview(app: tauri::AppHandle) -> Result<(), String> {
    let mut exists = PREVIEW_WEBVIEW_EXISTS.lock().unwrap();
    if let Some(webview) = app.get_webview("preview") {
        webview.close().map_err(|e| e.to_string())?;
        *exists = false;
    }
    Ok(())
}

#[tauri::command]
async fn open_studio_window(app: tauri::AppHandle, url: String, title: String) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    // Check if studio window already exists
    if let Some(window) = app.get_webview_window("studio") {
        // Focus existing window and navigate to URL
        window.set_focus().map_err(|e| e.to_string())?;
        let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        window.navigate(parsed_url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create new studio window
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    WebviewWindowBuilder::new(&app, "studio", WebviewUrl::External(parsed_url))
        .title(&title)
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create studio window: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn open_in_ide(project_path: String, ide: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    let path_str = validated_path.to_string_lossy();

    #[cfg(target_os = "macos")]
    {
        let app_name = match ide.as_str() {
            "vscode" => "Visual Studio Code",
            "cursor" => "Cursor",
            _ => return Err(format!("Unknown IDE: {}", ide)),
        };

        // Use 'open -a' on macOS which is more reliable
        Command::new("open")
            .args(["-a", app_name, path_str.as_ref()])
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", ide, e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let cmd = match ide.as_str() {
            "vscode" => "code",
            "cursor" => "cursor",
            _ => return Err(format!("Unknown IDE: {}", ide)),
        };

        Command::new(cmd)
            .arg(path_str.as_ref())
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", ide, e))?;
    }

    Ok(())
}

fn scan_pages(dir: &std::path::Path, base_dir: &std::path::Path) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            // Skip special Next.js directories
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('_') || dir_name.starts_with('.') || dir_name == "api" {
                continue;
            }

            // Recursively scan subdirectories
            let mut sub_pages = scan_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name == "page.tsx" || file_name == "page.js" || file_name == "page.jsx" {
                // Calculate route from path
                let parent = path.parent().unwrap_or(&path);
                let relative = parent.strip_prefix(base_dir).unwrap_or(parent);
                let route = if relative.as_os_str().is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", relative.to_string_lossy().replace('\\', "/"))
                };

                // Handle dynamic routes - convert [param] to :param for display
                let display_route = route
                    .replace('[', ":")
                    .replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    // Sort pages alphabetically, with "/" first
    pages.sort_by(|a, b| {
        if a.route == "/" { return std::cmp::Ordering::Less; }
        if b.route == "/" { return std::cmp::Ordering::Greater; }
        a.route.cmp(&b.route)
    });

    Ok(pages)
}

#[tauri::command]
async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    if !marketingstack_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&marketingstack_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            // Check if it's a valid project (has package.json)
            if path.join("package.json").exists() {
                // Check for thumbnail
                let thumbnail_path = path.join(".marketingstack").join("thumbnail.png");
                let thumbnail = if thumbnail_path.exists() {
                    Some(thumbnail_path.to_string_lossy().to_string())
                } else {
                    None
                };

                // Read last_opened from project metadata
                let metadata_path = path.join(".marketingstack").join("project.json");
                let last_opened = if metadata_path.exists() {
                    std::fs::read_to_string(&metadata_path)
                        .ok()
                        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
                        .and_then(|m| m.last_opened)
                } else {
                    None
                };

                projects.push(ProjectInfo {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    thumbnail,
                    last_opened,
                });
            }
        }
    }

    // Sort by last_opened (most recent first), then by name for projects never opened
    projects.sort_by(|a, b| {
        match (a.last_opened, b.last_opened) {
            (Some(a_time), Some(b_time)) => b_time.cmp(&a_time), // Most recent first
            (Some(_), None) => std::cmp::Ordering::Less, // Opened projects come first
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.cmp(&b.name), // Alphabetical for never-opened
        }
    });

    Ok(projects)
}

/// Enhanced project info for dashboard display
#[derive(Serialize)]
struct DashboardProject {
    name: String,
    path: String,
    thumbnail: Option<String>,
    last_opened: Option<u64>,
    /// Current git branch name
    git_branch: Option<String>,
    /// Number of uncommitted changes (staged + unstaged)
    uncommitted_count: Option<u32>,
    /// Production URL from Vercel
    production_url: Option<String>,
    /// Relative time string for last deployment (e.g., "2h ago")
    last_deployed: Option<String>,
    /// Deployment state: READY, BUILDING, ERROR, QUEUED, CANCELED
    deployment_state: Option<String>,
}

/// Helper to get git branch for a project
fn get_git_branch(project_path: &std::path::Path) -> Option<String> {
    let git_dir = project_path.join(".git");
    if !git_dir.exists() {
        return None;
    }

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(project_path)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() && branch != "HEAD" {
            return Some(branch);
        }
    }
    None
}

/// Helper to count uncommitted changes (tracked files only)
fn get_uncommitted_count(project_path: &std::path::Path) -> Option<u32> {
    let git_dir = project_path.join(".git");
    if !git_dir.exists() {
        return None;
    }

    // Use -uno to ignore untracked files like .DS_Store
    let output = Command::new("git")
        .args(["status", "--porcelain", "-uno"])
        .current_dir(project_path)
        .output()
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let count = stdout.lines().filter(|l| !l.trim().is_empty()).count() as u32;
        return Some(count);
    }
    None
}

/// Helper to format relative time
fn format_relative_time(timestamp_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let diff_ms = now.saturating_sub(timestamp_ms);
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

/// Helper to get Vercel deployment info for a project
/// Only returns data that was explicitly saved - never guesses or constructs URLs
fn get_vercel_deployment_info(project_path: &std::path::Path) -> (Option<String>, Option<String>, Option<String>) {
    // Only read from project metadata where we saved actual publish records
    let metadata_path = project_path.join(".marketingstack").join("project.json");
    if metadata_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&metadata_path) {
            if let Ok(metadata) = serde_json::from_str::<ProjectMetadata>(&contents) {
                // Try production first, then staging
                if let Some(prod) = metadata.publish.production {
                    // Only return if we have a real URL (not empty)
                    if !prod.url.is_empty() {
                        return (
                            Some(prod.url),
                            Some(format_relative_time(prod.published_at)),
                            Some(prod.state),
                        );
                    }
                }
                if let Some(staging) = metadata.publish.staging {
                    if !staging.url.is_empty() {
                        return (
                            Some(staging.url),
                            Some(format_relative_time(staging.published_at)),
                            Some(staging.state),
                        );
                    }
                }
            }
        }
    }

    // No reliable data - return nothing rather than guess
    (None, None, None)
}

/// Returns enhanced project list for dashboard with git/vercel info
#[tauri::command]
async fn get_dashboard_projects() -> Result<Vec<DashboardProject>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    if !marketingstack_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&marketingstack_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            // Check if it's a valid project (has package.json)
            if path.join("package.json").exists() {
                // Check for thumbnail
                let thumbnail_path = path.join(".marketingstack").join("thumbnail.png");
                let thumbnail = if thumbnail_path.exists() {
                    Some(thumbnail_path.to_string_lossy().to_string())
                } else {
                    None
                };

                // Read last_opened from project metadata
                let metadata_path = path.join(".marketingstack").join("project.json");
                let last_opened = if metadata_path.exists() {
                    std::fs::read_to_string(&metadata_path)
                        .ok()
                        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
                        .and_then(|m| m.last_opened)
                } else {
                    None
                };

                // Ensure .marketingstack/ is gitignored (fixes ghost changes for existing projects)
                let _ = ensure_gitignore_has_marketingstack_sync(&path);

                // Get git info
                let git_branch = get_git_branch(&path);
                let uncommitted_count = get_uncommitted_count(&path);

                // Get Vercel deployment info
                let (production_url, last_deployed, deployment_state) = get_vercel_deployment_info(&path);

                projects.push(DashboardProject {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    thumbnail,
                    last_opened,
                    git_branch,
                    uncommitted_count,
                    production_url,
                    last_deployed,
                    deployment_state,
                });
            }
        }
    }

    // Sort by last_opened (most recent first), then by name for projects never opened
    projects.sort_by(|a, b| {
        match (a.last_opened, b.last_opened) {
            (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.cmp(&b.name),
        }
    });

    Ok(projects)
}

/// Crop an image and save it to the project's screenshots folder
/// Takes the source image path, crop bounds (x, y, width, height), and returns the saved path
#[tauri::command]
async fn crop_and_save_screenshot(
    project_path: String,
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".marketingstack").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let screenshot_path = screenshots_dir.join(format!("screenshot-{}.png", timestamp));
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Load the source image
    let img = image::open(&source_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    // Crop the image (ensure bounds are within image dimensions)
    let img_width = img.width();
    let img_height = img.height();

    let crop_x = x.min(img_width.saturating_sub(1));
    let crop_y = y.min(img_height.saturating_sub(1));
    let crop_width = width.min(img_width.saturating_sub(crop_x));
    let crop_height = height.min(img_height.saturating_sub(crop_y));

    let cropped = img.crop_imm(crop_x, crop_y, crop_width, crop_height);

    // Save the cropped image
    cropped
        .save(&screenshot_path)
        .map_err(|e| format!("Failed to save cropped image: {}", e))?;

    // Clean up the source temp file
    let _ = std::fs::remove_file(&source_path);

    Ok(screenshot_path_str)
}

#[tauri::command]
async fn capture_project_thumbnail(project_path: String, url: String) -> Result<String, String> {
    let project = validate_project_path(&project_path)?;
    let marketingstack_dir = project.join(".marketingstack");

    // Ensure .marketingstack directory exists
    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir).map_err(|e| e.to_string())?;
    }

    let thumbnail_path = marketingstack_dir.join("thumbnail.png");
    let thumbnail_path_str = thumbnail_path.to_string_lossy().to_string();

    // Try using Playwright first (more reliable viewport control)
    let npx_result = Command::new("npx")
        .args([
            "playwright",
            "screenshot",
            "--viewport-size=1280,800",
            "--wait-for-timeout=2000",
            &url,
            &thumbnail_path_str,
        ])
        .current_dir(&project)
        .output();

    if let Ok(output) = npx_result {
        if output.status.success() && thumbnail_path.exists() {
            // Resize to thumbnail width
            let _ = Command::new("sips")
                .args(["--resampleWidth", "640", &thumbnail_path_str])
                .output();
            return Ok(thumbnail_path_str);
        }
    }

    // Fall back to Chrome CLI if Playwright not available
    let chrome_paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];

    let chrome_path = chrome_paths.iter().find(|p| std::path::Path::new(p).exists());

    if let Some(browser) = chrome_path {
        // Use a temp file for raw capture, then process
        let temp_path = marketingstack_dir.join("thumbnail_raw.png");
        let temp_path_str = temp_path.to_string_lossy().to_string();
        let screenshot_arg = format!("--screenshot={}", temp_path_str);

        // Use new headless mode with explicit viewport control
        // Set background to white so any extra captured area isn't black
        let output = Command::new(browser)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                "--default-background-color=FFFFFFFF",
                "--window-position=0,0",
                "--window-size=1280,800",
                "--virtual-time-budget=3000",
                &screenshot_arg,
                &url,
            ])
            .output()
            .map_err(|e| format!("Failed to run browser: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Browser screenshot failed: {}", stderr));
        }

        // Get actual image dimensions
        let size_output = Command::new("sips")
            .args(["-g", "pixelWidth", "-g", "pixelHeight", &temp_path_str])
            .output()
            .map_err(|e| format!("Failed to get image size: {}", e))?;

        let size_str = String::from_utf8_lossy(&size_output.stdout);
        let mut width = 1280u32;
        let mut height = 800u32;

        for line in size_str.lines() {
            if line.contains("pixelWidth") {
                if let Some(w) = line.split_whitespace().last() {
                    width = w.parse().unwrap_or(1280);
                }
            } else if line.contains("pixelHeight") {
                if let Some(h) = line.split_whitespace().last() {
                    height = h.parse().unwrap_or(800);
                }
            }
        }

        // If captured at 2x (Retina), scale down to 1280x800 first
        // The content is correct, just at 2x resolution
        if width >= 2560 && height >= 1600 {
            // Scale down from 2x to 1x
            let _ = Command::new("sips")
                .args([
                    "--resampleWidth", "1280",
                    &temp_path_str,
                    "--out", &thumbnail_path_str,
                ])
                .output();
        } else if width > 1280 || height > 800 {
            // Unexpected size - resize to fit 1280 width
            let _ = Command::new("sips")
                .args([
                    "--resampleWidth", "1280",
                    &temp_path_str,
                    "--out", &thumbnail_path_str,
                ])
                .output();
        } else {
            // Already correct size, just copy
            let _ = std::fs::copy(&temp_path, &thumbnail_path);
        }

        // Clean up temp file
        let _ = std::fs::remove_file(&temp_path);

        // Resize to thumbnail width (640)
        let _ = Command::new("sips")
            .args(["--resampleWidth", "640", &thumbnail_path_str])
            .output();

        Ok(thumbnail_path_str)
    } else {
        Err("No supported browser found for screenshots (Chrome, Chromium, or Edge required)".to_string())
    }
}

#[tauri::command]
async fn get_project_thumbnail(project_path: String) -> Result<Option<String>, String> {
    let project = validate_project_path(&project_path)?;
    let thumbnail_path = project.join(".marketingstack").join("thumbnail.png");

    if thumbnail_path.exists() {
        // Return as base64 data URL for easy display
        use base64::Engine;
        let data = std::fs::read(&thumbnail_path).map_err(|e| e.to_string())?;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
        Ok(Some(format!("data:image/png;base64,{}", base64_data)))
    } else {
        Ok(None)
    }
}

// ============ Claude Integration ============

#[derive(Serialize)]
struct ClaudeCliStatus {
    installed: bool,
    version: Option<String>,
}

fn find_claude_binary() -> Option<std::path::PathBuf> {
    // First try which
    if let Ok(path) = which::which("claude") {
        return Some(path);
    }

    // Check common npm global bin locations
    if let Some(home) = dirs::home_dir() {
        let common_paths = vec![
            home.join(".npm-global/bin/claude"),
            home.join(".nvm/versions/node").join("*").join("bin/claude"), // NVM
            home.join("n/bin/claude"), // n version manager
            std::path::PathBuf::from("/usr/local/bin/claude"),
            std::path::PathBuf::from("/opt/homebrew/bin/claude"),
        ];

        for path in common_paths {
            if path.exists() {
                return Some(path);
            }
        }

        // Check npm prefix
        if let Ok(output) = Command::new("npm")
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

    None
}

#[tauri::command]
async fn check_claude_cli_status() -> ClaudeCliStatus {
    // Check if claude CLI is installed
    let claude_path = find_claude_binary();

    if claude_path.is_none() {
        return ClaudeCliStatus {
            installed: false,
            version: None,
        };
    }

    let claude_path = claude_path.unwrap();

    // Get version
    let version = Command::new(&claude_path)
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
async fn install_claude_cli() -> Result<(), String> {
    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("claude");
        return Ok(());
    }

    // Install Claude Code via official installer script
    let output = Command::new("bash")
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

// ============ Vercel Integration ============

#[derive(Serialize)]
struct VercelCliStatus {
    installed: bool,
    authenticated: bool,
}

fn find_vercel_binary() -> Option<std::path::PathBuf> {
    // First try which
    if let Ok(path) = which::which("vercel") {
        return Some(path);
    }

    // Check common npm global bin locations
    if let Some(home) = dirs::home_dir() {
        let common_paths = vec![
            home.join(".npm-global/bin/vercel"),
            home.join(".nvm/versions/node").join("*").join("bin/vercel"),
            home.join("n/bin/vercel"),
            std::path::PathBuf::from("/usr/local/bin/vercel"),
            std::path::PathBuf::from("/opt/homebrew/bin/vercel"),
        ];

        for path in common_paths {
            if path.exists() {
                return Some(path);
            }
        }

        // Check npm prefix
        if let Ok(output) = Command::new("npm")
            .args(["prefix", "-g"])
            .env("PATH", get_extended_path())
            .output()
        {
            if output.status.success() {
                let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let vercel_path = std::path::PathBuf::from(&prefix).join("bin/vercel");
                if vercel_path.exists() {
                    return Some(vercel_path);
                }
            }
        }
    }

    None
}

fn get_vercel_command() -> Command {
    let mut cmd = if let Some(path) = find_vercel_binary() {
        Command::new(path)
    } else {
        // Fallback to system PATH
        Command::new("vercel")
    };
    // Ensure extended PATH is available for any child processes
    cmd.env("PATH", get_extended_path());
    cmd
}

#[tauri::command]
async fn install_vercel_cli() -> Result<(), String> {
    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("vercel");
        return Ok(());
    }

    // Install Vercel CLI globally via npm
    let output = Command::new("npm")
        .args(["install", "-g", "vercel"])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install Vercel CLI: {}", stderr));
    }

    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeployToVercelOptions {
    project_path: String,
    project_name: String,
    github_repo: Option<String>,
}

#[tauri::command]
async fn deploy_to_vercel(options: DeployToVercelOptions) -> Result<String, String> {
    let validated_path = validate_project_path(&options.project_path)?;
    let project_name = &options.project_name;

    eprintln!("Starting Vercel deployment for {} at {:?}", project_name, validated_path);

    // Step 1: Link the project to Vercel (creates project if doesn't exist)
    // Using --yes to skip prompts, --project to set the name
    let link_output = get_vercel_command()
        .args(["link", "--yes", "--project", project_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| format!("Failed to run vercel link: {}", e))?;

    eprintln!("Link output status: {}", link_output.status);
    eprintln!("Link stdout: {}", String::from_utf8_lossy(&link_output.stdout));
    eprintln!("Link stderr: {}", String::from_utf8_lossy(&link_output.stderr));

    if !link_output.status.success() {
        let stderr = String::from_utf8_lossy(&link_output.stderr);
        let stdout = String::from_utf8_lossy(&link_output.stdout);
        return Err(format!("Failed to link project to Vercel: {} {}", stderr, stdout));
    }

    // Step 2: If GitHub repo is provided, connect it for auto-deploy on future pushes
    if let Some(github_repo) = &options.github_repo {
        let github_url = format!("https://github.com/{}", github_repo);
        let connect_output = get_vercel_command()
            .args(["git", "connect", &github_url, "--yes"])
            .current_dir(&validated_path)
            .output();

        if let Ok(output) = connect_output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{}{}", stdout, stderr);
            eprintln!("Git connect output: {}", combined);
            // Only warn if it's not "already connected"
            if !output.status.success() && !combined.contains("already connected") {
                eprintln!("Warning: Failed to connect Vercel to GitHub: {}", stderr);
            }
        }
    }

    // Step 3: Deploy to production - this builds and deploys the project
    // This is the main step that actually makes the site live
    eprintln!("Starting production deployment...");
    let deploy_output = get_vercel_command()
        .args(["--prod", "--yes"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| format!("Failed to run vercel --prod: {}", e))?;

    eprintln!("Deploy output status: {}", deploy_output.status);
    eprintln!("Deploy stdout: {}", String::from_utf8_lossy(&deploy_output.stdout));
    eprintln!("Deploy stderr: {}", String::from_utf8_lossy(&deploy_output.stderr));

    if !deploy_output.status.success() {
        let stderr = String::from_utf8_lossy(&deploy_output.stderr);
        let stdout = String::from_utf8_lossy(&deploy_output.stdout);
        return Err(format!("Failed to deploy to Vercel: {} {}", stderr, stdout));
    }

    // Parse production URL from vercel --prod output
    // Output format includes lines like:
    // ✅  Production: https://your-project.vercel.app [copied to clipboard]
    // or just: https://your-project.vercel.app
    let stdout = String::from_utf8_lossy(&deploy_output.stdout);
    let production_url = stdout
        .lines()
        .find_map(|line| {
            // Look for HTTPS URL in the output
            if let Some(https_start) = line.find("https://") {
                // Extract URL - ends at whitespace, bracket, or end of line
                let url_part = &line[https_start..];
                let url_end = url_part
                    .find(|c: char| c.is_whitespace() || c == '[' || c == ']')
                    .unwrap_or(url_part.len());
                let url = &url_part[..url_end];
                // Only use production URLs, not inspect URLs
                if !url.contains("/deployments/") && !url.contains("vercel.com/") {
                    return Some(url.to_string());
                }
            }
            None
        })
        .unwrap_or_else(|| format!("https://{}.vercel.app", project_name));

    // Write the production URL to a marker file for reliable detection
    let vercel_dir = validated_path.join(".vercel");
    let url_file = vercel_dir.join("production_url");
    if let Err(e) = std::fs::write(&url_file, &production_url) {
        eprintln!("Warning: Failed to write production_url marker: {}", e);
    }

    Ok(production_url)
}

#[tauri::command]
async fn check_vercel_cli_status() -> VercelCliStatus {
    // Check if vercel CLI is installed (either in PATH or common npm locations)
    let installed = find_vercel_binary().is_some();

    if !installed {
        return VercelCliStatus {
            installed: false,
            authenticated: false,
        };
    }

    // Check if authenticated by running `vercel whoami`
    let authenticated = get_vercel_command()
        .args(["whoami"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);

    VercelCliStatus {
        installed,
        authenticated,
    }
}

#[tauri::command]
async fn get_vercel_username() -> Result<String, String> {
    let output = get_vercel_command()
        .args(["whoami"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to get Vercel username".to_string());
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(username)
}

/// Vercel connection status - verified against Vercel API
#[derive(Serialize)]
struct ProjectVercelStatus {
    /// "not-linked" | "not-git-connected" | "connected"
    status: String,
    /// Vercel project name
    project_name: Option<String>,
    /// Vercel org/team slug for dashboard URLs
    vercel_org: Option<String>,
    /// Production URL (shortest alias, could be custom domain)
    production_url: Option<String>,
    /// Staging URL (contains -git-staging-)
    staging_url: Option<String>,
}

/// Checks Vercel status by verifying with the Vercel CLI.
/// Asks Vercel directly instead of inferring from local files.
#[tauri::command]
async fn get_project_vercel_status(project_path: String) -> ProjectVercelStatus {
    let not_linked = ProjectVercelStatus {
        status: "not-linked".to_string(),
        project_name: None,
        vercel_org: None,
        production_url: None,
        staging_url: None,
    };

    // Validate path
    let project = match validate_project_path(&project_path) {
        Ok(p) => p,
        Err(_) => return not_linked,
    };

    let vercel_dir = project.join(".vercel");
    let project_json = vercel_dir.join("project.json");

    // Check if .vercel/project.json exists
    if !project_json.exists() {
        return not_linked;
    }

    // Read project.json to get project name
    let project_name = std::fs::read_to_string(&project_json)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| json.get("projectName").and_then(|v| v.as_str()).map(|s| s.to_string()));

    let project_name_str = match &project_name {
        Some(name) => name.clone(),
        None => return not_linked,
    };

    // Check if Vercel is connected to GitHub by running `vercel git connect --yes`
    // If already connected, output contains "already connected"
    let git_connect_output = get_vercel_command()
        .args(["git", "connect", "--yes"])
        .current_dir(&project)
        .output();

    let is_git_connected = match git_connect_output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let full_output = stdout + &stderr;
            full_output.contains("already connected")
        }
        Err(_) => false,
    };

    if !is_git_connected {
        return ProjectVercelStatus {
            status: "not-git-connected".to_string(),
            project_name,
            vercel_org: None,
            production_url: None,
            staging_url: None,
        };
    }

    // Get URLs from `vercel alias ls`
    let alias_output = get_vercel_command()
        .args(["alias", "ls"])
        .current_dir(&project)
        .output()
        .ok();

    let mut vercel_org: Option<String> = None;
    let mut staging_url: Option<String> = None;
    let mut production_url: Option<String> = None;
    let mut production_candidates: Vec<String> = Vec::new();

    if let Some(output) = alias_output {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let full_output = stdout + &stderr;

        // Extract org from "Fetching aliases under {org}"
        for line in full_output.lines() {
            if line.contains("Fetching aliases under ") {
                vercel_org = line.split("Fetching aliases under ").nth(1).map(|s| s.trim().to_string());
                break;
            }
        }

        // Parse alias table for URLs belonging to this project
        for line in full_output.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let url = parts[1];
                if url.starts_with(&format!("{}.", project_name_str))
                    || url.starts_with(&format!("{}-", project_name_str)) {
                    if url.contains("-git-staging-") {
                        if staging_url.is_none() {
                            staging_url = Some(url.to_string());
                        }
                    } else if !url.contains("-git-") {
                        production_candidates.push(url.to_string());
                    }
                }
            }
        }

        // Pick shortest production URL (likely custom domain or {project}.vercel.app)
        if !production_candidates.is_empty() {
            production_candidates.sort_by_key(|s| s.len());
            production_url = Some(production_candidates[0].clone());
        }
    }

    // If no staging URL from aliases, check vercel list for Preview deployments
    if staging_url.is_none() {
        let list_output = get_vercel_command()
            .args(["list"])
            .current_dir(&project)
            .output()
            .ok();

        if let Some(output) = list_output {
            // The deployment table is in STDERR, not STDOUT
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            // Look for Preview deployments (staging branch shows as "Preview" environment)
            for line in stderr.lines() {
                // Check if this line is a Preview deployment (not Production)
                if line.contains("Preview") && !line.contains("Production") {
                    // Extract the URL from the line
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    for part in parts {
                        if part.contains(".vercel.app") {
                            // Remove https:// prefix if present for consistency
                            let url = part.trim_start_matches("https://");
                            staging_url = Some(url.to_string());
                            break;
                        }
                    }
                    if staging_url.is_some() {
                        break;
                    }
                }
            }
        }
    }

    // Cache URLs to .marketingstack/project.json so dashboard can show deployment info
    if production_url.is_some() || staging_url.is_some() {
        let marketingstack_dir = project.join(".marketingstack");
        let metadata_path = marketingstack_dir.join("project.json");

        // Read existing metadata or create default
        let mut metadata = if metadata_path.exists() {
            std::fs::read_to_string(&metadata_path)
                .ok()
                .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
                .unwrap_or_default()
        } else {
            ProjectMetadata::default()
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Update production URL if we have one
        if let Some(ref url) = production_url {
            metadata.publish.production = Some(PublishRecord {
                url: url.clone(),
                state: "READY".to_string(),
                published_at: now,
            });
        }

        // Update staging URL if we have one
        if let Some(ref url) = staging_url {
            metadata.publish.staging = Some(PublishRecord {
                url: url.clone(),
                state: "READY".to_string(),
                published_at: now,
            });
        }

        // Ensure .marketingstack directory exists and write
        let _ = std::fs::create_dir_all(&marketingstack_dir);
        if let Ok(contents) = serde_json::to_string_pretty(&metadata) {
            let _ = std::fs::write(&metadata_path, contents);
        }
    }

    ProjectVercelStatus {
        status: "connected".to_string(),
        project_name,
        vercel_org,
        production_url,
        staging_url,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkToVercelOptions {
    project_path: String,
    github_repo: String, // e.g., "username/repo-name"
}

#[tauri::command]
async fn link_to_vercel(options: LinkToVercelOptions) -> Result<String, String> {
    let project_path = &options.project_path;
    let github_repo = &options.github_repo;

    // Step 1: Link the local project to Vercel
    // --yes skips prompts and uses defaults
    let link_output = get_vercel_command()
        .args(["link", "--yes"])
        .current_dir(project_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !link_output.status.success() {
        let stderr = String::from_utf8_lossy(&link_output.stderr);
        return Err(format!("Failed to link project to Vercel: {}", stderr));
    }

    // Step 2: Connect Vercel project to the GitHub repo
    // This enables automatic deployments on push
    let github_url = format!("https://github.com/{}", github_repo);
    let connect_output = get_vercel_command()
        .args(["git", "connect", &github_url, "--yes"])
        .current_dir(project_path)
        .output()
        .map_err(|e| e.to_string())?;

    // Check both stdout and stderr for "already connected" which is actually success
    let stdout = String::from_utf8_lossy(&connect_output.stdout);
    let stderr = String::from_utf8_lossy(&connect_output.stderr);
    let combined_output = format!("{}{}", stdout, stderr);

    if !connect_output.status.success() && !combined_output.contains("already connected") {
        eprintln!("Warning: Failed to connect Vercel to GitHub: {}", stderr);
    }

    // Step 3: Trigger initial production deployment
    // This is required for GitHub auto-deploy to start working
    let deploy_output = get_vercel_command()
        .args(["--prod", "--yes"])
        .current_dir(project_path)
        .output();

    // Try to parse the deployment URL from the output
    let mut deployed_url: Option<String> = None;
    if let Ok(output) = deploy_output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Look for URL in output (format: "Production: https://...")
        for line in stdout.lines() {
            if line.contains("Production:") || line.starts_with("https://") {
                if let Some(url) = line.split_whitespace().find(|s| s.starts_with("https://")) {
                    deployed_url = Some(url.to_string());
                    break;
                }
            }
        }
    }

    // Fallback: construct URL from repo name
    let url = deployed_url.unwrap_or_else(|| {
        let repo_name = github_repo.split('/').last().unwrap_or("project");
        format!("https://{}.vercel.app", repo_name)
    });

    // Save the URL to project metadata so dashboard shows it immediately
    let project = std::path::Path::new(project_path);
    let marketingstack_dir = project.join(".marketingstack");
    let metadata_path = marketingstack_dir.join("project.json");

    // Read existing metadata or create default
    let mut metadata: ProjectMetadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    // Update production publish record with the deployed URL
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    metadata.publish.production = Some(PublishRecord {
        url: url.clone(),
        state: "READY".to_string(),
        published_at: now,
    });

    // Ensure .marketingstack directory exists and write metadata
    let _ = std::fs::create_dir_all(&marketingstack_dir);
    if let Ok(contents) = serde_json::to_string_pretty(&metadata) {
        let _ = std::fs::write(&metadata_path, contents);
    }

    Ok(url)
}

// ============ GitHub Integration ============

/// Returns a Command for gh with extended PATH set
fn get_gh_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        Command::new(path)
    } else {
        Command::new("gh")
    };
    cmd.env("PATH", get_extended_path());
    cmd
}

#[derive(Serialize)]
struct GitHubCliStatus {
    installed: bool,
    authenticated: bool,
}

#[tauri::command]
async fn check_github_cli_status() -> GitHubCliStatus {
    // Check if gh CLI is installed
    let installed = find_executable("gh").is_some();

    if !installed {
        return GitHubCliStatus {
            installed: false,
            authenticated: false,
        };
    }

    // Check if authenticated
    let authenticated = get_gh_command()
        .args(["auth", "status"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);

    GitHubCliStatus {
        installed,
        authenticated,
    }
}

#[tauri::command]
async fn get_github_username() -> Result<String, String> {
    let output = get_gh_command()
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to get GitHub username".to_string());
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(username)
}

#[tauri::command]
async fn get_github_orgs() -> Result<Vec<String>, String> {
    // Get orgs where user can create repos
    let output = get_gh_command()
        .args(["api", "user/orgs", "--jq", ".[].login"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Return empty list if we can't get orgs (user might not have any)
        return Ok(vec![]);
    }

    let orgs: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(orgs)
}

/// GitHub connection status - verified against GitHub API
#[derive(Serialize)]
struct ProjectGitHubStatus {
    /// "not-a-repo" | "no-remote" | "connected"
    status: String,
    /// e.g., "username/repo-name" - only set if connected
    github_repo: Option<String>,
    /// e.g., "https://github.com/username/repo-name" - only set if connected
    github_url: Option<String>,
}

/// Checks GitHub status by verifying with the GitHub CLI.
/// Asks GitHub directly instead of inferring from local files.
#[tauri::command]
async fn get_project_github_status(project_path: String) -> ProjectGitHubStatus {
    let not_a_repo = ProjectGitHubStatus {
        status: "not-a-repo".to_string(),
        github_repo: None,
        github_url: None,
    };

    // Validate path
    let project = match validate_project_path(&project_path) {
        Ok(p) => p,
        Err(_) => return not_a_repo,
    };

    // Check if .git exists
    if !project.join(".git").exists() {
        return not_a_repo;
    }

    // Get remote URL
    let remote_output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&project)
        .output();

    let remote_url = match remote_output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => {
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
    };

    // Parse GitHub repo from remote URL (handles HTTPS and SSH)
    let github_repo = parse_github_repo(&remote_url);
    let github_repo = match github_repo {
        Some(repo) => repo,
        None => {
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
    };

    // Verify repo exists on GitHub using gh CLI
    let gh_output = get_gh_command()
        .args(["repo", "view", &github_repo, "--json", "url"])
        .current_dir(&project)
        .output();

    match gh_output {
        Ok(output) if output.status.success() => {
            // Parse the URL from JSON response
            let json_str = String::from_utf8_lossy(&output.stdout);
            let url = serde_json::from_str::<serde_json::Value>(&json_str)
                .ok()
                .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| format!("https://github.com/{}", github_repo));

            ProjectGitHubStatus {
                status: "connected".to_string(),
                github_repo: Some(github_repo),
                github_url: Some(url),
            }
        }
        _ => {
            // Remote configured but repo doesn't exist or no access
            ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            }
        }
    }
}

/// Parse "owner/repo" from a GitHub URL (HTTPS or SSH format)
fn parse_github_repo(url: &str) -> Option<String> {
    // HTTPS: https://github.com/owner/repo.git
    if let Some(start) = url.find("github.com/") {
        let rest = &url[start + 11..];
        let end = rest.find(".git").unwrap_or(rest.len());
        return Some(rest[..end].trim_end_matches('/').to_string());
    }
    // SSH: git@github.com:owner/repo.git
    if let Some(start) = url.find("github.com:") {
        let rest = &url[start + 11..];
        let end = rest.find(".git").unwrap_or(rest.len());
        return Some(rest[..end].trim_end_matches('/').to_string());
    }
    None
}

// ============ Git Helper Functions ============

/// Checks if there are uncommitted changes (staged or unstaged tracked files).
/// Use `-uno` to ignore untracked files.
fn git_has_uncommitted_changes(path: &std::path::Path) -> Result<bool, String> {
    let status = Command::new("git")
        .args(["status", "--porcelain", "-uno"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Checks if there are any changes (including untracked) in the working directory.
fn git_has_any_changes(path: &std::path::Path) -> Result<bool, String> {
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Stages all changes and commits with the given message.
/// Returns true if a commit was made, false if nothing to commit.
fn git_stage_and_commit(path: &std::path::Path, message: &str) -> Result<bool, String> {
    // Stage all changes
    let add_output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if !add_output.status.success() {
        return Err(String::from_utf8_lossy(&add_output.stderr).to_string());
    }

    // Check if there are staged changes to commit
    let has_changes = git_has_any_changes(path)?;

    if !has_changes {
        return Ok(false);
    }

    // Commit
    let commit_output = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if !commit_output.status.success() {
        return Err(String::from_utf8_lossy(&commit_output.stderr).to_string());
    }

    Ok(true)
}

#[tauri::command]
async fn init_git_repo(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Initialize git repo
    let output = Command::new("git")
        .args(["init"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Stage and commit all files
    git_stage_and_commit(&validated_path, "Initial commit from Marketingstack")?;

    Ok(())
}

#[tauri::command]
async fn check_git_has_changes(project_path: String) -> Result<bool, String> {
    let project = validate_project_path(&project_path)?;
    let git_dir = project.join(".git");

    // Not a git repo = no changes to track
    if !git_dir.exists() {
        return Ok(false);
    }

    // Check for uncommitted changes (staged or unstaged tracked files only)
    if git_has_uncommitted_changes(&project)? {
        return Ok(true);
    }

    // Check for unpushed commits
    let unpushed = Command::new("git")
        .args(["log", "@{u}..", "--oneline"])
        .current_dir(&project)
        .output();

    // If this fails (no upstream), check if there are any commits at all
    match unpushed {
        Ok(output) => {
            let has_unpushed = !String::from_utf8_lossy(&output.stdout).trim().is_empty();
            Ok(has_unpushed)
        }
        Err(_) => {
            // No upstream set, check if we have commits
            let commits = Command::new("git")
                .args(["log", "--oneline", "-1"])
                .current_dir(&project)
                .output()
                .map_err(|e| e.to_string())?;

            Ok(!String::from_utf8_lossy(&commits.stdout).trim().is_empty())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushToGitHubOptions {
    project_path: String,
    repo_name: String,
    is_private: bool,
}

#[tauri::command]
async fn push_to_github(options: PushToGitHubOptions) -> Result<String, String> {
    let validated_path = validate_project_path(&options.project_path)?;
    let repo_name = &options.repo_name;
    let visibility = if options.is_private { "--private" } else { "--public" };

    // Check if it's already a git repo, if not initialize
    let git_dir = validated_path.join(".git");
    if !git_dir.exists() {
        init_git_repo(options.project_path.clone()).await?;
    } else {
        // Make sure all changes are committed
        let _ = git_stage_and_commit(&validated_path, "Update from Marketingstack");
    }

    // Create GitHub repo and push
    let output = get_gh_command()
        .args([
            "repo", "create", repo_name,
            visibility,
            "--source", ".",
            "--remote", "origin",
            "--push",
        ])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    // Return the repo URL
    Ok(format!("https://github.com/{}", repo_name))
}

#[tauri::command]
async fn publish_to_github(project_path: String, commit_message: Option<String>) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    let message = commit_message.unwrap_or_else(|| "Update from Marketingstack".to_string());

    // Get current branch name
    let branch_output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
    let branch = if branch.is_empty() { "main".to_string() } else { branch };

    // Pull latest changes first (rebase to keep history clean)
    let pull_output = Command::new("git")
        .args(["pull", "--rebase", "origin", &branch])
        .current_dir(&validated_path)
        .output();

    // Ignore pull errors (might be first push, or no tracking branch yet)
    if let Ok(output) = pull_output {
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Only fail if it's not a "no tracking" or "couldn't find remote" error
            if !stderr.contains("no tracking")
                && !stderr.contains("Couldn't find remote ref")
                && !stderr.contains("There is no tracking information") {
                // Log but don't fail - we'll try to push anyway
            }
        }
    }

    // Stage all changes
    let output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Check if there are changes to commit
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let has_changes = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_changes {
        // Commit changes
        let output = Command::new("git")
            .args(["commit", "-m", &message])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    // Push to origin
    let output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Check if it's a "nothing to push" situation (which isn't really an error)
        if !stderr.contains("Everything up-to-date") {
            return Err(stderr.to_string());
        }
    }

    Ok(())
}

// ============ Publish to Staging/Production ============

#[derive(Serialize)]
struct PublishResult {
    url: String,
    state: String,
}

#[tauri::command]
async fn publish_to_staging(project_path: String) -> Result<PublishResult, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Stage and commit any changes
    let _ = git_stage_and_commit(&validated_path, "Update from Marketingstack");

    // Push to staging branch - Vercel auto-deploys via GitHub integration
    let push_output = Command::new("git")
        .args(["push", "-f", "origin", "HEAD:staging"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        if !stderr.contains("Everything up-to-date") {
            return Err(stderr.to_string());
        }
    }

    // Return success - Vercel will auto-deploy via GitHub integration
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

#[tauri::command]
async fn publish_to_production(project_path: String) -> Result<PublishResult, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Stage and commit any changes
    let _ = git_stage_and_commit(&validated_path, "Update from Marketingstack");

    // Push to main branch - Vercel auto-deploys to production via GitHub integration
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD:main"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        if !stderr.contains("Everything up-to-date") {
            return Err(stderr.to_string());
        }
    }

    // Return success - Vercel will auto-deploy via GitHub integration
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

#[derive(Serialize)]
struct VercelDeployment {
    uid: String,
    url: String,
    state: String,  // "READY", "BUILDING", "ERROR", "QUEUED", "CANCELED"
    target: Option<String>,  // "production" or null for preview
    created_at: u64,  // Unix timestamp in ms
}

#[derive(Serialize)]
struct VercelDeploymentStatus {
    staging: Option<VercelDeployment>,
    production: Option<VercelDeployment>,
    preview_url: Option<String>,
    production_url: Option<String>,
}

/// Parses a deployment line from `vercel list` output.
/// Format: "deployment-url  State  Age  Branch"
fn parse_deployment_line(line: &str) -> Option<(String, String, Option<String>)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    // First part should be URL (contains .vercel.app or is a domain)
    let first = parts[0];
    if !first.contains('.') {
        return None;
    }

    let url = if first.starts_with("https://") {
        first.to_string()
    } else {
        format!("https://{}", first)
    };

    // Find state - usually second column, one of: Ready, Building, Error, Queued, Canceled
    let state = parts.iter()
        .find(|&p| {
            let lower = p.to_lowercase();
            lower == "ready" || lower == "building" || lower == "error" ||
            lower == "queued" || lower == "canceled"
        })
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| "UNKNOWN".to_string());

    // Find branch - look for common branch names
    let branch = parts.iter()
        .find(|&p| *p == "main" || *p == "master" || *p == "staging" || *p == "preview")
        .map(|s| s.to_string());

    Some((url, state, branch))
}

#[tauri::command]
async fn get_vercel_deployments(project_path: String) -> Result<VercelDeploymentStatus, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Get all deployments (not just --prod) to see staging/preview too
    let output = get_vercel_command()
        .args(["list", "--limit", "10"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| format!("Failed to run vercel list: {}", e))?;

    // If not linked or error, return empty status
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not linked") || stderr.contains("No project found") || stderr.contains("Could not find") {
            return Ok(VercelDeploymentStatus {
                staging: None,
                production: None,
                preview_url: None,
                production_url: None,
            });
        }
        eprintln!("vercel list error: {}", stderr);
        return Ok(VercelDeploymentStatus {
            staging: None,
            production: None,
            preview_url: None,
            production_url: None,
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut staging_deployment: Option<VercelDeployment> = None;
    let mut production_deployment: Option<VercelDeployment> = None;
    let mut preview_url: Option<String> = None;
    let mut production_url: Option<String> = None;

    // Parse each line looking for deployments
    for line in stdout.lines() {
        // Skip header lines and empty lines
        if line.trim().is_empty() ||
           line.contains("Deployments") ||
           line.starts_with("─") ||
           line.contains("Age") && line.contains("Status") {
            continue;
        }

        if let Some((url, state, branch)) = parse_deployment_line(line) {
            let is_production = line.to_lowercase().contains("production") ||
                               branch.as_ref().map(|b| b == "main" || b == "master").unwrap_or(false);
            let is_staging = branch.as_ref().map(|b| b == "staging").unwrap_or(false);

            let deployment = VercelDeployment {
                uid: String::new(),
                url: url.clone(),
                state: state.clone(),
                target: if is_production { Some("production".to_string()) } else { None },
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            };

            // Take first (most recent) deployment for each target
            if is_production && production_deployment.is_none() {
                production_url = Some(url);
                production_deployment = Some(deployment);
            } else if is_staging && staging_deployment.is_none() {
                preview_url = Some(url);
                staging_deployment = Some(deployment);
            } else if staging_deployment.is_none() && !is_production {
                // Treat other deployments as staging/preview
                preview_url = Some(url);
                staging_deployment = Some(deployment);
            }
        }
    }

    Ok(VercelDeploymentStatus {
        staging: staging_deployment,
        production: production_deployment,
        preview_url,
        production_url,
    })
}

#[derive(Serialize)]
struct BranchStatus {
    local_changes: bool,
    staging_ahead: i32,   // Commits local is ahead of staging
    staging_behind: i32,  // Commits local is behind staging
    main_ahead: i32,      // Commits local is ahead of main
    main_behind: i32,     // Commits local is behind main
    staging_exists: bool,
}

#[tauri::command]
async fn get_branch_status(project_path: String) -> Result<BranchStatus, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Check for local changes (tracked files only)
    let local_changes = git_has_uncommitted_changes(&validated_path)?;

    // Fetch latest from origin (silently)
    let _ = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&validated_path)
        .output();

    // Check if staging branch exists on remote
    let staging_check = Command::new("git")
        .args(["ls-remote", "--heads", "origin", "staging"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let staging_exists = !String::from_utf8_lossy(&staging_check.stdout).trim().is_empty();

    // Get commits ahead/behind for staging
    let (staging_ahead, staging_behind) = if staging_exists {
        let output = Command::new("git")
            .args(["rev-list", "--left-right", "--count", "HEAD...origin/staging"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        let counts = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = counts.trim().split('\t').collect();
        if parts.len() == 2 {
            (
                parts[0].parse().unwrap_or(0),
                parts[1].parse().unwrap_or(0),
            )
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    // Get commits ahead/behind for main
    let output = Command::new("git")
        .args(["rev-list", "--left-right", "--count", "HEAD...origin/main"])
        .current_dir(&validated_path)
        .output();

    let (main_ahead, main_behind) = if let Ok(output) = output {
        let counts = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = counts.trim().split('\t').collect();
        if parts.len() == 2 {
            (
                parts[0].parse().unwrap_or(0),
                parts[1].parse().unwrap_or(0),
            )
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    Ok(BranchStatus {
        local_changes,
        staging_ahead,
        staging_behind,
        main_ahead,
        main_behind,
        staging_exists,
    })
}

/// Reset local changes to match a remote branch (staging or main/production)
#[tauri::command]
async fn reset_to_branch(project_path: String, branch: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Validate branch name
    let remote_branch = match branch.as_str() {
        "staging" => "origin/staging",
        "production" | "main" => "origin/main",
        _ => return Err("Invalid branch. Use 'staging' or 'production'.".to_string()),
    };

    // Fetch latest from remote first
    let fetch = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !fetch.status.success() {
        return Err("Failed to fetch from remote".to_string());
    }

    // Reset hard to the remote branch
    let reset = Command::new("git")
        .args(["reset", "--hard", remote_branch])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !reset.status.success() {
        let stderr = String::from_utf8_lossy(&reset.stderr);
        return Err(format!("Failed to reset: {}", stderr));
    }

    // Clean untracked files
    let clean = Command::new("git")
        .args(["clean", "-fd"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !clean.status.success() {
        // Non-fatal, just log it
        eprintln!("Warning: git clean failed");
    }

    Ok(())
}

// ============ Branch Management ============

/// Information about a git branch
#[derive(Serialize)]
struct BranchInfo {
    name: String,
    is_current: bool,
    is_remote: bool,
    is_default: bool,
    last_commit_date: u64,
    last_commit_author: String,
    ahead_of_main: i32,
    behind_main: i32,
}

/// Result of switching branches
#[derive(Serialize)]
struct SwitchResult {
    success: bool,
    stashed_changes: bool,
    error: Option<String>,
}

/// List all branches (local and remote) with metadata
#[tauri::command]
async fn list_branches(project_path: String) -> Result<Vec<BranchInfo>, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Fetch all remotes first
    let _ = Command::new("git")
        .args(["fetch", "--all", "--prune"])
        .current_dir(&validated_path)
        .output();

    // Get all branches (local and remote)
    let output = Command::new("git")
        .args(["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(committerdate:unix)|%(authorname)|%(HEAD)"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to list branches".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches: Vec<BranchInfo> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }

        let raw_name = parts[0].trim();
        // Skip HEAD entries and bare remote names
        if raw_name == "HEAD" || raw_name.contains("HEAD") || raw_name == "origin" {
            continue;
        }

        // Clean up remote branch names (origin/branch -> branch for display)
        let (name, is_remote) = if raw_name.starts_with("origin/") {
            (raw_name.strip_prefix("origin/").unwrap_or(raw_name).to_string(), true)
        } else {
            (raw_name.to_string(), false)
        };

        // Skip empty names or bare remote names
        if name.is_empty() || name == "origin" {
            continue;
        }

        // Skip if we've already seen this branch name (prefer local over remote)
        if seen_names.contains(&name) {
            continue;
        }
        seen_names.insert(name.clone());

        let is_current = parts[4].trim() == "*";
        let commit_date = parts[2].parse::<u64>().unwrap_or(0) * 1000; // Convert to ms
        let author = parts[3].to_string();
        let is_default = name == "main" || name == "master";

        // Get ahead/behind count relative to main
        let (ahead, behind) = get_ahead_behind(&validated_path, &name, "origin/main");

        branches.push(BranchInfo {
            name,
            is_current,
            is_remote,
            is_default,
            last_commit_date: commit_date,
            last_commit_author: author,
            ahead_of_main: ahead,
            behind_main: behind,
        });
    }

    // Sort: current first, then default branches, then by last commit date (newest first)
    branches.sort_by(|a, b| {
        if a.is_current != b.is_current {
            return b.is_current.cmp(&a.is_current);
        }
        if a.is_default != b.is_default {
            return b.is_default.cmp(&a.is_default);
        }
        b.last_commit_date.cmp(&a.last_commit_date)
    });

    Ok(branches)
}

/// Helper to get ahead/behind count between two refs
fn get_ahead_behind(path: &std::path::Path, branch: &str, compare_to: &str) -> (i32, i32) {
    let output = Command::new("git")
        .args(["rev-list", "--left-right", "--count", &format!("{}...{}", branch, compare_to)])
        .current_dir(path)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let counts = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = counts.trim().split('\t').collect();
            if parts.len() == 2 {
                (
                    parts[0].parse().unwrap_or(0),
                    parts[1].parse().unwrap_or(0),
                )
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    }
}

/// Get the current branch name
#[tauri::command]
async fn get_current_branch(project_path: String) -> Result<String, String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" {
        // Detached HEAD state - try to get branch from reflog
        return Err("Detached HEAD state".to_string());
    }

    Ok(branch)
}

/// Switch to a different branch
#[tauri::command]
async fn switch_branch(project_path: String, branch_name: String, auto_stash: bool) -> Result<SwitchResult, String> {
    let validated_path = validate_project_path(&project_path)?;
    let mut stashed = false;

    // Check for uncommitted changes
    let has_changes = git_has_any_changes(&validated_path)?;

    if has_changes && auto_stash {
        // Stash changes
        let stash_output = Command::new("git")
            .args(["stash", "push", "-m", "Auto-stash by Marketingstack"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if stash_output.status.success() {
            let stdout = String::from_utf8_lossy(&stash_output.stdout);
            // Only mark as stashed if something was actually stashed
            stashed = !stdout.contains("No local changes");
        }
    } else if has_changes && !auto_stash {
        return Ok(SwitchResult {
            success: false,
            stashed_changes: false,
            error: Some("Uncommitted changes. Please stash or commit them first.".to_string()),
        });
    }

    // Try to checkout the branch
    let checkout_output = Command::new("git")
        .args(["checkout", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        // If checkout failed and we stashed, try to pop the stash
        if stashed {
            let _ = Command::new("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output();
        }

        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Ok(SwitchResult {
            success: false,
            stashed_changes: false,
            error: Some(stderr.to_string()),
        });
    }

    // Pull latest changes from remote (especially important after merging PRs)
    let _ = Command::new("git")
        .args(["pull", "--ff-only"])
        .current_dir(&validated_path)
        .output();

    // Touch next.config file to trigger Next.js full rebuild
    // This forces the dev server to recompile with the new branch's files
    let config_files = ["next.config.js", "next.config.mjs", "next.config.ts"];
    for config in &config_files {
        let config_path = validated_path.join(config);
        if config_path.exists() {
            let _ = Command::new("touch")
                .arg(&config_path)
                .output();
            break;
        }
    }

    Ok(SwitchResult {
        success: true,
        stashed_changes: stashed,
        error: None,
    })
}

/// Discard all uncommitted changes in the working directory
#[tauri::command]
async fn discard_changes(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Discard changes to tracked files
    let checkout_output = Command::new("git")
        .args(["checkout", "."])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err(format!("Failed to discard changes: {}", stderr));
    }

    // Remove untracked files
    let clean_output = Command::new("git")
        .args(["clean", "-fd"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !clean_output.status.success() {
        let stderr = String::from_utf8_lossy(&clean_output.stderr);
        return Err(format!("Failed to clean untracked files: {}", stderr));
    }

    Ok(())
}

/// Create a new branch from a base branch
#[tauri::command]
async fn create_branch(project_path: String, branch_name: String, from_branch: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Validate branch name (no spaces, special chars, etc.)
    if branch_name.contains(' ') || branch_name.contains("..") || branch_name.starts_with('-') {
        return Err("Invalid branch name".to_string());
    }

    // Get the current branch name
    let current_branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let current_branch = String::from_utf8_lossy(&current_branch_output.stdout)
        .trim()
        .to_string();

    // If creating from the current branch, use HEAD to preserve local changes
    // This allows users to branch off with their uncommitted work
    let is_from_current = from_branch == current_branch ||
        from_branch == format!("origin/{}", current_branch);

    if is_from_current {
        // Create branch from current HEAD (preserves local changes)
        let output = Command::new("git")
            .args(["checkout", "-b", &branch_name])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr.to_string());
        }
    } else {
        // Creating from a different branch - fetch and use origin
        let _ = Command::new("git")
            .args(["fetch", "origin"])
            .current_dir(&validated_path)
            .output();

        let base_ref = if from_branch.starts_with("origin/") {
            from_branch
        } else {
            format!("origin/{}", from_branch)
        };

        let output = Command::new("git")
            .args(["checkout", "-b", &branch_name, &base_ref])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr.to_string());
        }
    }

    Ok(())
}

/// Fetch all branches from remotes
#[tauri::command]
async fn fetch_all_branches(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["fetch", "--all", "--prune"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to fetch: {}", stderr));
    }

    Ok(())
}

/// Pull latest changes from remote for current branch
#[tauri::command]
async fn git_pull(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["pull", "--ff-only"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to pull: {}", stderr));
    }

    Ok(())
}

/// Pull remote changes and merge (may result in conflicts)
/// This is called when the user wants to sync with remote after a push rejection
#[tauri::command]
async fn pull_and_merge(project_path: String, merge_branch: Option<String>) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // First fetch to ensure we have latest refs
    let _ = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&validated_path)
        .output();

    let output = if let Some(branch) = merge_branch {
        // Merge a specific branch (e.g., origin/main for PR conflict resolution)
        Command::new("git")
            .args(["merge", &format!("origin/{}", branch)])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?
    } else {
        // Pull without --ff-only to allow merges
        Command::new("git")
            .args(["pull", "--no-rebase"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    // Check for merge conflicts
    if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
        return Err(format!("MERGE_CONFLICT:{}", combined));
    }

    if !output.status.success() {
        return Err(format!("Failed to merge: {}", stderr));
    }

    Ok(())
}

/// Publish (push) the current branch to origin
#[tauri::command]
async fn publish_branch(project_path: String, commit_message: Option<String>) -> Result<PublishResult, String> {
    let validated_path = validate_project_path(&project_path)?;
    let message = commit_message.unwrap_or_else(|| "Updates from Marketingstack".to_string());

    // Get current branch name
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();

    // Stage all changes
    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output();

    // Check if there are changes to commit
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let has_changes = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_changes {
        // Commit changes
        let commit_output = Command::new("git")
            .args(["commit", "-m", &message])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !commit_output.status.success() {
            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            return Err(format!("Failed to commit: {}", stderr));
        }
    }

    // Push to origin
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Check for common errors
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            return Err(format!("PUSH_REJECTED:{}", stderr));
        }
        if stderr.contains("Permission denied") || stderr.contains("could not read Username") {
            return Err(format!("AUTH_ERROR:{}", stderr));
        }
        if !stderr.contains("Everything up-to-date") {
            return Err(stderr.to_string());
        }
    }

    // Return success
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

/// Delete a branch (local and optionally remote)
#[tauri::command]
async fn delete_branch(project_path: String, branch_name: String, delete_remote: bool) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Don't allow deleting main/master
    if branch_name == "main" || branch_name == "master" {
        return Err("Cannot delete the main branch".to_string());
    }

    // Get current branch to make sure we're not on it
    let current = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let current_branch = String::from_utf8_lossy(&current.stdout).trim().to_string();
    if current_branch == branch_name {
        return Err("Cannot delete the current branch. Switch to another branch first.".to_string());
    }

    // Delete local branch
    let local_output = Command::new("git")
        .args(["branch", "-D", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !local_output.status.success() {
        let stderr = String::from_utf8_lossy(&local_output.stderr);
        // Ignore if branch doesn't exist locally
        if !stderr.contains("not found") {
            return Err(stderr.to_string());
        }
    }

    // Delete remote branch if requested
    if delete_remote {
        let remote_output = Command::new("git")
            .args(["push", "origin", "--delete", &branch_name])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !remote_output.status.success() {
            let stderr = String::from_utf8_lossy(&remote_output.stderr);
            // Ignore if branch doesn't exist on remote
            if !stderr.contains("remote ref does not exist") {
                return Err(format!("Failed to delete remote branch: {}", stderr));
            }
        }
    }

    Ok(())
}

// ============ Pull Requests ============

/// Information about a pull request
#[derive(Serialize)]
struct PullRequestInfo {
    number: i32,
    title: String,
    head_ref: String,
    base_ref: String,
    author: String,
    state: String,
    mergeable: Option<bool>,
    url: String,
    created_at: String,
}

/// List pull requests for the repository
#[tauri::command]
async fn list_pull_requests(project_path: String) -> Result<Vec<PullRequestInfo>, String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = get_gh_command()
        .args([
            "pr", "list",
            "--json", "number,title,headRefName,baseRefName,author,state,mergeable,url,createdAt",
            "--limit", "20"
        ])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no pull requests") || stderr.contains("Could not") {
            return Ok(Vec::new());
        }
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: Vec<serde_json::Value> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse PR list: {}", e))?;

    let prs: Vec<PullRequestInfo> = json.iter().filter_map(|pr| {
        Some(PullRequestInfo {
            number: pr.get("number")?.as_i64()? as i32,
            title: pr.get("title")?.as_str()?.to_string(),
            head_ref: pr.get("headRefName")?.as_str()?.to_string(),
            base_ref: pr.get("baseRefName")?.as_str()?.to_string(),
            author: pr.get("author")?.get("login")?.as_str()?.to_string(),
            state: pr.get("state")?.as_str()?.to_string(),
            mergeable: pr.get("mergeable").and_then(|v| v.as_str()).map(|s| s == "MERGEABLE"),
            url: pr.get("url")?.as_str()?.to_string(),
            created_at: pr.get("createdAt")?.as_str()?.to_string(),
        })
    }).collect();

    Ok(prs)
}

/// Create a new pull request
#[tauri::command]
async fn create_pull_request(
    project_path: String,
    title: String,
    body: Option<String>,
    base: String,
) -> Result<String, String> {
    let validated_path = validate_project_path(&project_path)?;

    // --body is required when running non-interactively
    let body_str = body.unwrap_or_default();
    let args = vec!["pr", "create", "--title", &title, "--body", &body_str, "--base", &base];

    let output = get_gh_command()
        .args(&args)
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    // Output contains the PR URL
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(url)
}

/// Merge a pull request
#[tauri::command]
async fn merge_pull_request(project_path: String, pr_number: i32) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = get_gh_command()
        .args(["pr", "merge", &pr_number.to_string(), "--merge"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}

// ============ Merge Conflict Resolution ============

/// A single conflict block within a file
#[derive(Serialize)]
struct ConflictBlock {
    line_start: u32,
    line_end: u32,
    current_content: String,    // Between <<<<<<< and =======
    incoming_content: String,   // Between ======= and >>>>>>>
    context_before: String,     // 3 lines before conflict
    context_after: String,      // 3 lines after conflict
}

/// Information about a file with conflicts
#[derive(Serialize)]
struct ConflictedFile {
    file_path: String,
    is_binary: bool,
    conflicts: Vec<ConflictBlock>,
    ours_branch: String,
    theirs_branch: String,
}

/// Parse conflict markers from file content
fn parse_conflicts(content: &str, all_lines: &[&str]) -> (Vec<ConflictBlock>, String, String) {
    let mut conflicts = Vec::new();
    let mut ours_branch = String::new();
    let mut theirs_branch = String::new();

    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        // Look for conflict start marker
        if lines[i].starts_with("<<<<<<<") {
            let line_start = i as u32 + 1;

            // Extract branch name from marker (e.g., "<<<<<<< HEAD" or "<<<<<<< branch-name")
            if ours_branch.is_empty() {
                ours_branch = lines[i].trim_start_matches('<').trim().to_string();
                if ours_branch.is_empty() {
                    ours_branch = "current".to_string();
                }
            }

            let mut current_content = Vec::new();
            let mut incoming_content = Vec::new();
            let mut in_current = true;
            i += 1;

            while i < lines.len() {
                if lines[i].starts_with("=======") {
                    in_current = false;
                    i += 1;
                    continue;
                }
                if lines[i].starts_with(">>>>>>>") {
                    // Extract theirs branch name
                    if theirs_branch.is_empty() {
                        theirs_branch = lines[i].trim_start_matches('>').trim().to_string();
                        if theirs_branch.is_empty() {
                            theirs_branch = "incoming".to_string();
                        }
                    }
                    break;
                }

                if in_current {
                    current_content.push(lines[i]);
                } else {
                    incoming_content.push(lines[i]);
                }
                i += 1;
            }

            let line_end = i as u32 + 1;

            // Get context (3 lines before and after)
            let context_start = if line_start > 4 { line_start as usize - 4 } else { 0 };
            let context_end = std::cmp::min(line_end as usize + 3, all_lines.len());

            let context_before: String = if context_start < (line_start as usize - 1) {
                all_lines[context_start..(line_start as usize - 1)]
                    .iter()
                    .filter(|l| !l.starts_with("<<<<<<<"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                String::new()
            };

            let context_after: String = if (line_end as usize) < context_end {
                all_lines[(line_end as usize)..context_end]
                    .iter()
                    .filter(|l| !l.starts_with(">>>>>>>"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                String::new()
            };

            conflicts.push(ConflictBlock {
                line_start,
                line_end,
                current_content: current_content.join("\n"),
                incoming_content: incoming_content.join("\n"),
                context_before,
                context_after,
            });
        }
        i += 1;
    }

    (conflicts, ours_branch, theirs_branch)
}

/// Get information about all conflicted files in the repository
#[tauri::command]
async fn get_conflict_info(project_path: String) -> Result<Vec<ConflictedFile>, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Get list of files with unmerged changes
    let output = Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get conflicted files: {}", stderr));
    }

    let file_list = String::from_utf8_lossy(&output.stdout);
    let files: Vec<&str> = file_list.lines().filter(|l| !l.is_empty()).collect();

    let mut conflicted_files = Vec::new();

    for file in files {
        let file_path = validated_path.join(file);

        // Check if file is binary
        let is_binary = Command::new("git")
            .args(["diff", "--numstat", file])
            .current_dir(&validated_path)
            .output()
            .map(|out| {
                let stdout = String::from_utf8_lossy(&out.stdout);
                stdout.starts_with("-\t-")
            })
            .unwrap_or(false);

        if is_binary {
            conflicted_files.push(ConflictedFile {
                file_path: file.to_string(),
                is_binary: true,
                conflicts: Vec::new(),
                ours_branch: "current".to_string(),
                theirs_branch: "incoming".to_string(),
            });
            continue;
        }

        // Read file content and parse conflicts
        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let all_lines: Vec<&str> = content.lines().collect();
        let (conflicts, ours_branch, theirs_branch) = parse_conflicts(&content, &all_lines);

        if !conflicts.is_empty() {
            conflicted_files.push(ConflictedFile {
                file_path: file.to_string(),
                is_binary: false,
                conflicts,
                ours_branch,
                theirs_branch,
            });
        }
    }

    Ok(conflicted_files)
}

/// Resolve a single conflict in a file by choosing current or incoming content
#[tauri::command]
async fn resolve_conflict(
    project_path: String,
    file_path: String,
    conflict_index: u32,
    resolution: String,  // "current" or "incoming"
) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    let full_path = validated_path.join(&file_path);

    // Read the current file content
    let content = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    let mut i = 0;
    let mut current_conflict = 0;

    while i < lines.len() {
        if lines[i].starts_with("<<<<<<<") {
            if current_conflict == conflict_index {
                // Found the conflict to resolve
                let mut current_content = Vec::new();
                let mut incoming_content = Vec::new();
                let mut in_current = true;
                i += 1;

                while i < lines.len() {
                    if lines[i].starts_with("=======") {
                        in_current = false;
                        i += 1;
                        continue;
                    }
                    if lines[i].starts_with(">>>>>>>") {
                        break;
                    }

                    if in_current {
                        current_content.push(lines[i]);
                    } else {
                        incoming_content.push(lines[i]);
                    }
                    i += 1;
                }

                // Add the chosen resolution
                let chosen = if resolution == "current" {
                    &current_content
                } else {
                    &incoming_content
                };

                for line in chosen {
                    result.push(*line);
                }

                current_conflict += 1;
            } else {
                // Skip this conflict, keep it as-is
                result.push(lines[i]);
                current_conflict += 1;
            }
        } else {
            result.push(lines[i]);
        }
        i += 1;
    }

    // Write the modified content back
    let new_content = result.join("\n");
    // Preserve trailing newline if original had one
    let final_content = if content.ends_with('\n') {
        format!("{}\n", new_content)
    } else {
        new_content
    };

    std::fs::write(&full_path, final_content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // Check if there are any remaining conflicts in this file
    let updated_content = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read updated file: {}", e))?;

    let has_more_conflicts = updated_content.contains("<<<<<<<");

    // If no more conflicts, stage the file
    if !has_more_conflicts {
        let add_output = Command::new("git")
            .args(["add", &file_path])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("Failed to stage resolved file: {}", stderr));
        }
    }

    Ok(())
}

/// Abort the current merge and return to pre-merge state
#[tauri::command]
async fn abort_merge(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["merge", "--abort"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to abort merge: {}", stderr));
    }

    Ok(())
}

/// Complete the merge after all conflicts have been resolved
#[tauri::command]
async fn complete_merge(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Stage all changes
    let add_output = Command::new("git")
        .args(["add", "."])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("Failed to stage changes: {}", stderr));
    }

    // Create the merge commit
    let commit_output = Command::new("git")
        .args(["commit", "-m", "Resolved merge conflicts via Marketingstack"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        // Check if it's just "nothing to commit" which is fine
        if !stderr.contains("nothing to commit") {
            return Err(format!("Failed to create merge commit: {}", stderr));
        }
    }

    Ok(())
}

#[derive(Deserialize)]
struct SpawnPtyOptions {
    cwd: String,
    command: String,
    args: Vec<String>,
    #[allow(dead_code)]
    rows: u32,
    #[allow(dead_code)]
    cols: u32,
}

#[tauri::command]
async fn spawn_pty(app: tauri::AppHandle, options: SpawnPtyOptions) -> Result<u32, String> {
    let id = PTY_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let result = (|| -> Result<i32, String> {
            let mut child = Command::new(&options.command)
                .args(&options.args)
                .current_dir(&options.cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Read stdout in a thread
            let app_for_stdout = app_handle.clone();
            let stdout_handle = if let Some(stdout) = stdout {
                Some(std::thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            let _ = app_for_stdout.emit("pty-output", serde_json::json!({
                                "id": id,
                                "data": format!("{}\r\n", line)
                            }));
                        }
                    }
                }))
            } else {
                None
            };

            // Read stderr in a thread
            let app_for_stderr = app_handle.clone();
            let stderr_handle = if let Some(stderr) = stderr {
                Some(std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            let _ = app_for_stderr.emit("pty-output", serde_json::json!({
                                "id": id,
                                "data": format!("{}\r\n", line)
                            }));
                        }
                    }
                }))
            } else {
                None
            };

            // Wait for output threads
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }

            // Wait for process to exit
            let status = child.wait().map_err(|e| e.to_string())?;
            Ok(status.code().unwrap_or(-1))
        })();

        // Emit exit event
        let exit_code = result.unwrap_or(-1);
        let _ = app_handle.emit("pty-exit", serde_json::json!({
            "id": id,
            "code": exit_code
        }));
    });

    Ok(id)
}

/// Kill any process listening on a specific port
#[tauri::command]
async fn kill_port(port: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        // Use lsof to find the PID listening on the port, then kill it
        let output = Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.lines() {
                if let Ok(pid_num) = pid.trim().parse::<i32>() {
                    // Kill the process and its children
                    let _ = Command::new("kill")
                        .args(["-9", &pid_num.to_string()])
                        .output();
                }
            }
        }
    }

    #[cfg(not(unix))]
    {
        // Windows: use netstat and taskkill
        let _ = Command::new("cmd")
            .args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :{} ^| findstr LISTENING') do taskkill /F /PID %a", port)])
            .output();
    }

    // Give processes time to die
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    Ok(())
}

// ============ Setup/Onboarding ============

use std::collections::HashSet;

// Mock state for testing - tracks which items have been "installed" in debug mode
lazy_static::lazy_static! {
    static ref MOCK_INSTALLED: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
}

/// Check if we're in mock/debug mode
fn is_mock_mode() -> bool {
    std::env::var("MARKETINGSTACK_FORCE_SETUP").is_ok()
}

/// Mark an item as mock-installed (for testing)
fn mock_install(item_id: &str) {
    if let Ok(mut set) = MOCK_INSTALLED.lock() {
        set.insert(item_id.to_string());
    }
}

/// Check if an item is mock-installed
fn is_mock_installed(item_id: &str) -> bool {
    MOCK_INSTALLED.lock().map(|set| set.contains(item_id)).unwrap_or(false)
}

/// Individual setup item status
#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Error variant reserved for future use
enum SetupItemStatus {
    Ready,
    NotInstalled,
    NotAuthenticated,
    Error,
}

/// Individual setup item
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupItemInfo {
    id: String,
    friendly_name: String,
    status: SetupItemStatus,
    version: Option<String>,
    username: Option<String>,
    error_message: Option<String>,
}

/// Full setup status response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FullSetupStatus {
    all_ready: bool,
    items: Vec<SetupItemInfo>,
}

/// Check if Homebrew is installed
fn check_homebrew() -> (bool, Option<String>) {
    let paths = [
        std::path::PathBuf::from("/opt/homebrew/bin/brew"),
        std::path::PathBuf::from("/usr/local/bin/brew"),
    ];

    for path in paths {
        if path.exists() {
            // Get version
            let version = Command::new(&path)
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

/// Get Homebrew command
fn get_brew_command() -> Option<std::path::PathBuf> {
    let paths = [
        std::path::PathBuf::from("/opt/homebrew/bin/brew"),
        std::path::PathBuf::from("/usr/local/bin/brew"),
    ];
    paths.into_iter().find(|p| p.exists())
}

/// Get full setup status for all items
#[tauri::command]
async fn get_full_setup_status() -> FullSetupStatus {
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
            ("vercel", "Vercel CLI", Some("node")),
            ("vercel_auth", "Vercel Account", Some("vercel")),
        ];

        let mock_items: Vec<SetupItemInfo> = items.iter().map(|(id, name, dep)| {
            let is_ready = is_mock_installed(id);
            let dep_ready = dep.map(|d| is_mock_installed(d)).unwrap_or(true);
            let is_auth = id.ends_with("_auth");

            SetupItemInfo {
                id: id.to_string(),
                friendly_name: name.to_string(),
                status: if is_ready {
                    SetupItemStatus::Ready
                } else if !dep_ready {
                    SetupItemStatus::NotInstalled // Will show as blocked by frontend
                } else if is_auth {
                    SetupItemStatus::NotAuthenticated
                } else {
                    SetupItemStatus::NotInstalled
                },
                version: if is_ready && !is_auth { Some("mock-1.0.0".to_string()) } else { None },
                username: if is_ready && is_auth { Some("mock-user".to_string()) } else { None },
                error_message: None,
            }
        }).collect();

        let all_ready = mock_items.iter().all(|i| matches!(i.status, SetupItemStatus::Ready));
        return FullSetupStatus { all_ready, items: mock_items };
    }

    let mut items = Vec::new();

    // 1. Homebrew
    let (brew_installed, brew_version) = check_homebrew();
    items.push(SetupItemInfo {
        id: "homebrew".to_string(),
        friendly_name: "Package Manager".to_string(),
        status: if brew_installed { SetupItemStatus::Ready } else { SetupItemStatus::NotInstalled },
        version: brew_version,
        username: None,
        error_message: None,
    });

    // 2. Node.js
    let node_path = find_executable("node");
    let node_version = node_path.as_ref().and_then(|p| {
        Command::new(p).args(["--version"]).output().ok().and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
    });
    items.push(SetupItemInfo {
        id: "node".to_string(),
        friendly_name: "Node.js".to_string(),
        status: if node_path.is_some() { SetupItemStatus::Ready } else { SetupItemStatus::NotInstalled },
        version: node_version,
        username: None,
        error_message: None,
    });

    // 3. Git
    let git_path = find_executable("git");
    let git_version = git_path.as_ref().and_then(|p| {
        Command::new(p).args(["--version"]).output().ok().and_then(|o| {
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
        status: if git_path.is_some() { SetupItemStatus::Ready } else { SetupItemStatus::NotInstalled },
        version: git_version,
        username: None,
        error_message: None,
    });

    // 4. GitHub CLI
    let gh_path = find_executable("gh");
    let gh_version = gh_path.as_ref().and_then(|p| {
        Command::new(p).args(["--version"]).output().ok().and_then(|o| {
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
        status: if gh_path.is_some() { SetupItemStatus::Ready } else { SetupItemStatus::NotInstalled },
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

    // 6. Claude Code
    let claude_path = find_claude_binary();
    let claude_version = claude_path.as_ref().and_then(|p| {
        Command::new(p).args(["--version"]).output().ok().and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
    });
    items.push(SetupItemInfo {
        id: "claude".to_string(),
        friendly_name: "Claude Code".to_string(),
        status: if claude_path.is_some() { SetupItemStatus::Ready } else { SetupItemStatus::NotInstalled },
        version: claude_version,
        username: None,
        error_message: None,
    });

    // 7. Claude Auth - check if claude is authenticated
    // Claude Code stores session data in ~/.claude after OAuth login
    // If the directory exists with content, user has authenticated
    let claude_auth = if claude_path.is_some() {
        if let Some(home) = dirs::home_dir() {
            let claude_dir = home.join(".claude");
            // Check if .claude dir exists and has settings.json (created after first auth)
            claude_dir.exists() && claude_dir.join("settings.json").exists()
        } else {
            false
        }
    } else {
        false
    };
    items.push(SetupItemInfo {
        id: "claude_auth".to_string(),
        friendly_name: "Claude Account".to_string(),
        status: if claude_auth {
            SetupItemStatus::Ready
        } else if claude_path.is_some() {
            SetupItemStatus::NotAuthenticated
        } else {
            SetupItemStatus::NotInstalled
        },
        version: None,
        username: None,
        error_message: None,
    });

    // 8. Vercel CLI
    let vercel_path = find_vercel_binary();
    let vercel_version = vercel_path.as_ref().and_then(|p| {
        Command::new(p).args(["--version"]).output().ok().and_then(|o| {
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
        status: if vercel_path.is_some() { SetupItemStatus::Ready } else { SetupItemStatus::NotInstalled },
        version: vercel_version,
        username: None,
        error_message: None,
    });

    // 9. Vercel Auth
    let vercel_auth = if vercel_path.is_some() {
        get_vercel_command()
            .args(["whoami"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };
    let vercel_username = if vercel_auth {
        get_vercel_command()
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

    let all_ready = items.iter().all(|i| matches!(i.status, SetupItemStatus::Ready));

    FullSetupStatus { all_ready, items }
}

/// Install Homebrew
#[tauri::command]
async fn install_homebrew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "homebrew",
        "message": "Installing package manager..."
    }));

    // Mock mode: simulate installation
    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("homebrew");
        return Ok(());
    }

    // Run the Homebrew installer
    let output = Command::new("bash")
        .args(["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""])
        .env("NONINTERACTIVE", "1") // Skip prompts
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
async fn install_node_via_brew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "node",
        "message": "Installing Node.js..."
    }));

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("node");
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = Command::new(&brew)
        .args(["install", "node"])
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
async fn install_git_via_brew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "git",
        "message": "Installing Git..."
    }));

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("git");
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = Command::new(&brew)
        .args(["install", "git"])
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
async fn install_gh_via_brew(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "gh",
        "message": "Installing GitHub CLI..."
    }));

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("gh");
        return Ok(());
    }

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = Command::new(&brew)
        .args(["install", "gh"])
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install GitHub CLI: {}", stderr));
    }

    Ok(())
}

/// Start GitHub authentication (opens browser)
/// Returns a message to display to the user about the clipboard code
#[tauri::command]
async fn start_github_auth(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "gh_auth",
        "message": "Opening browser..."
    }));

    if is_mock_mode() {
        // Mock: simulate auth completing after 3 seconds
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("gh_auth");
        return Ok("Mock auth completed".to_string());
    }

    // Start gh auth login in the background - it will open the browser
    let gh_path = find_executable("gh").ok_or("GitHub CLI not installed")?;

    // Use --web to open browser for auth, --clipboard to copy the one-time code
    let child = Command::new(&gh_path)
        .args(["auth", "login", "--web", "--git-protocol", "https", "--clipboard"])
        .spawn()
        .map_err(|e| format!("Failed to start GitHub auth: {}", e))?;

    // Don't wait for the child - it runs in background and frontend will poll
    std::mem::forget(child);

    Ok("A code has been copied to your clipboard. Paste it in the browser to connect.".to_string())
}

/// Start Claude authentication
/// Claude Code opens browser for OAuth when run without authentication
#[tauri::command]
async fn start_claude_auth(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "claude_auth",
        "message": "Opening browser..."
    }));

    if is_mock_mode() {
        // Mock: simulate auth completing after 3 seconds
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("claude_auth");
        return Ok("Mock auth completed".to_string());
    }

    let claude_path = find_claude_binary().ok_or("Claude Code not installed")?;

    // Run claude --print with a simple prompt - if not authenticated,
    // it will open browser for OAuth. We run this in background and poll for auth.
    let child = Command::new(&claude_path)
        .args(["--print", "hello"])
        .spawn()
        .map_err(|e| format!("Failed to start Claude auth: {}", e))?;

    std::mem::forget(child);

    Ok("Browser opened. Log in to your Anthropic account to continue.".to_string())
}

/// Check if Claude is authenticated
/// Claude Code stores session data in ~/.claude after OAuth login
#[tauri::command]
async fn check_claude_auth_status() -> bool {
    // Mock mode: check mock state
    if is_mock_mode() {
        return is_mock_installed("claude_auth");
    }

    // First check if Claude is installed
    if find_claude_binary().is_none() {
        return false;
    }

    // Check if ~/.claude/settings.json exists (created after first auth)
    if let Some(home) = dirs::home_dir() {
        let settings_path = home.join(".claude").join("settings.json");
        return settings_path.exists();
    }

    false
}

/// Start Vercel authentication (opens browser)
#[tauri::command]
async fn start_vercel_auth(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit("setup-progress", serde_json::json!({
        "itemId": "vercel_auth",
        "message": "Opening browser..."
    }));

    if is_mock_mode() {
        // Mock: simulate auth completing after 3 seconds
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("vercel_auth");
        return Ok("Mock auth completed".to_string());
    }

    // Start vercel login - it opens browser for auth
    let child = get_vercel_command()
        .arg("login")
        .spawn()
        .map_err(|e| format!("Failed to start Vercel auth: {}", e))?;

    std::mem::forget(child);

    Ok("Browser opened. Log in to your Vercel account to continue.".to_string())
}

// Kill orphaned Claude processes spawned by this app
fn cleanup_claude_processes() {
    #[cfg(unix)]
    {
        use std::process::Command;
        // Find Claude processes that are children of Marketingstack and kill them
        // This handles orphaned processes from crashed dev sessions

        // Get current process's children and kill them
        let pid = std::process::id();
        let _ = Command::new("pkill")
            .args(["-P", &pid.to_string(), "claude"])
            .output();

        // Kill any orphaned claude processes (parent is init/launchd - PID 1)
        // These are left over from force-closed dev sessions
        let _ = Command::new("sh")
            .args(["-c", r#"
                # Find claude processes whose parent is PID 1 (orphaned)
                for pid in $(pgrep -x claude 2>/dev/null); do
                    ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                    if [ "$ppid" = "1" ]; then
                        kill $pid 2>/dev/null
                    fi
                done
            "#])
            .output();

        // Also kill orphaned node processes running next-server (from dev server)
        let _ = Command::new("sh")
            .args(["-c", r#"
                for pid in $(pgrep -f 'next-server' 2>/dev/null); do
                    ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                    if [ "$ppid" = "1" ]; then
                        kill $pid 2>/dev/null
                    fi
                done
            "#])
            .output();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Clean up any orphaned Claude processes from previous crashed sessions
    cleanup_claude_processes();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                cleanup_claude_processes();
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_prerequisites,
            get_marketingstack_dir,
            ensure_marketingstack_dir,
            list_projects,
            get_dashboard_projects,
            list_pages,
            check_sanity_installed,
            check_sanity_env_keys,
            // Project metadata
            read_project_metadata,
            write_project_metadata,
            mark_project_opened,
            get_branch_prefix_preference,
            set_branch_prefix_preference,
            ensure_gitignore_has_marketingstack,
            // Environment variables
            list_env_files,
            read_env_file,
            write_env_file,
            create_env_file,
            delete_env_file,
            check_ide_availability,
            open_in_ide,
            create_preview_webview,
            navigate_preview_webview,
            resize_preview_webview,
            destroy_preview_webview,
            open_studio_window,
            delete_project,
            capture_project_thumbnail,
            get_project_thumbnail,
            crop_and_save_screenshot,
            // Claude integration
            check_claude_cli_status,
            install_claude_cli,
            // Vercel integration
            check_vercel_cli_status,
            get_vercel_username,
            get_project_vercel_status,
            link_to_vercel,
            install_vercel_cli,
            deploy_to_vercel,
            // GitHub integration
            check_github_cli_status,
            get_github_username,
            get_github_orgs,
            get_project_github_status,
            check_git_has_changes,
            init_git_repo,
            push_to_github,
            publish_to_github,
            publish_to_staging,
            publish_to_production,
            get_vercel_deployments,
            get_branch_status,
            reset_to_branch,
            // Branch management
            list_branches,
            get_current_branch,
            switch_branch,
            discard_changes,
            create_branch,
            fetch_all_branches,
            git_pull,
            pull_and_merge,
            publish_branch,
            delete_branch,
            // Pull requests
            list_pull_requests,
            create_pull_request,
            merge_pull_request,
            // Merge conflict resolution
            get_conflict_info,
            resolve_conflict,
            abort_merge,
            complete_merge,
            spawn_pty,
            kill_port,
            // Setup/Onboarding
            get_full_setup_status,
            install_homebrew,
            install_node_via_brew,
            install_git_via_brew,
            install_gh_via_brew,
            start_github_auth,
            start_claude_auth,
            check_claude_auth_status,
            start_vercel_auth,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
