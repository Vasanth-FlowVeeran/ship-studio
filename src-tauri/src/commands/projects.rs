//! # Project Management Commands
//!
//! Commands for managing projects and project metadata.

use crate::commands::vercel::get_vercel_deployment_info;
use crate::types::{
    DashboardProject, PageInfo, ProjectInfo, ProjectMetadata, PROJECT_METADATA_SCHEMA_VERSION,
};
use crate::utils::validate_project_path;
use std::process::Command;

// ============ Helper Functions ============

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

/// Sync helper for ensuring .shipstudio/ is in gitignore
fn ensure_gitignore_has_shipstudio_sync(project: &std::path::Path) -> Result<(), String> {
    let gitignore_path = project.join(".gitignore");
    let entry = ".shipstudio/";

    let content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path).unwrap_or_default()
    } else {
        String::new()
    };

    let already_ignored = content.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == entry
            || trimmed == ".shipstudio"
            || trimmed == "/.shipstudio/"
            || trimmed == "/.shipstudio"
    });

    if already_ignored {
        return Ok(());
    }

    let new_content = if content.is_empty() {
        format!("# ShipStudio metadata\n{}\n", entry)
    } else if content.ends_with('\n') {
        format!("{}\n# ShipStudio metadata\n{}\n", content, entry)
    } else {
        format!("{}\n\n# ShipStudio metadata\n{}\n", content, entry)
    };

    std::fs::write(&gitignore_path, new_content).ok();
    Ok(())
}

/// Detect if this is a SvelteKit project
fn is_sveltekit_project(project_path: &std::path::Path) -> bool {
    // Check for svelte.config.js or svelte.config.ts
    if project_path.join("svelte.config.js").exists()
        || project_path.join("svelte.config.ts").exists()
    {
        return true;
    }

    // Check package.json for @sveltejs/kit
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"@sveltejs/kit\"") {
                return true;
            }
        }
    }

    false
}

/// Scan Next.js pages (app/ directory with page.tsx/js/jsx files)
fn scan_nextjs_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('_') || dir_name.starts_with('.') || dir_name == "api" {
                continue;
            }

            let mut sub_pages = scan_nextjs_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name == "page.tsx" || file_name == "page.js" || file_name == "page.jsx" {
                let parent = path.parent().unwrap_or(&path);
                let relative = parent.strip_prefix(base_dir).unwrap_or(parent);

                // Filter out route group directories (parenthesized like "(dashboard)")
                // These are for organization only and don't affect the URL path
                let filtered_components: Vec<_> = relative
                    .components()
                    .filter_map(|c| {
                        if let std::path::Component::Normal(s) = c {
                            let segment = s.to_string_lossy();
                            // Skip route groups: directories starting with '(' and ending with ')'
                            if segment.starts_with('(') && segment.ends_with(')') {
                                None
                            } else {
                                Some(segment.to_string())
                            }
                        } else {
                            None
                        }
                    })
                    .collect();

                let route = if filtered_components.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", filtered_components.join("/"))
                };

                let display_route = route.replace('[', ":").replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(pages)
}

/// Scan SvelteKit pages (src/routes/ directory with +page.svelte files)
fn scan_sveltekit_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden directories and SvelteKit special directories
            if dir_name.starts_with('.') {
                continue;
            }

            let mut sub_pages = scan_sveltekit_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // SvelteKit uses +page.svelte for page components
            if file_name == "+page.svelte" {
                let parent = path.parent().unwrap_or(&path);
                let relative = parent.strip_prefix(base_dir).unwrap_or(parent);

                // Filter out route group directories (parenthesized like "(marketing)")
                // These are for organization only and don't affect the URL path
                let filtered_components: Vec<_> = relative
                    .components()
                    .filter_map(|c| {
                        if let std::path::Component::Normal(s) = c {
                            let segment = s.to_string_lossy();
                            // Skip route groups: directories starting with '(' and ending with ')'
                            if segment.starts_with('(') && segment.ends_with(')') {
                                None
                            } else {
                                Some(segment.to_string())
                            }
                        } else {
                            None
                        }
                    })
                    .collect();

                let route = if filtered_components.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", filtered_components.join("/"))
                };

                // Convert SvelteKit dynamic route syntax [slug] to :slug for display
                let display_route = route.replace('[', ":").replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(pages)
}

/// Sort pages with root first, then alphabetically
fn sort_pages(pages: &mut Vec<PageInfo>) {
    pages.sort_by(|a, b| {
        if a.route == "/" {
            return std::cmp::Ordering::Less;
        }
        if b.route == "/" {
            return std::cmp::Ordering::Greater;
        }
        a.route.cmp(&b.route)
    });
}

