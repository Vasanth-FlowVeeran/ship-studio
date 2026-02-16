//! # Tauri Commands
//!
//! This module re-exports all Tauri command handlers organized by category.

pub mod ai;
pub mod assets;
pub mod claude;
pub mod conflicts;
pub mod env;
pub mod external_projects;
pub mod folders;
pub mod git;
pub mod github;
pub mod health;
pub mod ide;
pub mod plugins;
pub mod projects;
pub mod proxy;
pub mod pty;
pub mod publishing;
pub mod pull_requests;
pub mod setup;
pub mod skills;
pub mod static_server;
pub mod window;

// Re-export all commands for easy access in lib.rs
pub use ai::*;
pub use assets::*;
pub use claude::*;
pub use conflicts::*;
pub use env::*;
pub use external_projects::*;
pub use folders::*;
pub use git::*;
pub use github::*;
pub use health::*;
pub use ide::*;
pub use plugins::*;
pub use projects::*;
pub use proxy::*;
pub use pty::*;
pub use publishing::*;
pub use pull_requests::*;
pub use setup::*;
pub use skills::*;
pub use static_server::*;
pub use window::*;
