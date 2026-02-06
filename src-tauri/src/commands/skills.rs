/**
 * Skills command module for Claude Code skills management.
 *
 * Provides commands for:
 * - Listing installed skills from ~/.claude/skills/ and project-level .claude/skills/
 * - Searching for skills via the Skills CLI (npx skills find)
 * - Installing and removing skills via the Skills CLI
 *
 * Skills installed via `npx skills add` are stored in:
 * - ~/.claude/skills/{skill-name}/ (user scope, symlinked from ~/.agents/skills/)
 * - {project}/.claude/skills/{skill-name}/ (project scope)
 *
 * Legacy plugin-based skills are also supported from ~/.claude/plugins/installed_plugins.json
 */
use crate::utils::{create_command, get_extended_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Represents a Claude skill
#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSkill {
    /// Skill name (command without the leading /)
    pub name: String,
    /// Short description extracted from the skill file
    pub description: String,
    /// The plugin this skill belongs to
    pub plugin: String,
    /// Whether this is a user-level or project-level skill
    pub scope: String,
}

/// Plugin installation info from installed_plugins.json
#[derive(Debug, Deserialize)]
struct PluginInstall {
    scope: String,
    #[serde(rename = "installPath")]
    install_path: String,
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
}

/// Structure of installed_plugins.json
#[derive(Debug, Deserialize)]
struct InstalledPlugins {
    plugins: HashMap<String, Vec<PluginInstall>>,
}

/// Parse SKILL.md frontmatter to extract name and description
fn parse_skill_md(content: &str) -> Option<(String, String)> {
    // SKILL.md has YAML frontmatter between --- markers
    let content = content.trim();
    if !content.starts_with("---") {
        return None;
    }

    // Find the closing ---
    let rest = &content[3..];
    let end_marker = rest.find("---")?;
    let frontmatter = &rest[..end_marker];

    let mut name = None;
    let mut description = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.starts_with("name:") {
            name = Some(line[5..].trim().to_string());
        } else if line.starts_with("description:") {
            description = Some(line[12..].trim().to_string());
        }
    }

    match (name, description) {
        (Some(n), Some(d)) => Some((n, d)),
        (Some(n), None) => Some((n, "Custom skill".to_string())),
        _ => None,
    }
}

