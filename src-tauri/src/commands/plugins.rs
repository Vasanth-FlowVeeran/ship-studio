/**
 * Plugin management commands for Ship Studio.
 *
 * Plugins are project-level: each project has its own plugins directory
 * at <project>/.shipstudio/plugins/.
 *
 * Provides commands for:
 * - Listing, installing, uninstalling, and updating plugins
 * - Reading plugin bundles (JS source) for frontend loading
 * - Executing shell commands in plugin context with sandboxing
 * - Plugin-scoped storage
 *
 * Plugin storage locations:
 * - Registry: {project}/.shipstudio/plugins/registry.json
 * - Plugin files: {project}/.shipstudio/plugins/{plugin-id}/ (plugin.json, dist/, icon.svg)
 * - Plugin data: {project}/.shipstudio/plugins/{plugin-id}/storage.json
 */
use crate::utils::{create_command, get_extended_path, validate_project_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

lazy_static::lazy_static! {
    /// Per-plugin storage locks to prevent concurrent read-modify-write races.
    /// Key: "project_path:plugin_id"
    static ref STORAGE_LOCKS: Mutex<HashMap<String, Arc<Mutex<()>>>> =
        Mutex::new(HashMap::new());
}

/// Acquire a lock for a specific plugin's storage file.
fn get_storage_lock(plugin_id: &str, project_path: &str) -> Arc<Mutex<()>> {
    let key = format!("{}:{}", project_path, plugin_id);
    let mut locks = STORAGE_LOCKS.lock().unwrap();
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Tauri commands that plugins are allowed to invoke via the invoke proxy.
/// Commands not in this list are rejected at runtime (PluginSlot.tsx)
/// and at install time (validate_required_commands).
const PLUGIN_INVOKABLE_COMMANDS: &[&str] = &[
    // Git read operations
    "check_git_has_changes",
    "get_changed_files",
    "get_file_diff",
    "get_branch_status",
    "list_branches",
    "get_current_branch",
    "get_stash_info",
    // Project read operations
    "list_projects",
    "list_pages",
    "read_project_metadata",
    "get_branch_prefix_preference",
    "get_auto_accept_mode",
    // Git write operations
    "commit_changes",
    "create_branch",
    "switch_branch",
    "fetch_all_branches",
    "git_pull",
    // IDE
    "check_ide_availability",
    "open_in_ide",
    "open_url_in_browser",
    // Preview webview
    "create_preview_webview",
    "resize_preview_webview",
    "destroy_preview_webview",
    "navigate_preview_webview",
    // Plugin self-management
    "read_plugin_storage",
    "write_plugin_storage",
    "read_plugin_manifest",
];

/// Warn if a plugin declares setup items (reserved, not yet implemented).
fn warn_on_setup_items(manifest: &PluginManifest) {
    if !manifest.setup.is_empty() {
        tracing::warn!(
            "Plugin '{}' declares {} setup item(s), but plugin setup is not yet implemented. \
             The 'setup' field is reserved for future use.",
            manifest.id,
            manifest.setup.len()
        );
    }
}

/// Validate that all required_commands in the manifest are in the allowed list.
fn validate_required_commands(manifest: &PluginManifest) -> Result<(), String> {
    let allowed: std::collections::HashSet<&str> =
        PLUGIN_INVOKABLE_COMMANDS.iter().copied().collect();
    let invalid: Vec<&str> = manifest
        .required_commands
        .iter()
        .map(|s| s.as_str())
        .filter(|cmd| !allowed.contains(cmd))
        .collect();

    if !invalid.is_empty() {
        return Err(format!(
            "Plugin '{}' requests commands that are not available to plugins: {}",
            manifest.id,
            invalid.join(", ")
        ));
    }
    Ok(())
}

/// Check that a plugin's min_app_version is satisfied by the current app version.
/// Returns Ok(()) if compatible, Err with a message if not.
fn check_min_app_version(manifest: &PluginManifest, app: &AppHandle) -> Result<(), String> {
    let min_ver_str = manifest.min_app_version.trim();
    if min_ver_str.is_empty() {
        return Ok(());
    }

    let min_ver = semver::Version::parse(min_ver_str).map_err(|e| {
        format!(
            "Invalid min_app_version '{}' in plugin manifest: {}",
            min_ver_str, e
        )
    })?;

    let app_ver_str = app.package_info().version.to_string();
    let app_ver = semver::Version::parse(&app_ver_str)
        .map_err(|e| format!("Failed to parse app version '{}': {}", app_ver_str, e))?;

    if app_ver < min_ver {
        return Err(format!(
            "Plugin '{}' requires Ship Studio v{} or later (current: v{}). Please update Ship Studio.",
            manifest.name, min_ver, app_ver
        ));
    }

    Ok(())
}

/// Plugin manifest from plugin.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginManifest {
    /// Unique plugin identifier (e.g., "hello-world")
    pub id: String,
    /// Display name
    pub name: String,
    /// Plugin version (semver)
    pub version: String,
    /// Short description
    pub description: String,
    /// UI slots this plugin renders into
    #[serde(default)]
    pub slots: Vec<String>,
    /// Plugin author
    #[serde(default)]
    pub author: String,
    /// Source repository URL
    #[serde(default)]
    pub repository: String,
    /// Setup items this plugin contributes to onboarding
    #[serde(default)]
    pub setup: Vec<PluginSetupItem>,
    /// Minimum Ship Studio version required
    #[serde(default)]
    pub min_app_version: String,
    /// Icon filename (relative to plugin dir)
    #[serde(default)]
    pub icon: String,
    /// Tauri commands this plugin is allowed to invoke
    #[serde(default)]
    pub required_commands: Vec<String>,
    /// Plugin API version. 0 = legacy/unversioned, 1 = first stable version.
    #[serde(default)]
    pub api_version: u32,
}

/// A setup item contributed by a plugin
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginSetupItem {
    /// Item identifier (will be prefixed with plugin id)
    pub id: String,
    /// Display label
    pub label: String,
    /// IDs of items this depends on
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Shell command to check if ready
    #[serde(default)]
    pub check_command: String,
    /// Shell command to install
    #[serde(default)]
    pub install_command: String,
}

/// Plugin info returned to frontend (manifest + registry state)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginInfo {
    /// Plugin manifest data
    pub manifest: PluginManifest,
    /// Whether the plugin is enabled
    pub enabled: bool,
    /// When the plugin was installed (Unix ms)
    pub installed_at: u64,
    /// Source repository URL used for install
    pub source_url: String,
    /// Whether this is a dev-linked plugin
    #[serde(default)]
    pub is_dev: bool,
    /// Local filesystem path for dev plugins
    #[serde(default)]
    pub local_path: String,
}

