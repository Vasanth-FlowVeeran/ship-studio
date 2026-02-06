//! # GitHub CLI Integration Commands
//!
//! Commands for GitHub CLI status, authentication, and user info.

use crate::commands::git::git_stage_and_commit;
use crate::types::{GitHubCliStatus, GitHubRepo, ProjectGitHubStatus, PushToGitHubOptions};
use crate::utils::{create_command, find_executable, get_extended_path, validate_project_path};
use std::path::Path;
use std::process::Command;
use tracing::{info, warn};

/// Default timeout for GitHub CLI commands (15 seconds)
const GITHUB_CLI_TIMEOUT_SECS: u64 = 15;

/// Run a command with a timeout. Returns the output if successful, or an error if timed out.
async fn run_command_with_timeout(
    cmd: Command,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let mut tokio_cmd = tokio::process::Command::from(cmd);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        tokio_cmd.output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("Command failed: {}", e)),
        Err(_) => Err(format!("Command timed out after {} seconds", timeout_secs)),
    }
}

/// Returns a Command for gh with extended PATH set
pub fn get_gh_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        create_command(path)
    } else {
        create_command("gh")
    };
    cmd.env("PATH", get_extended_path());
    cmd
}

/// Parse "owner/repo" from a GitHub URL (HTTPS or SSH format)
pub fn parse_github_repo(url: &str) -> Option<String> {
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
pub async fn check_github_cli_status() -> GitHubCliStatus {
    // Check if gh CLI is installed
    let installed = find_executable("gh").is_some();

    if !installed {
        return GitHubCliStatus {
            installed: false,
            authenticated: false,
        };
    }

    // Check if authenticated (with timeout to prevent hanging)
    let start = std::time::Instant::now();
    let mut auth_cmd = get_gh_command();
    auth_cmd.args(["auth", "status"]);
    let authenticated = match run_command_with_timeout(auth_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) => {
            info!(
                elapsed_ms = start.elapsed().as_millis() as u64,
                success = output.status.success(),
                "gh auth status completed"
            );
            output.status.success()
        }
        Err(e) => {
            warn!(elapsed_ms = start.elapsed().as_millis() as u64, error = %e, "gh auth status failed/timed out");
            false
        }
    };

    GitHubCliStatus {
        installed,
        authenticated,
    }
}

#[tauri::command]
pub async fn get_github_username() -> Result<String, String> {
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
pub async fn get_github_orgs() -> Result<Vec<String>, String> {
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

/// Checks GitHub status by verifying with the GitHub CLI.
/// Asks GitHub directly instead of inferring from local files.
#[tauri::command]
pub async fn get_project_github_status(project_path: String) -> ProjectGitHubStatus {
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

    let total_start = std::time::Instant::now();
    info!(project_path = %project_path, "get_project_github_status: starting");

    // Get remote URL (with timeout)
    let step_start = std::time::Instant::now();
    let mut remote_cmd = create_command("git");
    remote_cmd
        .args(["remote", "get-url", "origin"])
        .current_dir(&project)
        .env("PATH", get_extended_path());

    let remote_url = match run_command_with_timeout(remote_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) if output.status.success() => {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            info!(elapsed_ms = step_start.elapsed().as_millis() as u64, remote_url = %url, "git remote get-url origin completed");
            url
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            info!(elapsed_ms = step_start.elapsed().as_millis() as u64, stderr = %stderr, "git remote get-url origin: no remote configured");
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
        Err(e) => {
            warn!(elapsed_ms = step_start.elapsed().as_millis() as u64, error = %e, "git remote get-url origin failed/timed out");
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
            info!(remote_url = %remote_url, "Could not parse GitHub repo from remote URL");
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
    };

    // Verify repo exists on GitHub using gh CLI (with timeout)
    let step_start = std::time::Instant::now();
    info!(github_repo = %github_repo, "Running gh repo view");
    let mut gh_cmd = get_gh_command();
    gh_cmd
        .args(["repo", "view", &github_repo, "--json", "url"])
        .current_dir(&project);

    let result = match run_command_with_timeout(gh_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) if output.status.success() => {
            info!(elapsed_ms = step_start.elapsed().as_millis() as u64, github_repo = %github_repo, "gh repo view completed successfully");
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
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            info!(elapsed_ms = step_start.elapsed().as_millis() as u64, stderr = %stderr, "gh repo view: repo not found or no access");
            ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            }
        }
        Err(e) => {
            warn!(elapsed_ms = step_start.elapsed().as_millis() as u64, error = %e, "gh repo view failed/timed out");
            ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            }
        }
    };

    info!(
        total_elapsed_ms = total_start.elapsed().as_millis() as u64,
        status = %result.status,
        "get_project_github_status: done"
    );
    result
}

