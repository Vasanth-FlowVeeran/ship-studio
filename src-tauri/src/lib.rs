use headless_chrome::{Browser, LaunchOptions};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
struct PrerequisiteCheck {
    name: String,
    available: bool,
    path: Option<String>,
}

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

#[tauri::command]
async fn get_marketingstack_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");
    Ok(marketingstack_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn ensure_marketingstack_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let marketingstack_dir = home.join("Marketingstack");

    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir).map_err(|e| e.to_string())?;
    }

    Ok(marketingstack_dir.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct ProjectInfo {
    name: String,
    path: String,
    thumbnail: Option<String>,
}

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

#[derive(Serialize)]
struct PageInfo {
    route: String,
    file_path: String,
}

#[tauri::command]
async fn list_pages(project_path: String) -> Result<Vec<PageInfo>, String> {
    let project = std::path::Path::new(&project_path);
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

                projects.push(ProjectInfo {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    thumbnail,
                });
            }
        }
    }

    Ok(projects)
}

#[tauri::command]
async fn capture_project_thumbnail(project_path: String, url: String) -> Result<String, String> {
    let project = std::path::Path::new(&project_path);
    let marketingstack_dir = project.join(".marketingstack");

    // Ensure .marketingstack directory exists
    if !marketingstack_dir.exists() {
        std::fs::create_dir_all(&marketingstack_dir).map_err(|e| e.to_string())?;
    }

    let thumbnail_path = marketingstack_dir.join("thumbnail.png");

    // Launch headless browser and capture screenshot
    let launch_options = LaunchOptions::default_builder()
        .headless(true)
        .window_size(Some((1200, 800)))
        .build()
        .map_err(|e| e.to_string())?;

    let browser = Browser::new(launch_options).map_err(|e| e.to_string())?;
    let tab = browser.new_tab().map_err(|e| e.to_string())?;

    // Navigate to the URL
    tab.navigate_to(&url).map_err(|e| e.to_string())?;

    // Wait for page to load
    tab.wait_until_navigated().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1500)); // Extra time for JS rendering

    // Capture screenshot
    let screenshot = tab
        .capture_screenshot(
            headless_chrome::protocol::cdp::Page::CaptureScreenshotFormatOption::Png,
            None,
            None,
            true,
        )
        .map_err(|e| e.to_string())?;

    // Save to file
    std::fs::write(&thumbnail_path, &screenshot).map_err(|e| e.to_string())?;

    Ok(thumbnail_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_project_thumbnail(project_path: String) -> Result<Option<String>, String> {
    let project = std::path::Path::new(&project_path);
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
async fn capture_preview_to_file(url: String, project_path: String) -> Result<String, String> {
    let project = std::path::Path::new(&project_path);
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

    // Launch headless browser and capture screenshot
    let launch_options = LaunchOptions::default_builder()
        .headless(true)
        .window_size(Some((1200, 800)))
        .build()
        .map_err(|e| e.to_string())?;

    let browser = Browser::new(launch_options).map_err(|e| e.to_string())?;
    let tab = browser.new_tab().map_err(|e| e.to_string())?;

    // Navigate to the URL
    tab.navigate_to(&url).map_err(|e| e.to_string())?;

    // Wait for page to load
    tab.wait_until_navigated().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1500)); // Extra time for JS rendering

    // Capture screenshot as PNG
    let screenshot_data = tab
        .capture_screenshot(
            headless_chrome::protocol::cdp::Page::CaptureScreenshotFormatOption::Png,
            None,
            None,
            true,
        )
        .map_err(|e| e.to_string())?;

    // Save to file
    std::fs::write(&screenshot_path, &screenshot_data).map_err(|e| e.to_string())?;

    Ok(screenshot_path.to_string_lossy().to_string())
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
        get_vercel_command()
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
    let project_path = &options.project_path;
    let project_name = &options.project_name;

    eprintln!("Starting Vercel deployment for {} at {}", project_name, project_path);

    // Step 1: Link the project to Vercel (creates project if doesn't exist)
    // Using --yes to skip prompts, --project to set the name
    let link_output = get_vercel_command()
        .args(["link", "--yes", "--project", project_name])
        .current_dir(project_path)
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
            .current_dir(project_path)
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
        .current_dir(project_path)
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

    // Parse the deployment URL from the output
    // vercel --prod outputs the production URL on success
    let stdout = String::from_utf8_lossy(&deploy_output.stdout);

    // The URL is typically on its own line, look for vercel.app or https://
    for line in stdout.lines().rev() {
        let line = line.trim();
        if line.contains(".vercel.app") || line.starts_with("https://") {
            return Ok(line.to_string());
        }
    }

    // Fallback: construct URL from project name
    Ok(format!("https://{}.vercel.app", project_name))
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

#[derive(Serialize)]
struct ProjectVercelStatus {
    is_linked: bool,
    project_name: Option<String>,
    production_url: Option<String>,
}

#[tauri::command]
async fn get_project_vercel_status(project_path: String) -> ProjectVercelStatus {
    eprintln!("Checking Vercel status for: {}", project_path);

    let project = std::path::Path::new(&project_path);
    let vercel_dir = project.join(".vercel");
    let project_json = vercel_dir.join("project.json");

    // Check if .vercel/project.json exists (indicates linked project)
    if !project_json.exists() {
        eprintln!("No .vercel/project.json found");
        return ProjectVercelStatus {
            is_linked: false,
            project_name: None,
            production_url: None,
        };
    }

    eprintln!(".vercel/project.json exists");

    // Read project.json to get project info
    let project_info = match std::fs::read_to_string(&project_json) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("Failed to read project.json: {}", e);
            return ProjectVercelStatus {
                is_linked: false,
                project_name: None,
                production_url: None,
            };
        }
    };

    eprintln!("project.json content: {}", project_info);

    // Parse JSON to extract projectId and orgId
    let json: serde_json::Value = match serde_json::from_str(&project_info) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Failed to parse project.json: {}", e);
            return ProjectVercelStatus {
                is_linked: true,
                project_name: None,
                production_url: None,
            };
        }
    };

    let project_id = json.get("projectId").and_then(|v| v.as_str());
    let project_name_from_config = json.get("projectName").and_then(|v| v.as_str());

    eprintln!("Project ID: {:?}, Project Name: {:?}", project_id, project_name_from_config);

    // If we have a project name in config, we can construct the URL directly
    // This is the most reliable method since the config is created by vercel link
    if let Some(name) = project_name_from_config {
        let production_url = format!("https://{}.vercel.app", name);
        eprintln!("Using project name from config: {} -> {}", name, production_url);
        return ProjectVercelStatus {
            is_linked: true,
            project_name: Some(name.to_string()),
            production_url: Some(production_url),
        };
    }

    if project_id.is_none() {
        eprintln!("No projectId found in project.json");
        return ProjectVercelStatus {
            is_linked: true,
            project_name: None,
            production_url: None,
        };
    }

    let project_id = project_id.unwrap();
    eprintln!("Project ID: {}", project_id);

    // Method 1: Try `vercel ls --json` to get deployments for this linked project
    // This works best for projects that have been deployed
    eprintln!("Trying vercel ls --json...");
    let ls_output = get_vercel_command()
        .args(["ls", "--json"])
        .current_dir(&project_path)
        .output();

    if let Ok(output) = ls_output {
        eprintln!("vercel ls status: {}", output.status);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("vercel ls stdout (first 500 chars): {}", &stdout.chars().take(500).collect::<String>());
        eprintln!("vercel ls stderr: {}", stderr);

        if output.status.success() {
            if let Ok(deployments) = serde_json::from_str::<serde_json::Value>(&stdout) {
                eprintln!("Parsed deployments JSON");
                // Look for a production deployment with an alias
                if let Some(deps_array) = deployments.as_array() {
                    eprintln!("Found {} deployments", deps_array.len());
                    for dep in deps_array {
                        // Check if this is a production deployment
                        let target = dep.get("target").and_then(|t| t.as_str());
                        eprintln!("Deployment target: {:?}", target);
                        let is_prod = target == Some("production");
                        if is_prod {
                            eprintln!("Found production deployment!");
                            // Get the alias (custom domain or .vercel.app URL)
                            if let Some(aliases) = dep.get("alias").and_then(|a| a.as_array()) {
                                eprintln!("Aliases: {:?}", aliases);
                                if let Some(first_alias) = aliases.first().and_then(|a| a.as_str()) {
                                    let url = if first_alias.starts_with("http") {
                                        first_alias.to_string()
                                    } else {
                                        format!("https://{}", first_alias)
                                    };
                                    let name = dep.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                                    eprintln!("Returning with URL from alias: {}", url);
                                    return ProjectVercelStatus {
                                        is_linked: true,
                                        project_name: name,
                                        production_url: Some(url),
                                    };
                                }
                            }
                            // Fallback to url field
                            if let Some(url) = dep.get("url").and_then(|u| u.as_str()) {
                                let full_url = if url.starts_with("http") {
                                    url.to_string()
                                } else {
                                    format!("https://{}", url)
                                };
                                let name = dep.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                                eprintln!("Returning with URL from url field: {}", full_url);
                                return ProjectVercelStatus {
                                    is_linked: true,
                                    project_name: name,
                                    production_url: Some(full_url),
                                };
                            }
                        }
                    }
                    eprintln!("No production deployment found in array");
                }
            } else {
                eprintln!("Failed to parse vercel ls JSON");
            }
        }
    } else {
        eprintln!("vercel ls command failed to execute");
    }

    // Method 2: Try `vercel project ls --json` to find the project by ID
    eprintln!("Trying vercel project ls --json...");
    let output = get_vercel_command()
        .args(["project", "ls", "--json"])
        .current_dir(&project_path)
        .output();

    if let Ok(output) = output {
        eprintln!("vercel project ls status: {}", output.status);
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            eprintln!("vercel project ls stdout (first 500 chars): {}", &stdout.chars().take(500).collect::<String>());
            if let Ok(projects) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(projects_array) = projects.as_array() {
                    eprintln!("Found {} projects", projects_array.len());
                    for proj in projects_array {
                        if let Some(id) = proj.get("id").and_then(|v| v.as_str()) {
                            eprintln!("Checking project ID: {} vs {}", id, project_id);
                            if id == project_id {
                                let name = proj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                                // Construct production URL from project name
                                let production_url = name.as_ref().map(|n| format!("https://{}.vercel.app", n));
                                eprintln!("Found matching project! Name: {:?}, URL: {:?}", name, production_url);
                                return ProjectVercelStatus {
                                    is_linked: true,
                                    project_name: name,
                                    production_url,
                                };
                            }
                        }
                    }
                    eprintln!("No matching project ID found");
                }
            }
        }
    }

    // Method 3: Try vercel inspect for deployment details
    let inspect_output = get_vercel_command()
        .args(["inspect", "--json"])
        .current_dir(&project_path)
        .output();

    if let Ok(output) = inspect_output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(info) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let name = info.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                let url = info.get("url").and_then(|v| v.as_str()).map(|s| {
                    if s.starts_with("http") {
                        s.to_string()
                    } else {
                        format!("https://{}", s)
                    }
                });
                if url.is_some() {
                    return ProjectVercelStatus {
                        is_linked: true,
                        project_name: name,
                        production_url: url,
                    };
                }
            }
        }
    }

    // Fallback: linked but couldn't get details - construct URL from project name if we can find it
    // Try to get project name from a simple vercel command
    let whoami_output = get_vercel_command()
        .args(["project", "ls", "--json"])
        .output();

    if let Ok(output) = whoami_output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(projects) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(projects_array) = projects.as_array() {
                    for proj in projects_array {
                        if let Some(id) = proj.get("id").and_then(|v| v.as_str()) {
                            if id == project_id {
                                let name = proj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                                let production_url = name.as_ref().map(|n| format!("https://{}.vercel.app", n));
                                return ProjectVercelStatus {
                                    is_linked: true,
                                    project_name: name,
                                    production_url,
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    // Final fallback: linked but couldn't get details
    ProjectVercelStatus {
        is_linked: true,
        project_name: None,
        production_url: None,
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
    // vercel git connect needs the full GitHub URL
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
        // Only log warning if it's not the "already connected" case
        eprintln!("Warning: Failed to connect Vercel to GitHub: {}", stderr);
    }

    // Step 3: Get the production URL
    // Read the project.json to get the project ID, then construct URL
    let vercel_dir = std::path::Path::new(project_path).join(".vercel");
    let project_json = vercel_dir.join("project.json");

    if project_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&project_json) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                // Try to get project name from vercel inspect
                let inspect_output = get_vercel_command()
                    .args(["inspect", "--json"])
                    .current_dir(project_path)
                    .output();

                if let Ok(output) = inspect_output {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        if let Ok(info) = serde_json::from_str::<serde_json::Value>(&stdout) {
                            if let Some(name) = info.get("name").and_then(|v| v.as_str()) {
                                return Ok(format!("https://{}.vercel.app", name));
                            }
                            if let Some(url) = info.get("url").and_then(|v| v.as_str()) {
                                return Ok(if url.starts_with("http") {
                                    url.to_string()
                                } else {
                                    format!("https://{}", url)
                                });
                            }
                        }
                    }
                }

                // Fallback: construct URL from project ID
                if let Some(project_id) = json.get("projectId").and_then(|v| v.as_str()) {
                    // Project names often match repo names
                    let repo_name = github_repo.split('/').last().unwrap_or(project_id);
                    return Ok(format!("https://{}.vercel.app", repo_name));
                }
            }
        }
    }

    // If all else fails, return a generic success message
    Ok("Project linked to Vercel".to_string())
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