/// Registry entry stored in registry.json
#[derive(Debug, Serialize, Deserialize, Clone)]
struct RegistryEntry {
    plugin_id: String,
    enabled: bool,
    installed_at: u64,
    source_url: String,
    /// Git commit hash at time of install/update (for update checking)
    #[serde(default)]
    installed_commit: String,
    /// Whether this is a dev-linked plugin
    #[serde(default)]
    is_dev: bool,
    /// Local filesystem path for dev plugins
    #[serde(default)]
    local_path: String,
}

/// Result of checking for a plugin update
#[derive(Debug, Serialize, Clone)]
pub struct PluginUpdateCheck {
    pub has_update: bool,
    pub installed_version: String,
    pub installed_commit: String,
    pub remote_commit: String,
}

/// The registry file format
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct Registry {
    plugins: Vec<RegistryEntry>,
}

/// Result of a shell command execution
#[derive(Debug, Serialize, Clone)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Get the plugins directory for a project: <project>/.shipstudio/plugins/
fn get_plugins_dir(project_path: &str) -> Result<PathBuf, String> {
    let validated = validate_project_path(project_path)?;
    Ok(validated.join(".shipstudio").join("plugins"))
}

/// Read the plugin registry for a project
fn read_registry(project_path: &str) -> Result<Registry, String> {
    let plugins_dir = get_plugins_dir(project_path)?;
    let registry_path = plugins_dir.join("registry.json");

    if !registry_path.exists() {
        return Ok(Registry::default());
    }

    let content = fs::read_to_string(&registry_path)
        .map_err(|e| format!("Failed to read registry: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse registry: {}", e))
}