/// Ensures git user.name and user.email are configured for the repo.
/// If not set, fetches the user's identity from GitHub CLI and sets it locally.
fn ensure_git_identity(repo_path: &std::path::Path) -> Result<(), String> {
    let has_name = create_command("git")
        .args(["config", "user.name"])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let has_email = create_command("git")
        .args(["config", "user.email"])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if has_name && has_email {
        return Ok(());
    }

    // Fetch identity from GitHub CLI
    let gh_output = get_gh_command()
        .args(["api", "user", "--jq", r#".login, .name, .email"#])
        .output()
        .map_err(|e| format!("Failed to get GitHub user info: {}", e))?;

    if !gh_output.status.success() {
        return Err("Failed to get GitHub user info. Please configure git manually:\n  git config --global user.name \"Your Name\"\n  git config --global user.email \"you@example.com\"".to_string());
    }

    let info = String::from_utf8_lossy(&gh_output.stdout);
    let lines: Vec<&str> = info.lines().collect();
    // lines[0] = login, lines[1] = name (may be empty), lines[2] = email (may be empty)
    let login = lines.first().map(|s| s.trim()).unwrap_or("");
    let name = lines.get(1).map(|s| s.trim()).filter(|s| !s.is_empty());
    let email = lines.get(2).map(|s| s.trim()).filter(|s| !s.is_empty());

    if !has_name {
        let display_name = name.unwrap_or(login);
        create_command("git")
            .args(["config", "user.name", display_name])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to set git user.name: {}", e))?;
    }

    if !has_email {
        let user_email = email.unwrap_or_else(|| {
            // Can't return a reference to a local, so we'll handle this below
            ""
        });
        let final_email = if user_email.is_empty() {
            format!("{}@users.noreply.github.com", login)
        } else {
            user_email.to_string()
        };
        create_command("git")
            .args(["config", "user.email", &final_email])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to set git user.email: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn push_to_github(options: PushToGitHubOptions) -> Result<String, String> {
    let validated_path = validate_project_path(&options.project_path)?;
    let repo_name = &options.repo_name;
    let visibility = if options.is_private {
        "--private"
    } else {
        "--public"
    };

    // Check if it's already a git repo, if not initialize
    let git_dir = validated_path.join(".git");
    if !git_dir.exists() {
        create_command("git")
            .args(["init"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;
    }

    // Ensure git identity is configured (required for commits)
    ensure_git_identity(&validated_path)?;

    // Stage and commit any files
    let _ = git_stage_and_commit(
        &validated_path,
        if git_dir.exists() {
            "Update from Ship Studio"
        } else {
            "Initial commit from Ship Studio"
        },
    );

    // Ensure at least one commit exists (gh repo create --push requires it)
    let has_commits = create_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_commits {
        let output = create_command("git")
            .args([
                "commit",
                "--allow-empty",
                "-m",
                "Initial commit from Ship Studio",
            ])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to create initial commit: {}", stderr));
        }
    }

    // Create GitHub repo and push
    let output = get_gh_command()
        .args([
            "repo", "create", repo_name, visibility, "--source", ".", "--remote", "origin",
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

/// Lists GitHub repositories for a given owner (user or organization)
#[tauri::command]
pub async fn list_github_repos(owner: String) -> Result<Vec<GitHubRepo>, String> {
    let output = get_gh_command()
        .args([
            "repo",
            "list",
            &owner,
            "--json",
            "name,url,sshUrl,isPrivate,description,primaryLanguage,updatedAt",
            "--limit",
            "100",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list repos: {}", stderr));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let repos: Vec<GitHubRepo> =
        serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse repo list: {}", e))?;

    Ok(repos)
}

/// Detects the package manager used in a project by checking for lock files
#[tauri::command]
pub async fn detect_package_manager(project_path: String) -> Result<String, String> {
    let path = Path::new(&project_path);

    // Check in order of specificity
    if path.join("pnpm-lock.yaml").exists() {
        return Ok("pnpm".to_string());
    }
    if path.join("yarn.lock").exists() {
        return Ok("yarn".to_string());
    }
    if path.join("bun.lockb").exists() {
        return Ok("bun".to_string());
    }
    // Default to npm
    Ok("npm".to_string())
}
