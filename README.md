# Marketingstack

Build AI-native marketing sites easily with SOTA technology.

Marketingstack is a desktop application that combines Claude Code's AI capabilities with a streamlined development environment for creating Next.js marketing websites. It provides an integrated terminal, live preview, and seamless GitHub integration—all in one native app.

## Features

- **AI-Powered Development** - Built-in Claude Code terminal for AI-assisted coding
- **Live Preview** - Real-time preview with responsive breakpoints (Desktop, Tablet, Mobile)
- **Project Management** - Visual project cards with automatic screenshot thumbnails
- **GitHub Integration** - One-click repo creation and publishing with smart change detection
- **Vercel Integration** - Deploy to production with one click, auto-deploys on push
- **Page Navigation** - Quick switcher for all your Next.js routes

## Prerequisites

Before running Marketingstack, make sure you have the following installed:

| Tool | Required | Installation |
|------|----------|--------------|
| **Node.js** | Yes | [nodejs.org](https://nodejs.org/) |
| **npm** | Yes | Comes with Node.js |
| **Git** | Yes | [git-scm.com](https://git-scm.com/) |
| **Claude Code CLI** | Yes | `npm install -g @anthropic-ai/claude-code` |
| **GitHub CLI** | Optional | [cli.github.com](https://cli.github.com/) |
| **Vercel CLI** | Optional | `npm install -g vercel` |
| **Rust** | For development | [rustup.rs](https://rustup.rs/) |

## Quick Start

### Running the App

```bash
# Clone the repository
git clone https://github.com/Memberstack/marketingstack.git
cd marketingstack

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

### Building for Production

```bash
# Build the app
pnpm tauri build

# The built app will be in src-tauri/target/release/bundle/
```

## Development Setup

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### 2. Install Node Dependencies

```bash
pnpm install
```

### 3. Run Development Server

```bash
pnpm tauri dev
```

This will start both the Vite dev server and the Tauri application.

## Project Structure

```
marketingstack/
├── src/                    # React frontend
│   ├── components/         # UI components
│   │   ├── Terminal.tsx    # Claude Code terminal
│   │   ├── Preview.tsx     # Live preview iframe
│   │   ├── GitHubButton.tsx# GitHub integration
│   │   ├── VercelButton.tsx# Vercel deployment
│   │   ├── CreateProject.tsx # Project creation wizard
│   │   └── ...
│   ├── lib/                # Utilities
│   │   ├── github.ts       # GitHub API helpers
│   │   ├── vercel.ts       # Vercel API helpers
│   │   └── project.ts      # Project management
│   ├── App.tsx             # Main application
│   └── App.css             # Styles
├── src-tauri/              # Rust backend
│   ├── src/
│   │   └── lib.rs          # Tauri commands
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # Tauri configuration
└── package.json
```

## How It Works

### Creating a Project

1. Click **"+ New Project"** on the home screen
2. Enter a project name
3. Marketingstack clones the Next.js template and installs dependencies
4. You're dropped into the workspace with Claude Code ready to go

### GitHub Integration

Marketingstack integrates with GitHub CLI for seamless version control:

1. **No Repo** → Shows "Create Repo" button
2. **Create Repo** → Opens modal to name your repo (public/private)
3. **Connected** → Shows "Publish" button
   - Greyed out when up-to-date
   - Active when changes detected (polls every 5s)
4. **Publish** → Confirmation modal → Commits & pushes

### Vercel Integration

Deploy your projects to production with one click:

1. **Connect Vercel** → Authenticate with your Vercel account
2. **Deploy to Vercel** → Links project and deploys to production
3. **Live** → Opens your live site at `https://your-project.vercel.app`

Auto-deploys are enabled when connected to GitHub—every push triggers a new deployment.

### Project Thumbnails

When you close a project, Marketingstack automatically captures a screenshot of your site at `localhost:3000` and saves it as a thumbnail for the project card.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Rust + Tauri 2
- **Terminal**: xterm.js with PTY support
- **Styling**: CSS Variables (dark theme)
- **Fonts**: JetBrains Mono Nerd Font

## Configuration

### Tauri Config

Edit `src-tauri/tauri.conf.json` to modify:
- Window size and title
- App identifier
- Build settings

### Template Repository

The Next.js template is cloned from:
```
https://github.com/julianmemberstack/marketingstack-boilerplate-next-1
```

To use a different template, update `TEMPLATE_REPO` in `src/components/CreateProject.tsx`.

## Troubleshooting

### Terminal not responding after modal

Click on the terminal area to refocus it.

### GitHub CLI not detected

Make sure `gh` is installed and in your PATH:
```bash
gh --version
gh auth login
```

### Build errors on macOS

Ensure Xcode Command Line Tools are installed:
```bash
xcode-select --install
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT

---

Built with Claude Code