/// Write the plugin registry for a project
fn write_registry(project_path: &str, registry: &Registry) -> Result<(), String> {
    let plugins_dir = get_plugins_dir(project_path)?;
    fs::create_dir_all(&plugins_dir).map_err(|e| format!("Failed to create plugins dir: {}", e))?;

    let registry_path = plugins_dir.join("registry.json");
    let content = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialize registry: {}", e))?;

    fs::write(&registry_path, content).map_err(|e| format!("Failed to write registry: {}", e))
}

/// Read a plugin's manifest from its directory
fn read_manifest(plugin_dir: &PathBuf) -> Result<PluginManifest, String> {
    let manifest_path = plugin_dir.join("plugin.json");
    if !manifest_path.exists() {
        return Err(format!("No plugin.json found in {}", plugin_dir.display()));
    }

    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read plugin.json: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse plugin.json: {}", e))
}

/// Read the HEAD commit hash from a git repo directory
fn read_git_head(repo_dir: &PathBuf) -> String {
    let output = create_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_dir)
        .env("PATH", get_extended_path())
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// Get current timestamp in milliseconds
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// List all installed plugins for a project
#[tauri::command]
pub fn list_plugins(project_path: String) -> Result<Vec<PluginInfo>, String> {
    let registry = read_registry(&project_path)?;
    let plugins_dir = get_plugins_dir(&project_path)?;
    let mut results = Vec::new();

    for entry in &registry.plugins {
        let plugin_dir = if entry.is_dev {
            PathBuf::from(&entry.local_path)
        } else {
            plugins_dir.join(&entry.plugin_id)
        };
        match read_manifest(&plugin_dir) {
            Ok(manifest) => {
                results.push(PluginInfo {
                    manifest,
                    enabled: entry.enabled,
                    installed_at: entry.installed_at,
                    source_url: entry.source_url.clone(),
                    is_dev: entry.is_dev,
                    local_path: entry.local_path.clone(),
                });
            }
            Err(e) => {
                tracing::warn!("Skipping plugin {}: {}", entry.plugin_id, e);
            }
        }
    }

    Ok(results)
}

