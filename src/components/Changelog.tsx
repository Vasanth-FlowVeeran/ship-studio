/**
 * Changelog component that displays recent releases on the dashboard.
 *
 * ⚠️  RELEASE CHECKLIST: Update the CHANGELOG array below when releasing!
 *     Add new version at the TOP with user-facing changes.
 *     Keep ~15 most recent versions.
 */

interface ChangelogEntry {
  version: string;
  items: string[];
}

// Changelog data - update this with each release!
// Keep ~15 most recent versions for the sidebar
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.3.51',
    items: ['Import repos you collaborate on (not just owned)', 'Fix dev server restart crashes'],
  },
  {
    version: '0.3.50',
    items: [
      'Fix npm cache permission errors during setup',
      'Slack community banner on welcome screen',
    ],
  },
  {
    version: '0.3.49',
    items: [
      'Import local folders as projects',
      'Link existing Vercel projects',
      'Vercel project list shows all projects (pagination)',
    ],
  },
  {
    version: '0.3.48',
    items: [
      'Nuxt/Vue support - new Nuxt Basic template',
      'Page selector tracks in-iframe navigation',
      'Faster onboarding with batched installs',
      'Better onboarding error messages',
    ],
  },
  {
    version: '0.3.47',
    items: [
      'Dashboard changelog sidebar',
      'GitHub contribution calendar',
      'Better Vercel CLI error messages',
      'Improved dashboard header styling',
    ],
  },
  {
    version: '0.3.46',
    items: [
      'Safe Backup Restore - creates branch for PR review',
      'Clickable project path opens in Finder',
      'Astro page selector support',
    ],
  },
  {
    version: '0.3.45',
    items: ['Astro support - new Astro Basic template'],
  },
  {
    version: '0.3.44',
    items: ['Vercel site URLs dropdown on hover', 'Slack community CTA'],
  },
  {
    version: '0.3.43',
    items: ['Fixed Vercel CLI detection for nvm'],
  },
  {
    version: '0.3.42',
    items: ['Skills Manager - install Claude skills', 'Help & Commands modal'],
  },
  {
    version: '0.3.41',
    items: ['Education Mode - learn UI elements'],
  },
  {
    version: '0.3.37',
    items: ['Terminal Focus Indicator', 'Notification Sounds'],
  },
  {
    version: '0.3.36',
    items: ['Responsive breakpoints', 'Fixed viewport screenshots'],
  },
  {
    version: '0.3.33',
    items: ['Export project as template'],
  },
  {
    version: '0.3.32',
    items: ['Preview breakpoints - 5 responsive sizes'],
  },
  {
    version: '0.3.28',
    items: ['Resizable preview panel', 'Global search in folders'],
  },
  {
    version: '0.3.25',
    items: ['File diff viewer'],
  },
  {
    version: '0.3.21',
    items: ['SvelteKit support'],
  },
  {
    version: '0.3.18',
    items: ['Folders', 'Yolo Mode toggle'],
  },
  {
    version: '0.3.13',
    items: ['Browser picker', 'Deep links support'],
  },
];

interface ChangelogProps {
  className?: string;
}

export function Changelog({ className = '' }: ChangelogProps) {
  return (
    <div className={`changelog ${className}`}>
      <div className="changelog-header">
        <h3>What's New</h3>
        <span className="changelog-subtitle">Recent updates</span>
      </div>
      <div className="changelog-list">
        {CHANGELOG.map((entry) => (
          <div key={entry.version} className="changelog-entry">
            <div className="changelog-entry-header">
              <span className="changelog-version">v{entry.version}</span>
            </div>
            <ul className="changelog-items">
              {entry.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
