/**
 * Changelog component that displays recent releases on the dashboard.
 * Users can click any version to rewind/downgrade to it.
 *
 * ⚠️  RELEASE CHECKLIST: Update the CHANGELOG array below when releasing!
 *     Add new version at the TOP with user-facing changes.
 *     Keep ~15 most recent versions.
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { WarningIcon } from './icons';

interface ChangelogEntry {
  version: string;
  items: string[];
}

// Changelog data - update this with each release!
// Keep ~15 most recent versions for the sidebar
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.3.53',
    items: [
      'HTML/CSS/JS project support - no framework needed',
      'Live reload for static HTML projects',
      'New HTML/CSS/JS starter template',
    ],
  },
  {
    version: '0.3.52',
    items: ['Terminal loading indicator while Claude Code starts up'],
  },
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

type RewindStage = 'confirm' | 'downloading' | 'installing' | 'done' | 'error';

interface ChangelogProps {
  className?: string;
}

export function Changelog({ className = '' }: ChangelogProps) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [rewindVersion, setRewindVersion] = useState<string | null>(null);
  const [rewindStage, setRewindStage] = useState<RewindStage>('confirm');
  const [rewindError, setRewindError] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrentVersion);
  }, []);

  // Listen for progress events from the backend
  useEffect(() => {
    const unlisten = listen<{ stage: string }>('rewind-progress', (event) => {
      const stage = event.payload.stage;
      if (stage === 'downloading' || stage === 'installing' || stage === 'done') {
        setRewindStage(stage);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleRewind = useCallback(async () => {
    if (!rewindVersion) return;
    setRewindStage('downloading');
    setRewindError(null);

    try {
      await invoke('install_version', { version: rewindVersion });
      setRewindStage('done');
    } catch (err: unknown) {
      setRewindStage('error');
      setRewindError(err instanceof Error ? err.message : String(err));
    }
  }, [rewindVersion]);

  const handleRestart = useCallback(async () => {
    try {
      await relaunch();
    } catch {
      setRewindError('Failed to restart. Please restart manually.');
    }
  }, []);

  const closeModal = () => {
    setRewindVersion(null);
    setRewindStage('confirm');
    setRewindError(null);
  };

  const isWorking = rewindStage === 'downloading' || rewindStage === 'installing';

  return (
    <div className={`changelog ${className}`}>
      <div className="changelog-header">
        <h3>What's New</h3>
        <span className="changelog-subtitle">Recent updates</span>
      </div>
      <div className="changelog-list">
        {CHANGELOG.map((entry) => {
          const isCurrent = currentVersion === entry.version;
          return (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-entry-header">
                {isCurrent ? (
                  <span className="changelog-version">
                    v{entry.version}
                    <span className="changelog-current-badge">current</span>
                  </span>
                ) : (
                  <button
                    className="changelog-version changelog-version-link"
                    onClick={() => setRewindVersion(entry.version)}
                  >
                    v{entry.version}
                  </button>
                )}
              </div>
              <ul className="changelog-items">
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Rewind confirmation modal */}
      {rewindVersion && (
        <div className="rewind-modal" onClick={() => !isWorking && closeModal()}>
          <div className="rewind-content" onClick={(e) => e.stopPropagation()}>
            <div className="rewind-header">
              <WarningIcon size={18} />
              <h3>
                {rewindStage === 'confirm' && `Install v${rewindVersion}?`}
                {rewindStage === 'downloading' && 'Downloading...'}
                {rewindStage === 'installing' && 'Installing...'}
                {rewindStage === 'done' && 'Ready to restart'}
                {rewindStage === 'error' && 'Installation failed'}
              </h3>
            </div>
            <div className="rewind-body">
              {rewindStage === 'confirm' && (
                <p>
                  This will replace your current version
                  {currentVersion && <> (v{currentVersion})</>} with{' '}
                  <strong>v{rewindVersion}</strong>. The app will restart afterward.
                </p>
              )}
              {rewindStage === 'downloading' && (
                <>
                  <p>Downloading v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'installing' && (
                <>
                  <p>Installing v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'done' && (
                <p>v{rewindVersion} has been installed. Restart to use it.</p>
              )}
              {rewindStage === 'error' && <p className="rewind-error-text">{rewindError}</p>}
            </div>
            <div className="rewind-actions">
              {rewindStage === 'confirm' && (
                <>
                  <button className="rewind-btn secondary" onClick={closeModal}>
                    Cancel
                  </button>
                  <button className="rewind-btn primary" onClick={() => void handleRewind()}>
                    Install
                  </button>
                </>
              )}
              {isWorking && (
                <button className="rewind-btn secondary" disabled>
                  Please wait...
                </button>
              )}
              {rewindStage === 'done' && (
                <button className="rewind-btn primary" onClick={() => void handleRestart()}>
                  Restart Now
                </button>
              )}
              {rewindStage === 'error' && (
                <>
                  <button className="rewind-btn secondary" onClick={closeModal}>
                    Cancel
                  </button>
                  <button className="rewind-btn primary" onClick={() => void handleRewind()}>
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