// ============ Tauri Commands ============

#[tauri::command]
pub async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    if !shipstudio_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&shipstudio_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() && path.join("package.json").exists() {
            let thumbnail_path = path.join(".shipstudio").join("thumbnail.png");
            let thumbnail = if thumbnail_path.exists() {
                Some(thumbnail_path.to_string_lossy().to_string())
            } else {
                None
            };

            let metadata_path = path.join(".shipstudio").join("project.json");
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

    projects.sort_by(|a, b| match (a.last_opened, b.last_opened) {
        (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    Ok(projects)
}

/// Returns enhanced project list for dashboard with git/vercel info
#[tauri::command]
pub async fn get_dashboard_projects() -> Result<Vec<DashboardProject>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    if !shipstudio_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&shipstudio_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() && path.join("package.json").exists() {
            let thumbnail_path = path.join(".shipstudio").join("thumbnail.png");
            let thumbnail = if thumbnail_path.exists() {
                Some(thumbnail_path.to_string_lossy().to_string())
            } else {
                None
            };

            let metadata_path = path.join(".shipstudio").join("project.json");
            let metadata = if metadata_path.exists() {
                std::fs::read_to_string(&metadata_path)
                    .ok()
                    .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            } else {
                None
            };
            let last_opened = metadata.as_ref().and_then(|m| m.last_opened);
            let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
            let hide_main_branch_warning =
                metadata.as_ref().and_then(|m| m.hide_main_branch_warning);

            // Ensure .shipstudio/ is gitignored
            let _ = ensure_gitignore_has_shipstudio_sync(&path);

            // Get git info
            let git_branch = get_git_branch(&path);
            let uncommitted_count = get_uncommitted_count(&path);

            // Get Vercel deployment info
            let (production_url, last_deployed, deployment_state) =
                get_vercel_deployment_info(&path);

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
                auto_accept_mode,
                hide_main_branch_warning,
            });
        }
    }

    projects.sort_by(|a, b| match (a.last_opened, b.last_opened) {
        (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    Ok(projects)
}

/// Scans a project's pages/routes directory for page routes.
/// Supports both Next.js (app/ directory) and SvelteKit (src/routes/ directory).
#[tauri::command]
pub async fn list_pages(project_path: String) -> Result<Vec<PageInfo>, String> {
    let project = validate_project_path(&project_path)?;

    // Check if this is a SvelteKit project
    if is_sveltekit_project(&project) {
        let routes_dir = project.join("src").join("routes");
        if routes_dir.exists() {
            let mut pages = scan_sveltekit_pages(&routes_dir, &routes_dir)?;
            sort_pages(&mut pages);
            return Ok(pages);
        }
        return Ok(Vec::new());
    }

    // Default to Next.js app router
    let app_dir = project.join("app");
    if !app_dir.exists() {
        let src_app_dir = project.join("src").join("app");
        if !src_app_dir.exists() {
            return Ok(Vec::new());
        }
        let mut pages = scan_nextjs_pages(&src_app_dir, &src_app_dir)?;
        sort_pages(&mut pages);
        return Ok(pages);
    }

    let mut pages = scan_nextjs_pages(&app_dir, &app_dir)?;
    sort_pages(&mut pages);
    Ok(pages)
}

#[tauri::command]
pub async fn check_sanity_installed(project_path: String) -> Result<bool, String> {
    let path = validate_project_path(&project_path)?;

    if path.join("sanity.config.ts").exists() || path.join("sanity.config.js").exists() {
        return Ok(true);
    }

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

/// Reads project metadata from .shipstudio/project.json with automatic schema migration
#[tauri::command]
pub async fn read_project_metadata(
    project_path: String,
) -> Result<Option<ProjectMetadata>, String> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read project metadata: {}", e))?;

    let mut metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {}", e))?;

    // Apply migrations if needed and save the updated metadata
    if metadata.migrate() {
        let updated_contents = serde_json::to_string_pretty(&metadata)
            .map_err(|e| format!("Failed to serialize migrated metadata: {}", e))?;
        std::fs::write(&metadata_path, updated_contents)
            .map_err(|e| format!("Failed to save migrated metadata: {}", e))?;
    }

    Ok(Some(metadata))
}

/// Writes project metadata to .shipstudio/project.json
/// Always ensures the schema_version is set to the current version.
#[tauri::command]
pub async fn write_project_metadata(
    project_path: String,
    mut metadata: ProjectMetadata,
) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {}", e))?;
    }

    // Ensure schema_version is current when writing
    metadata.schema_version = PROJECT_METADATA_SCHEMA_VERSION;

    let metadata_path = shipstudio_dir.join("project.json");
    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;

    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Marks a project as opened by updating its last_opened timestamp
#[tauri::command]
pub async fn mark_project_opened(project_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

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
    metadata.last_opened = Some(now);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {}", e))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Gets the branch prefix username preference (defaults to true if not set)
#[tauri::command]
pub async fn get_branch_prefix_preference(project_path: String) -> Result<bool, String> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(true);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.branch_prefix_username.unwrap_or(true))
}

