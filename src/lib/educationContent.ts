/**
 * Educational content for the Education Mode feature.
 *
 * This module defines tooltip content for UI elements that can be
 * highlighted when Education Mode is active. Each element is identified
 * by a unique ID that matches the data-education-id attribute on the element.
 *
 * IMPORTANT: All descriptions are written for non-technical users who may
 * not be familiar with terms like "git", "branch", "commit", etc.
 * Explain concepts in plain language.
 *
 * @module lib/educationContent
 */

export interface EducationItem {
  /** Short title displayed in the tooltip header */
  title: string;
  /** Longer description explaining what the element does */
  description: string;
}

/**
 * Map of education IDs to their tooltip content.
 * The keys correspond to data-education-id attributes on UI elements.
 */
export const educationContent: Record<string, EducationItem> = {
  // Header toolbar items
  'branch-indicator': {
    title: 'Current Version',
    description:
      "Shows which version of your project you're working on. You can create separate versions to try new ideas without affecting your live site. Click to see all versions.",
  },
  'assets-button': {
    title: 'Assets',
    description:
      'Upload and manage images, fonts, and other files for your website. Files you add here will be available at yoursite.com/filename.',
  },
  'publish-button': {
    title: 'Publish',
    description:
      'Save your work online and make it live. Your changes will be backed up and your website will update automatically.',
  },
  'github-button': {
    title: 'GitHub',
    description:
      'GitHub stores all your project files online and keeps a history of every change. Connect to back up your work and collaborate with others.',
  },
  'env-button': {
    title: 'Secret Settings',
    description:
      'Store private information like API keys and passwords. These values are used by your app but stay hidden and secure.',
  },
  'backups-button': {
    title: 'Backups',
    description:
      'View and restore previous versions of your project. Every time you save, a backup is created automatically. You can go back to any earlier state.',
  },
  'ide-button': {
    title: 'Open in Code Editor',
    description:
      'Open your project in VS Code or Cursor for more advanced editing features beyond what Claude can help with here.',
  },

  // Workspace tabs
  'branches-tab': {
    title: 'Versions',
    description:
      'View and switch between different versions of your project. Create new versions to experiment safely without affecting your live site.',
  },
  'prs-tab': {
    title: 'Review Requests',
    description:
      'Submit your changes for review before making them live. Great for team projects where others need to approve changes first.',
  },

  // Terminal area - granular elements
  'restart-server': {
    title: 'Restart Server',
    description:
      'Restart the preview server if your site stops responding. Use this if the preview looks stuck or shows errors.',
  },
  'health-panel': {
    title: 'Code Health',
    description:
      'Shows whether your code has any errors or warnings. Green means everything looks good, red means something needs attention.',
  },
  'claude-terminal': {
    title: 'Chat with Claude',
    description:
      'Ask Claude to help build features, fix problems, or explain your code. Just type what you want in plain English.',
  },
  'server-logs': {
    title: 'Server Output',
    description:
      "Shows messages from your development server. Helpful for debugging when something isn't working as expected.",
  },
  'health-logs': {
    title: 'Health Check Results',
    description: 'Shows detailed results from code quality checks like tests and error detection.',
  },
  'terminal-tabs': {
    title: 'Chat Sessions',
    description:
      'Each tab is a separate conversation with Claude. Use multiple tabs to work on different tasks at the same time.',
  },

  // Preview area - granular elements
  'preview-viewport': {
    title: 'Live Preview',
    description:
      'See your website as you build it. Changes appear here automatically when Claude updates your code.',
  },
  'page-switcher': {
    title: 'Page Navigation',
    description: 'Switch between different pages of your website to preview them.',
  },
  'preview-refresh': {
    title: 'Refresh Preview',
    description:
      'Reload the preview to see the latest changes. Usually happens automatically, but click here if the preview seems outdated.',
  },
  breakpoints: {
    title: 'Device Sizes',
    description:
      'See how your website looks on different devices - desktop, tablet, or mobile phone.',
  },
  'compact-button': {
    title: 'Compact Mode',
    description:
      'Shrink the app to a smaller window that stays on top. Great for chatting with Claude while working in another app.',
  },
  'browser-button': {
    title: 'Open in Browser',
    description:
      'Open your preview in a full web browser to test features that require a real browser window.',
  },

  // Screenshot tools
  'screenshot-button': {
    title: 'Screenshot',
    description:
      'Take a picture of the current preview and share it with Claude. Useful for showing Claude exactly what you see.',
  },
  'crop-button': {
    title: 'Crop Screenshot',
    description:
      'Select a specific area of the preview to screenshot. Click this, then drag on the preview to select the region.',
  },
  'fullpage-button': {
    title: 'Full Page Screenshot',
    description:
      'Capture the entire page, including parts you need to scroll to see. Great for showing Claude a complete page layout.',
  },

  // Terminal header buttons
  'notification-settings': {
    title: 'Notification Sounds',
    description:
      'Turn sound alerts on or off. Get notified when Claude finishes a task or needs your attention.',
  },
  'skills-manager': {
    title: 'Manage Skills',
    description:
      'Install and manage skills that give Claude specialized abilities. Skills add commands for specific tasks like React patterns or code review.',
  },
  'help-commands': {
    title: 'Help & Commands',
    description:
      'See keyboard shortcuts and all the commands available in the terminal. Find quick ways to navigate and control the app.',
  },

  // Education mode button itself
  'education-button': {
    title: 'Learn Mode',
    description:
      "You're using it now! Hover over any part of the app to learn what it does. Click anywhere or press Escape to exit.",
  },
};