/// Install a plugin from a GitHub repository URL into a project
#[tauri::command]
pub async fn install_plugin(
    app: AppHandle,
    project_path: String,
    repo_url: String,
) -> Result<PluginInfo, String> {
    let plugins_dir = get_plugins_dir(&project_path)?;
    fs::create_dir_all(&plugins_dir).map_err(|e| format!("Failed to create plugins dir: {}", e))?;

    // Clone into a temp directory first, then move
    let temp_dir = plugins_dir.join(".tmp-install");
    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }

    let output = create_command("git")
        .args([
            "clone",
            "--depth",
            "1",
            &repo_url,
            &temp_dir.to_string_lossy(),
        ])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run git clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Git clone failed: {}", stderr));
    }

    // Read manifest to get plugin ID
    let manifest = match read_manifest(&temp_dir) {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(format!("Invalid plugin: {}", e));
        }
    };

    warn_on_setup_items(&manifest);

    // Validate manifest has required fields
    if manifest.id.is_empty() || manifest.name.is_empty() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err("Plugin manifest must have 'id' and 'name' fields".to_string());
    }

    // Validate plugin ID is safe for filesystem
    if manifest.id.contains('/')
        || manifest.id.contains('\\')
        || manifest.id.contains("..")
        || manifest.id.starts_with('.')
    {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err("Plugin ID contains invalid characters".to_string());
    }

    // Check min_app_version compatibility
    if let Err(e) = check_min_app_version(&manifest, &app) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    // Validate required_commands are all in the allowed set
    if let Err(e) = validate_required_commands(&manifest) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    let plugin_dir = plugins_dir.join(&manifest.id);

    // Remove existing version if present
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove existing plugin: {}", e))?;
    }

    // Move temp to final location
    fs::rename(&temp_dir, &plugin_dir).map_err(|e| {
        let _ = fs::remove_dir_all(&temp_dir);
        format!("Failed to move plugin to final location: {}", e)
    })?;

    // Read commit hash before removing .git
    let commit_hash = read_git_head(&plugin_dir);

    // Remove .git directory (no need to keep it)
    let git_dir = plugin_dir.join(".git");
    if git_dir.exists() {
        let _ = fs::remove_dir_all(&git_dir);
    }

    // Update registry
    let mut registry = read_registry(&project_path)?;

    // Remove old entry if exists
    registry.plugins.retain(|e| e.plugin_id != manifest.id);

    let entry = RegistryEntry {
        plugin_id: manifest.id.clone(),
        enabled: true,
        installed_at: now_ms(),
        source_url: repo_url.clone(),
        installed_commit: commit_hash,
        is_dev: false,
        local_path: String::new(),
    };

    registry.plugins.push(entry);
    write_registry(&project_path, &registry)?;

    Ok(PluginInfo {
        manifest,
        enabled: true,
        installed_at: now_ms(),
        source_url: repo_url,
        is_dev: false,
        local_path: String::new(),
    })
}

/// Uninstall a plugin by its ID from a project
#[tauri::command]
pub fn uninstall_plugin(project_path: String, plugin_id: String) -> Result<(), String> {
    // Guard: dev plugins should use unlink instead
    let registry = read_registry(&project_path)?;
    if let Some(entry) = registry.plugins.iter().find(|e| e.plugin_id == plugin_id) {
        if entry.is_dev {
            return Err("Dev plugins cannot be uninstalled. Use Unlink instead.".to_string());
        }
    }

    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);

    // Remove plugin directory
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove plugin directory: {}", e))?;
    }

    // Update registry
    let mut registry = read_registry(&project_path)?;
    registry.plugins.retain(|e| e.plugin_id != plugin_id);
    write_registry(&project_path, &registry)?;

    Ok(())
}

/// Update a plugin by pulling latest from its source repository
#[tauri::command]
pub async fn update_plugin(
    app: AppHandle,
    project_path: String,
    plugin_id: String,
) -> Result<PluginInfo, String> {
    let registry = read_registry(&project_path)?;
    let entry = registry
        .plugins
        .iter()
        .find(|e| e.plugin_id == plugin_id)
        .ok_or_else(|| format!("Plugin '{}' not found in registry", plugin_id))?;

    let source_url = entry.source_url.clone();
    let was_enabled = entry.enabled;

    // Re-install from source (clean install)
    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);

    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove old plugin: {}", e))?;
    }

    // Clone fresh
    let output = create_command("git")
        .args([
            "clone",
            "--depth",
            "1",
            &source_url,
            &plugin_dir.to_string_lossy(),
        ])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run git clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git clone failed: {}", stderr));
    }

    // Read commit hash before removing .git
    let commit_hash = read_git_head(&plugin_dir);

    // Remove .git directory
    let git_dir = plugin_dir.join(".git");
    if git_dir.exists() {
        let _ = fs::remove_dir_all(&git_dir);
    }

    let manifest = read_manifest(&plugin_dir)?;

    warn_on_setup_items(&manifest);

    // Check min_app_version compatibility
    check_min_app_version(&manifest, &app)?;

    // Validate required_commands are all in the allowed set
    validate_required_commands(&manifest)?;

    // Update registry entry (preserve enabled state, update commit hash)
    let mut registry = read_registry(&project_path)?;
    if let Some(entry) = registry
        .plugins
        .iter_mut()
        .find(|e| e.plugin_id == plugin_id)
    {
        entry.enabled = was_enabled;
        entry.installed_commit = commit_hash;
    }
    write_registry(&project_path, &registry)?;

    Ok(PluginInfo {
        manifest,
        enabled: was_enabled,
        installed_at: now_ms(),
        source_url,
        is_dev: false,
        local_path: String::new(),
    })
}

