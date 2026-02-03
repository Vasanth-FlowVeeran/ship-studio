/**
 * Skills command module for reading Claude Code skills.
 *
 * Reads user-defined skills from installed Claude plugins.
 * Skills are stored in:
 * - ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/skills/{skill-name}/SKILL.md
 */
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
fn read_skills_from_plugin(
    plugin_path: &str,
    plugin_name: &str,
    scope: &str,
) -> Vec<ClaudeSkill> {
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

/// List all available Claude skills from installed plugins
#[tauri::command]
pub fn list_claude_skills(project_path: Option<String>) -> Vec<ClaudeSkill> {
    let mut all_skills = Vec::new();

    // Get the path to installed_plugins.json
    let Some(home) = dirs::home_dir() else {
        return all_skills;
    };

    let plugins_json = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");

    if !plugins_json.exists() {
        return all_skills;
    }

    // Read and parse installed_plugins.json
    let Ok(content) = fs::read_to_string(&plugins_json) else {
        return all_skills;
    };

    let Ok(installed): Result<InstalledPlugins, _> = serde_json::from_str(&content) else {
        return all_skills;
    };

    // Process each installed plugin
    for (plugin_id, installs) in installed.plugins {
        // Extract a friendly plugin name from the ID (e.g., "example-skills@anthropic-agent-skills" -> "example-skills")
        let plugin_name = plugin_id.split('@').next().unwrap_or(&plugin_id);

        for install in installs {
            // For project-scoped plugins, only include if we're in that project
            if install.scope == "project" {
                if let Some(ref proj_path) = project_path {
                    if let Some(ref plugin_proj_path) = install.project_path {
                        if proj_path != plugin_proj_path {
                            continue;
                        }
                    }
                } else {
                    // No project path provided, skip project-scoped plugins
                    continue;
                }
            }

            let plugin_skills =
                read_skills_from_plugin(&install.install_path, plugin_name, &install.scope);
            all_skills.extend(plugin_skills);
        }
    }

    // Sort all skills alphabetically
    all_skills.sort_by(|a, b| a.name.cmp(&b.name));
    all_skills
}

#[cfg(test)]
mod tests {
    use super::*;

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