#[derive(Serialize)]
struct ProjectGitHubStatus {
    is_git_repo: bool,
    has_remote: bool,
    github_repo: Option<String>,  // e.g., "username/repo-name"
    github_url: Option<String>,   // e.g., "https://github.com/username/repo-name"
}

#[tauri::command]
async fn get_project_github_status(project_path: String) -> ProjectGitHubStatus {
    let project = std::path::Path::new(&project_path);
    let git_dir = project.join(".git");

    // Check if it's a git repo
    if !git_dir.exists() {
        return ProjectGitHubStatus {
            is_git_repo: false,
            has_remote: false,
            github_repo: None,
            github_url: None,
        };
    }

    // Check for GitHub remote
    let output = Command::new("git")
        .args(["remote", "-v"])
        .current_dir(&project_path)
        .output();

    match output {
        Ok(output) => {
            let remotes = String::from_utf8_lossy(&output.stdout);

            // Look for github.com in remotes
            if remotes.contains("github.com") {
                // Extract repo name from remote URL
                // Handles both HTTPS and SSH formats:
                // https://github.com/user/repo.git
                // git@github.com:user/repo.git
                let repo = remotes.lines()
                    .find(|line| line.contains("github.com") && line.contains("(push)"))
                    .and_then(|line| {
                        // Try HTTPS format first
                        if let Some(start) = line.find("github.com/") {
                            let rest = &line[start + 11..];
                            let end = rest.find(".git").unwrap_or(rest.find(' ').unwrap_or(rest.len()));
                            return Some(rest[..end].to_string());
                        }
                        // Try SSH format
                        if let Some(start) = line.find("github.com:") {
                            let rest = &line[start + 11..];
                            let end = rest.find(".git").unwrap_or(rest.find(' ').unwrap_or(rest.len()));
                            return Some(rest[..end].to_string());
                        }
                        None
                    });

                let github_url = repo.as_ref().map(|r| format!("https://github.com/{}", r));

                ProjectGitHubStatus {
                    is_git_repo: true,
                    has_remote: true,
                    github_repo: repo,
                    github_url,
                }
            } else {
                ProjectGitHubStatus {
                    is_git_repo: true,
                    has_remote: false,
                    github_repo: None,
                    github_url: None,
                }
            }
        }
        Err(_) => ProjectGitHubStatus {
            is_git_repo: true,
            has_remote: false,
            github_repo: None,
            github_url: None,
        },
    }
}