/// Check if a plugin has an update available by comparing commit hashes
#[tauri::command]
pub async fn check_plugin_update(
    project_path: String,
    plugin_id: String,
) -> Result<PluginUpdateCheck, String> {
    let registry = read_registry(&project_path)?;
    let entry = registry
        .plugins
        .iter()
        .find(|e| e.plugin_id == plugin_id)
        .ok_or_else(|| format!("Plugin '{}' not found in registry", plugin_id))?;

    if entry.is_dev {
        return Err(
            "Dev plugins do not support remote update checks. Use Reload instead.".to_string(),
        );
    }

    let source_url = entry.source_url.clone();
    let installed_commit = entry.installed_commit.clone();

    // Get installed version from manifest
    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);
    let manifest = read_manifest(&plugin_dir)?;
    let installed_version = manifest.version.clone();

    // Get remote HEAD commit via git ls-remote
    let output = create_command("git")
        .args(["ls-remote", &source_url, "HEAD"])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run git ls-remote: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to check remote: {}", stderr));
    }

    let remote_output = String::from_utf8_lossy(&output.stdout);
    let remote_commit = remote_output
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    // If we don't have an installed commit hash (legacy install), assume update available
    let has_update = if installed_commit.is_empty() {
        true
    } else {
        !remote_commit.is_empty() && remote_commit != installed_commit
    };

    Ok(PluginUpdateCheck {
        has_update,
        installed_version,
        installed_commit,
        remote_commit,
    })
}

/// Read the JavaScript bundle for a plugin (dist/index.js)
#[tauri::command]
pub fn read_plugin_bundle(project_path: String, plugin_id: String) -> Result<String, String> {
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);

    let bundle_path = if let Some(entry) = entry {
        if entry.is_dev {
            PathBuf::from(&entry.local_path)
                .join("dist")
                .join("index.js")
        } else {
            get_plugins_dir(&project_path)?
                .join(&plugin_id)
                .join("dist")
                .join("index.js")
        }
    } else {
        get_plugins_dir(&project_path)?
            .join(&plugin_id)
            .join("dist")
            .join("index.js")
    };

    if !bundle_path.exists() {
        return Err(format!(
            "Plugin bundle not found: {}",
            bundle_path.display()
        ));
    }

    fs::read_to_string(&bundle_path).map_err(|e| format!("Failed to read plugin bundle: {}", e))
}

/// Read a plugin's manifest
#[tauri::command]
pub fn read_plugin_manifest(
    project_path: String,
    plugin_id: String,
) -> Result<PluginManifest, String> {
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);

    let plugin_dir = if let Some(entry) = entry {
        if entry.is_dev {
            PathBuf::from(&entry.local_path)
        } else {
            get_plugins_dir(&project_path)?.join(&plugin_id)
        }
    } else {
        get_plugins_dir(&project_path)?.join(&plugin_id)
    };

    read_manifest(&plugin_dir)
}

/// Toggle a plugin's enabled state
#[tauri::command]
pub fn toggle_plugin(project_path: String, plugin_id: String, enabled: bool) -> Result<(), String> {
    let mut registry = read_registry(&project_path)?;

    if let Some(entry) = registry
        .plugins
        .iter_mut()
        .find(|e| e.plugin_id == plugin_id)
    {
        entry.enabled = enabled;
        write_registry(&project_path, &registry)?;
        Ok(())
    } else {
        Err(format!("Plugin '{}' not found", plugin_id))
    }
}

