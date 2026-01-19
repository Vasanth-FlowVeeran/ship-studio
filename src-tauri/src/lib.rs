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
use tauri::Emitter;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Counter for generating unique PTY IDs
static PTY_ID_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Result of checking if a prerequisite tool is installed
#[derive(Serialize)]
struct PrerequisiteCheck {
    name: String,
    available: bool,
    path: Option<String>,
}

/// Checks if required tools (node, npm, git, claude) are installed.
/// Returns availability and path for each tool.
#[tauri::command]
async fn check_prerequisites() -> Vec<PrerequisiteCheck> {
    let commands = vec!["node", "npm", "git", "claude"];
    let mut results = Vec::new();

    for cmd in commands {
        let (available, path) = match which::which(cmd) {
            Ok(p) => (true, Some(p.to_string_lossy().to_string())),
            Err(_) => (false, None),
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
}

impl Default for ProjectMetadata {
    fn default() -> Self {
        ProjectMetadata {
            description: "Marketingstack project metadata. Auto-generated - safe to delete if needed, will be recreated.".to_string(),
            publish: PublishMetadata::default(),
            last_opened: None,
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
use tauri::{WebviewUrl, Manager, Webview};

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

    // Try Chrome first (most common), then Chromium, then Edge
    let chrome_paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];

    let chrome_path = chrome_paths.iter().find(|p| std::path::Path::new(p).exists());

    if let Some(browser) = chrome_path {
        let screenshot_arg = format!("--screenshot={}", thumbnail_path_str);
        // Use exact dimensions for consistent thumbnails
        // force-device-scale-factor=1 prevents Retina 2x capture
        let output = Command::new(browser)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                "--window-size=1280,800",
                &screenshot_arg,
                &url,
            ])
            .output()
            .map_err(|e| format!("Failed to run browser: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Browser screenshot failed: {}", stderr));
        }

        // Crop to exact viewport size from top-left, then resize for thumbnail
        // --cropOffset sets the crop origin (x, y from top-left)
        // -c crops to specified height width
        let _ = Command::new("sips")
            .args([
                "--cropOffset", "0", "0",
                "-c", "800", "1280",
                "--resampleWidth", "640",
                &thumbnail_path_str,
            ])
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

#[tauri::command]
async fn capture_preview_to_clipboard(project_path: String) -> Result<(), String> {
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

    // Use Playwright to capture localhost:3000 preview
    // Spawn in a NEW PROCESS GROUP to prevent signals from killing Claude Code
    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("npx");
        cmd.args([
            "playwright",
            "screenshot",
            "http://localhost:3000",
            &screenshot_path_str,
            "--viewport-size=1200,800",
        ]);
        cmd.process_group(0); // Create new process group
        cmd
    };

    #[cfg(not(unix))]
    let mut cmd = {
        let mut cmd = Command::new("npx");
        cmd.args([
            "playwright",
            "screenshot",
            "http://localhost:3000",
            &screenshot_path_str,
            "--viewport-size=1200,800",
        ]);
        cmd
    };

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn playwright: {}", e))?;
    let status = child.wait().map_err(|e| format!("Failed to wait for playwright: {}", e))?;

    if !status.success() {
        return Err("Playwright screenshot failed".to_string());
    }

    // Copy the image file to clipboard using osascript
    let copy_script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
        screenshot_path_str
    );
    let copy_output = Command::new("osascript")
        .args(["-e", &copy_script])
        .output()
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    if !copy_output.status.success() {
        let stderr = String::from_utf8_lossy(&copy_output.stderr);
        return Err(format!("Failed to copy to clipboard: {}", stderr));
    }

    Ok(())
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
        if let Ok(output) = Command::new("npm").args(["prefix", "-g"]).output() {
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
    // Install Claude Code globally via npm
    let output = Command::new("npm")
        .args(["install", "-g", "@anthropic-ai/claude-code"])
        .output()
        .map_err(|e| format!("Failed to run npm: {}", e))?;

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
        if let Ok(output) = Command::new("npm").args(["prefix", "-g"]).output() {
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
    if let Some(path) = find_vercel_binary() {
        Command::new(path)
    } else {
        // Fallback to system PATH
        Command::new("vercel")
    }
}

#[tauri::command]
async fn install_vercel_cli() -> Result<(), String> {
    // Install Vercel CLI globally via npm
    let output = Command::new("npm")
        .args(["install", "-g", "vercel"])
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
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Look for Preview deployments (staging branch shows as "Preview" environment)
            for line in stdout.lines() {
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
    if let Ok(output) = deploy_output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Look for URL in output (format: "Production: https://...")
        for line in stdout.lines() {
            if line.contains("Production:") || line.starts_with("https://") {
                if let Some(url) = line.split_whitespace().find(|s| s.starts_with("https://")) {
                    return Ok(url.to_string());
                }
            }
        }
    }

    // Fallback: construct URL from repo name
    let repo_name = github_repo.split('/').last().unwrap_or("project");
    Ok(format!("https://{}.vercel.app", repo_name))
}

// ============ GitHub Integration ============

#[derive(Serialize)]
struct GitHubCliStatus {
    installed: bool,
    authenticated: bool,
}

#[tauri::command]
async fn check_github_cli_status() -> GitHubCliStatus {
    // Check if gh CLI is installed
    let installed = which::which("gh").is_ok();

    if !installed {
        return GitHubCliStatus {
            installed: false,
            authenticated: false,
        };
    }

    // Check if authenticated
    let authenticated = Command::new("gh")
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
    let output = Command::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to get GitHub username".to_string());
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(username)
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
    let gh_output = Command::new("gh")
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

    // Stage all files
    let output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Create initial commit
    let output = Command::new("git")
        .args(["commit", "-m", "Initial commit from Marketingstack"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

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

    // Check for uncommitted changes (staged or unstaged)
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&project)
        .output()
        .map_err(|e| e.to_string())?;

    let has_uncommitted = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_uncommitted {
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
        let _ = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&validated_path)
            .output();

        let status = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !String::from_utf8_lossy(&status.stdout).trim().is_empty() {
            let _ = Command::new("git")
                .args(["commit", "-m", "Update from Marketingstack"])
                .current_dir(&validated_path)
                .output();
        }
    }

    // Create GitHub repo and push
    let output = Command::new("gh")
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
    eprintln!("publish_to_staging called with path: {}", project_path);
    let validated_path = validate_project_path(&project_path)?;
    let message = "Update from Marketingstack".to_string();

    // Stage all changes
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

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
    // The frontend polls getVercelDeployments to track deployment status
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

#[tauri::command]
async fn publish_to_production(project_path: String) -> Result<PublishResult, String> {
    eprintln!("publish_to_production called with path: {}", project_path);
    let validated_path = validate_project_path(&project_path)?;
    let message = "Update from Marketingstack".to_string();

    // Stage all changes
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

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
    // The frontend polls getVercelDeployments to track deployment status
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

    // Check for local changes
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let local_changes = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

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

        // Also kill any orphaned claude processes (parent is init/launchd - PID 1)
        // Note: Using grep -v to avoid killing if no matches (xargs on macOS doesn't have -r)
        let _ = Command::new("sh")
            .args(["-c", "ps -eo pid,ppid,comm | grep '[c]laude' | awk '$2 == 1 {print $1}' | xargs kill 2>/dev/null || true"])
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
            list_pages,
            check_sanity_installed,
            check_sanity_env_keys,
            // Project metadata
            read_project_metadata,
            write_project_metadata,
            mark_project_opened,
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
            capture_preview_to_clipboard,
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
            spawn_pty,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