/// Read skills from a plugin's skills directory
fn read_skills_from_plugin(plugin_path: &str, plugin_name: &str, scope: &str) -> Vec<ClaudeSkill> {
    let mut skills = Vec::new();
    let skills_dir = PathBuf::from(plugin_path).join("skills");

    if !skills_dir.exists() || !skills_dir.is_dir() {
        return skills;
    }

    if let Ok(entries) = fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            // Look for SKILL.md (case-insensitive)
            let skill_md = path.join("SKILL.md");
            let skill_md_lower = path.join("skill.md");

            let skill_file = if skill_md.exists() {
                Some(skill_md)
            } else if skill_md_lower.exists() {
                Some(skill_md_lower)
            } else {
                None
            };

            if let Some(skill_file) = skill_file {
                if let Ok(content) = fs::read_to_string(&skill_file) {
                    if let Some((name, description)) = parse_skill_md(&content) {
                        skills.push(ClaudeSkill {
                            name,
                            description,
                            plugin: plugin_name.to_string(),
                            scope: scope.to_string(),
                        });
                    }
                }
            }
        }
    }

    // Sort skills alphabetically
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// List all available Claude skills from installed plugins and skills directory
#[tauri::command]
pub fn list_claude_skills(project_path: Option<String>) -> Vec<ClaudeSkill> {
    let mut all_skills = Vec::new();

    let Some(home) = dirs::home_dir() else {
        return all_skills;
    };

    // 1. Check ~/.claude/skills/ for skills installed via skills CLI (user scope)
    let skills_dir = home.join(".claude").join("skills");
    if skills_dir.exists() && skills_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let skill_name = entry.file_name().to_string_lossy().to_string();

                // Look for SKILL.md
                let skill_md = path.join("SKILL.md");
                if skill_md.exists() {
                    if let Ok(content) = fs::read_to_string(&skill_md) {
                        if let Some((name, description)) = parse_skill_md(&content) {
                            all_skills.push(ClaudeSkill {
                                name,
                                description,
                                plugin: skill_name,
                                scope: "user".to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. Check project-level .claude/skills/ if project_path provided
    if let Some(ref proj_path) = project_path {
        let project_skills_dir = PathBuf::from(proj_path).join(".claude").join("skills");
        if project_skills_dir.exists() && project_skills_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&project_skills_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }

                    let skill_name = entry.file_name().to_string_lossy().to_string();

                    // Look for SKILL.md
                    let skill_md = path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Ok(content) = fs::read_to_string(&skill_md) {
                            if let Some((name, description)) = parse_skill_md(&content) {
                                all_skills.push(ClaudeSkill {
                                    name,
                                    description,
                                    plugin: skill_name,
                                    scope: "project".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Check installed_plugins.json for legacy plugin-based skills
    let plugins_json = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");

    if plugins_json.exists() {
        if let Ok(content) = fs::read_to_string(&plugins_json) {
            if let Ok(installed) = serde_json::from_str::<InstalledPlugins>(&content) {
                for (plugin_id, installs) in installed.plugins {
                    let plugin_name = plugin_id.split('@').next().unwrap_or(&plugin_id);

                    for install in installs {
                        if install.scope == "project" {
                            if let Some(ref proj_path) = project_path {
                                if let Some(ref plugin_proj_path) = install.project_path {
                                    if proj_path != plugin_proj_path {
                                        continue;
                                    }
                                }
                            } else {
                                continue;
                            }
                        }

                        let plugin_skills = read_skills_from_plugin(
                            &install.install_path,
                            plugin_name,
                            &install.scope,
                        );
                        all_skills.extend(plugin_skills);
                    }
                }
            }
        }
    }

    // Sort all skills alphabetically and deduplicate by name
    all_skills.sort_by(|a, b| a.name.cmp(&b.name));
    all_skills.dedup_by(|a, b| a.name == b.name);
    all_skills
}

/// Represents a skill search result from the Skills CLI
#[derive(Debug, Serialize, Clone)]
pub struct SkillSearchResult {
    /// Skill name
    pub name: String,
    /// Package identifier (e.g., "owner/repo")
    pub package: String,
    /// Short description of the skill
    pub description: String,
    /// Number of installs (if available)
    pub installs: Option<u64>,
}

/// Check if the Skills CLI is available (npx skills --version)
#[tauri::command]
pub async fn check_skills_cli() -> bool {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let output = create_command("npx")
        .args(["--yes", "skills", "--version"])
        .env("PATH", get_extended_path())
        .env("HOME", &home)
        .output();

    match output {
        Ok(result) => result.status.success(),
        Err(_) => false,
    }
}

/// Search for skills using the Skills CLI
/// Runs: npx skills find "<query>"
#[tauri::command]
pub async fn search_skills(query: String) -> Result<Vec<SkillSearchResult>, String> {
    // Get HOME directory for proper npm config resolution
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    // Use --yes to ensure we always run the latest version
    let output = create_command("npx")
        .args(["--yes", "skills", "find", &query])
        .env("PATH", get_extended_path())
        .env("HOME", &home)
        .env_remove("npm_config__jsr-registry")
        .env_remove("npm_config_npm-globalconfig")
        .env_remove("npm_config_verify-deps-before-run")
        .output()
        .map_err(|e| format!("Failed to run skills CLI: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        // If no results found, return empty array instead of error
        if stderr.contains("No skills found") || stdout.is_empty() {
            return Ok(Vec::new());
        }
        return Err(format!("Skills search failed: {}", stderr));
    }

    parse_skills_find_output(&stdout)
}

/// Parse the output of `npx skills find` command
/// The actual format from the CLI is:
/// ```text
/// owner/repo@skill-name
/// └ https://skills.sh/...
/// ```
fn parse_skills_find_output(output: &str) -> Result<Vec<SkillSearchResult>, String> {
    let mut results = Vec::new();

    // Strip ANSI color codes
    let clean_output = strip_ansi_codes(output);

    for line in clean_output.lines() {
        let line = line.trim();

        // Skip empty lines, banner lines, and URL lines
        if line.is_empty()
            || line.starts_with("└")
            || line.starts_with("Install with")
            || line.contains("███")
            || line.contains("═══")
            || line.contains("╔")
            || line.contains("╗")
            || line.contains("╚")
            || line.contains("╝")
        {
            continue;
        }

        // Parse skill entry: owner/repo@skill-name
        if line.contains('/') && line.contains('@') {
            if let Some(result) = parse_skill_entry(line) {
                results.push(result);
            }
        }
    }

    Ok(results)
}

/// Strip ANSI escape codes from a string
fn strip_ansi_codes(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip until we hit 'm' (end of ANSI sequence)
            while let Some(&next) = chars.peek() {
                chars.next();
                if next == 'm' {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Parse a skill entry line: owner/repo@skill-name
fn parse_skill_entry(line: &str) -> Option<SkillSearchResult> {
    let line = line.trim();

    // Format: owner/repo@skill-name
    let at_pos = line.find('@')?;
    let repo_part = &line[..at_pos]; // owner/repo
    let skill_name = &line[at_pos + 1..]; // skill-name

    // Extract owner and repo
    let slash_pos = repo_part.find('/')?;
    let _owner = &repo_part[..slash_pos];
    let _repo = &repo_part[slash_pos + 1..];

    // The package identifier for installation is the full string
    let package = line.to_string();

    // Use the skill name as the display name, replacing hyphens with spaces for readability
    let name = skill_name.replace('-', " ").replace(':', " - ");

    // Generate a description from the skill name
    let description = format!("Skill: {}", skill_name);

    Some(SkillSearchResult {
        name,
        package,
        description,
        installs: None,
    })
}

/// Install a skill using the Skills CLI
/// Runs: npx skills add <package> -y --agent claude-code
#[tauri::command]
pub async fn install_skill(
    package: String,
    scope: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut cmd = create_command("npx");
    cmd.args([
        "--yes",
        "skills",
        "add",
        &package,
        "-y",
        "--agent",
        "claude-code",
    ])
    .env("PATH", get_extended_path())
    .env("HOME", &home);

    // Set working directory based on scope
    if scope == "project" {
        if let Some(ref path) = project_path {
            cmd.current_dir(path);
        } else {
            return Err("Project path required for project-scoped installation".to_string());
        }
    } else {
        // For user scope, run from home directory so skills install to ~/.agents/skills
        cmd.current_dir(&home);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run skills CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install skill: {}", stderr));
    }

    Ok(())
}

/// Remove a skill using the Skills CLI
/// Runs: npx skills remove <package> --agent claude-code
#[tauri::command]
pub async fn remove_skill(
    package: String,
    scope: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut cmd = create_command("npx");
    cmd.args([
        "--yes",
        "skills",
        "remove",
        &package,
        "-y",
        "--agent",
        "claude-code",
    ])
    .env("PATH", get_extended_path())
    .env("HOME", &home);

    // Set working directory based on scope
    if scope == "project" {
        if let Some(ref path) = project_path {
            cmd.current_dir(path);
        } else {
            return Err("Project path required for project-scoped removal".to_string());
        }
    } else {
        // For user scope, run from home directory
        cmd.current_dir(&home);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run skills CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to remove skill: {}", stderr));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skill_entry() {
        let line = "vercel-labs/agent-skills@vercel-react-best-practices";
        let result = parse_skill_entry(line);
        assert!(result.is_some());
        let skill = result.unwrap();
        assert_eq!(
            skill.package,
            "vercel-labs/agent-skills@vercel-react-best-practices"
        );
        assert_eq!(skill.name, "vercel react best practices");
    }

    #[test]
    fn test_parse_skill_entry_with_colon() {
        let line = "google-labs-code/stitch-skills@react:components";
        let result = parse_skill_entry(line);
        assert!(result.is_some());
        let skill = result.unwrap();
        assert_eq!(
            skill.package,
            "google-labs-code/stitch-skills@react:components"
        );
        assert_eq!(skill.name, "react - components");
    }

    #[test]
    fn test_strip_ansi_codes() {
        let input = "\x1b[38;5;145mvercel-labs/agent-skills@test\x1b[0m";
        let result = strip_ansi_codes(input);
        assert_eq!(result, "vercel-labs/agent-skills@test");
    }

    #[test]
    fn test_parse_skills_find_output() {
        let output = r#"
vercel-labs/agent-skills@vercel-react-best-practices
└ https://skills.sh/vercel-labs/agent-skills

callstackincubator/agent-skills@react-native-best-practices
└ https://skills.sh/callstackincubator/agent-skills
"#;
        let results = parse_skills_find_output(output).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0].package,
            "vercel-labs/agent-skills@vercel-react-best-practices"
        );
        assert_eq!(
            results[1].package,
            "callstackincubator/agent-skills@react-native-best-practices"
        );
    }

    #[test]
    fn test_parse_skill_md() {
        let content = r#"---
name: brand-guidelines
description: Applies brand colors and typography to artifacts.
license: MIT
---

# Brand Styling

Content here...
"#;
        let result = parse_skill_md(content);
        assert!(result.is_some());
        let (name, desc) = result.unwrap();
        assert_eq!(name, "brand-guidelines");
        assert_eq!(desc, "Applies brand colors and typography to artifacts.");
    }

    #[test]
    fn test_parse_skill_md_no_description() {
        let content = r#"---
name: my-skill
---
"#;
        let result = parse_skill_md(content);
        assert!(result.is_some());
        let (name, desc) = result.unwrap();
        assert_eq!(name, "my-skill");
        assert_eq!(desc, "Custom skill");
    }

    #[test]
    fn test_parse_skill_md_long_description() {
        let content = r#"---
name: verbose-skill
description: This is a very long description that should not be truncated because the frontend handles display truncation via CSS.
---
"#;
        let result = parse_skill_md(content);
        assert!(result.is_some());
        let (_, desc) = result.unwrap();
        assert_eq!(desc, "This is a very long description that should not be truncated because the frontend handles display truncation via CSS.");
    }
}