/// Execute a shell command in a plugin's context
///
/// Security: validates project_path, uses extended PATH, enforces configurable timeout (default 120s).
#[tauri::command]
pub async fn exec_plugin_shell(
    plugin_id: String,
    project_path: String,
    command: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    // Validate the project path for security
    let validated_path = validate_project_path(&project_path)?;

    // Validate plugin exists in this project
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    let plugin_exists = if let Some(entry) = entry {
        if entry.is_dev {
            PathBuf::from(&entry.local_path).exists()
        } else {
            get_plugins_dir(&project_path)?.join(&plugin_id).exists()
        }
    } else {
        false
    };
    if !plugin_exists {
        return Err(format!("Plugin '{}' not found", plugin_id));
    }

    // Build and execute command with timeout
    let timeout = timeout_secs.unwrap_or(120);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        tokio::task::spawn_blocking(move || {
            create_command(&command)
                .args(&args)
                .current_dir(&validated_path)
                .env("PATH", get_extended_path())
                .env(
                    "HOME",
                    dirs::home_dir()
                        .map(|h| h.to_string_lossy().to_string())
                        .unwrap_or_default(),
                )
                .output()
        }),
    )
    .await
    .map_err(|_| format!("Plugin shell command timed out ({}s)", timeout))?
    .map_err(|e| format!("Failed to spawn command: {}", e))?
    .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Link a local dev plugin folder into a project.
///
/// Opens a native folder picker, validates the selected folder has plugin.json and dist/index.js,
/// then registers it in the project's plugin registry as a dev plugin.
#[tauri::command]
pub async fn link_dev_plugin(
    app: AppHandle,
    project_path: String,
) -> Result<Option<PluginInfo>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("Select Plugin Folder")
        .blocking_pick_folder();

    let folder_path = match folder {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid folder path: {}", e))?,
        None => return Ok(None), // User cancelled
    };

    // Validate plugin.json exists
    let manifest = read_manifest(&folder_path)?;

    warn_on_setup_items(&manifest);

    // Validate dist/index.js exists
    let bundle_path = folder_path.join("dist").join("index.js");
    if !bundle_path.exists() {
        return Err(format!(
            "Plugin bundle not found at {}/dist/index.js. Did you run the build?",
            folder_path.display()
        ));
    }

    // Validate manifest has required fields
    if manifest.id.is_empty() || manifest.name.is_empty() {
        return Err("Plugin manifest must have 'id' and 'name' fields".to_string());
    }

    // Validate plugin ID is safe for filesystem
    if manifest.id.contains('/')
        || manifest.id.contains('\\')
        || manifest.id.contains("..")
        || manifest.id.starts_with('.')
    {
        return Err("Plugin ID contains invalid characters".to_string());
    }

    // Check min_app_version compatibility
    check_min_app_version(&manifest, &app)?;

    // Validate required_commands are all in the allowed set
    validate_required_commands(&manifest)?;

    // Check for existing plugin with same ID
    let mut registry = read_registry(&project_path)?;
    if registry
        .plugins
        .iter()
        .any(|e| e.plugin_id == manifest.id && !e.is_dev)
    {
        return Err(format!(
            "A non-dev plugin '{}' is already installed. Uninstall it first.",
            manifest.id
        ));
    }

    // Remove existing dev entry for this plugin if present (re-link)
    registry.plugins.retain(|e| e.plugin_id != manifest.id);

    let local_path = folder_path.to_string_lossy().to_string();
    let entry = RegistryEntry {
        plugin_id: manifest.id.clone(),
        enabled: true,
        installed_at: now_ms(),
        source_url: String::new(),
        installed_commit: String::new(),
        is_dev: true,
        local_path: local_path.clone(),
    };

    registry.plugins.push(entry);
    write_registry(&project_path, &registry)?;

    Ok(Some(PluginInfo {
        manifest,
        enabled: true,
        installed_at: now_ms(),
        source_url: String::new(),
        is_dev: true,
        local_path,
    }))
}