#[tauri::command]
async fn init_git_repo(project_path: String) -> Result<(), String> {
    // Initialize git repo
    let output = Command::new("git")
        .args(["init"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Stage all files
    let output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Create initial commit
    let output = Command::new("git")
        .args(["commit", "-m", "Initial commit from Marketingstack"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
async fn check_git_has_changes(project_path: String) -> Result<bool, String> {
    let project = std::path::Path::new(&project_path);
    let git_dir = project.join(".git");

    // Not a git repo = no changes to track
    if !git_dir.exists() {
        return Ok(false);
    }

    // Check for uncommitted changes (staged or unstaged)
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    let has_uncommitted = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_uncommitted {
        return Ok(true);
    }

    // Check for unpushed commits
    let unpushed = Command::new("git")
        .args(["log", "@{u}..", "--oneline"])
        .current_dir(&project_path)
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
                .current_dir(&project_path)
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
    let project_path = &options.project_path;
    let repo_name = &options.repo_name;
    let visibility = if options.is_private { "--private" } else { "--public" };

    // Check if it's already a git repo, if not initialize
    let git_dir = std::path::Path::new(project_path).join(".git");
    if !git_dir.exists() {
        init_git_repo(project_path.clone()).await?;
    } else {
        // Make sure all changes are committed
        let _ = Command::new("git")
            .args(["add", "-A"])
            .current_dir(project_path)
            .output();

        let status = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(project_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !String::from_utf8_lossy(&status.stdout).trim().is_empty() {
            let _ = Command::new("git")
                .args(["commit", "-m", "Update from Marketingstack"])
                .current_dir(project_path)
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
        .current_dir(project_path)
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
    let message = commit_message.unwrap_or_else(|| "Update from Marketingstack".to_string());

    // Get current branch name
    let branch_output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
    let branch = if branch.is_empty() { "main".to_string() } else { branch };

    // Pull latest changes first (rebase to keep history clean)
    let pull_output = Command::new("git")
        .args(["pull", "--rebase", "origin", &branch])
        .current_dir(&project_path)
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
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Check if there are changes to commit
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| e.to_string())?;

    let has_changes = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_changes {
        // Commit changes
        let output = Command::new("git")
            .args(["commit", "-m", &message])
            .current_dir(&project_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    // Push to origin
    let output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&project_path)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_pty::init())
        .invoke_handler(tauri::generate_handler![
            check_prerequisites,
            get_marketingstack_dir,
            ensure_marketingstack_dir,
            list_projects,
            list_pages,
            delete_project,
            capture_project_thumbnail,
            get_project_thumbnail,
            capture_preview_to_file,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