/// Sets the branch prefix username preference
#[tauri::command]
pub async fn set_branch_prefix_preference(
    project_path: String,
    prefix: bool,
) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.branch_prefix_username = Some(prefix);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {}", e))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Ensures .shipstudio/ is in the project's .gitignore
#[tauri::command]
pub async fn ensure_gitignore_has_shipstudio(project_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let gitignore_path = project.join(".gitignore");

    let entry = ".shipstudio/";

    let content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)
            .map_err(|e| format!("Failed to read .gitignore: {}", e))?
    } else {
        String::new()
    };

    let already_ignored = content.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == entry
            || trimmed == ".shipstudio"
            || trimmed == "/.shipstudio/"
            || trimmed == "/.shipstudio"
    });

    if already_ignored {
        return Ok(());
    }

    let new_content = if content.is_empty() {
        format!("# ShipStudio metadata\n{}\n", entry)
    } else if content.ends_with('\n') {
        format!("{}\n# ShipStudio metadata\n{}\n", content, entry)
    } else {
        format!("{}\n\n# ShipStudio metadata\n{}\n", content, entry)
    };

    std::fs::write(&gitignore_path, new_content)
        .map_err(|e| format!("Failed to write .gitignore: {}", e))?;

    Ok(())
}

/// Deletes a project directory. Only allows deletion from ~/ShipStudio.
#[tauri::command]
pub async fn delete_project(path: String) -> Result<(), String> {
    let project_path = std::path::Path::new(&path);

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    if !project_path.starts_with(&shipstudio_dir) {
        return Err("Can only delete projects from ShipStudio directory".to_string());
    }

    if !project_path.exists() {
        return Err("Project not found".to_string());
    }

    std::fs::remove_dir_all(project_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Clears project cache directories (.next, node_modules/.cache, etc.)
/// Used when restarting the dev server to ensure a fresh build.
#[tauri::command]
pub async fn clear_project_cache(project_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;

    // List of cache directories to clear
    let cache_dirs = [
        ".next",               // Next.js build cache
        ".svelte-kit",         // SvelteKit build cache
        "node_modules/.cache", // Various build tool caches (babel, eslint, etc.)
        ".turbo",              // Turborepo cache
        ".swc",                // SWC compiler cache
    ];

    let mut errors = Vec::new();

    for cache_dir in &cache_dirs {
        let cache_path = project.join(cache_dir);
        if cache_path.exists() {
            if let Err(e) = std::fs::remove_dir_all(&cache_path) {
                errors.push(format!("Failed to remove {}: {}", cache_dir, e));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        // Log errors but don't fail - some caches might be locked
        tracing::warn!("Some cache directories could not be cleared: {:?}", errors);
        Ok(())
    }
}

/// Gets the auto-accept mode preference for a project
#[tauri::command]
pub async fn get_auto_accept_mode(project_path: String) -> Result<bool, String> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(false);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.auto_accept_mode.unwrap_or(false))
}

/// Sets the auto-accept mode preference for a project
/// When enabled, Claude will run with --dangerously-skip-permissions flag
#[tauri::command]
pub async fn set_auto_accept_mode(project_path: String, enabled: bool) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.auto_accept_mode = Some(enabled);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {}", e))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}

/// Gets whether the main branch warning banner should be hidden for this project
#[tauri::command]
pub async fn get_hide_main_branch_warning(project_path: String) -> Result<bool, String> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(false);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.hide_main_branch_warning.unwrap_or(false))
}

/// Sets whether the main branch warning banner should be hidden for this project
#[tauri::command]
pub async fn set_hide_main_branch_warning(
    project_path: String,
    hidden: bool,
) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.hide_main_branch_warning = Some(hidden);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {}", e))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {}", e))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {}", e))?;

    Ok(())
}