/// Unlink a dev plugin from a project.
///
/// Removes the plugin from the registry only. Does NOT delete local files.
#[tauri::command]
pub fn unlink_dev_plugin(project_path: String, plugin_id: String) -> Result<(), String> {
    let mut registry = read_registry(&project_path)?;

    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    match entry {
        Some(e) if !e.is_dev => {
            return Err("Plugin is not a dev plugin. Use uninstall instead.".to_string());
        }
        None => {
            return Err(format!("Plugin '{}' not found", plugin_id));
        }
        _ => {}
    }

    // Remove from registry (does not touch local files)
    registry.plugins.retain(|e| e.plugin_id != plugin_id);
    write_registry(&project_path, &registry)?;

    // Clean up storage.json in project plugins dir if it exists
    let plugins_dir = get_plugins_dir(&project_path)?;
    let storage_path = plugins_dir.join(&plugin_id).join("storage.json");
    if storage_path.exists() {
        let _ = fs::remove_file(&storage_path);
    }
    // Remove the plugin_id directory in plugins dir if it's empty
    let plugin_data_dir = plugins_dir.join(&plugin_id);
    if plugin_data_dir.exists() {
        let _ = fs::remove_dir(&plugin_data_dir); // only removes if empty
    }

    Ok(())
}

/// Read plugin storage data
///
/// Storage is at {project}/.shipstudio/plugins/{plugin-id}/storage.json
/// Acquires a per-plugin lock to prevent races with concurrent writes.
#[tauri::command]
pub fn read_plugin_storage(
    plugin_id: String,
    project_path: String,
) -> Result<serde_json::Value, String> {
    let lock = get_storage_lock(&plugin_id, &project_path);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Storage lock poisoned: {}", e))?;

    let storage_path = get_storage_path(&plugin_id, &project_path)?;

    if !storage_path.exists() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }

    let content = fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read plugin storage: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse plugin storage: {}", e))
}

/// Write plugin storage data
///
/// Acquires a per-plugin lock to prevent concurrent read-modify-write races.
#[tauri::command]
pub fn write_plugin_storage(
    plugin_id: String,
    project_path: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let lock = get_storage_lock(&plugin_id, &project_path);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Storage lock poisoned: {}", e))?;

    let storage_path = get_storage_path(&plugin_id, &project_path)?;

    // Ensure parent directory exists
    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create storage directory: {}", e))?;
    }

    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize storage data: {}", e))?;

    fs::write(&storage_path, content).map_err(|e| format!("Failed to write plugin storage: {}", e))
}

/// Get the storage file path for a plugin
fn get_storage_path(plugin_id: &str, project_path: &str) -> Result<PathBuf, String> {
    // Validate plugin_id is safe
    if plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
        || plugin_id.starts_with('.')
    {
        return Err("Invalid plugin ID".to_string());
    }

    let plugins_dir = get_plugins_dir(project_path)?;
    Ok(plugins_dir.join(plugin_id).join("storage.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_registry() {
        let registry = Registry::default();
        assert!(registry.plugins.is_empty());
    }

    #[test]
    fn test_parse_manifest() {
        let json = r#"{
            "id": "hello-world",
            "name": "Hello World",
            "version": "1.0.0",
            "description": "A test plugin",
            "slots": ["toolbar"]
        }"#;

        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.id, "hello-world");
        assert_eq!(manifest.name, "Hello World");
        assert_eq!(manifest.slots, vec!["toolbar"]);
        assert!(manifest.author.is_empty());
    }

    #[test]
    fn test_parse_manifest_minimal() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "0.1.0",
            "description": "Minimal"
        }"#;

        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.id, "test");
        assert!(manifest.slots.is_empty());
        assert!(manifest.setup.is_empty());
    }

    #[test]
    fn test_storage_path_invalid_plugin_id() {
        let result = get_storage_path("../evil", "/tmp/test");
        assert!(result.is_err());

        let result = get_storage_path(".hidden", "/tmp/test");
        assert!(result.is_err());
    }
}
