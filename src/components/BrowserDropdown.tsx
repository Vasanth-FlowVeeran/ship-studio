/**
 * Browser selection dropdown component.
 *
 * Displays the "Open in Browser" button with a dropdown for selecting
 * a specific browser. Default click opens in system default browser.
 *
 * @module components/BrowserDropdown
 */

import { useState, useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ExternalLinkIcon,
  ChevronIcon,
  SafariIcon,
  ChromeIcon,
  FirefoxIcon,
  ArcIcon,
  BraveIcon,
  EdgeIcon,
  GlobeIcon,
} from './icons';
import { BrowserInfo, checkBrowserAvailability, openUrlInBrowser } from '../lib/browser';
import { logger } from '../lib/logger';

interface BrowserDropdownProps {
  url: string;
  className?: string;
  buttonClassName?: string;
}

const BROWSER_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  safari: SafariIcon,
  chrome: ChromeIcon,
  firefox: FirefoxIcon,
  arc: ArcIcon,
  brave: BraveIcon,
  edge: EdgeIcon,
};

export function BrowserDropdown({
  url,
  className = '',
  buttonClassName = 'preview-action-btn',
}: BrowserDropdownProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [openingBrowser, setOpeningBrowser] = useState<string | null>(null);

  // Check browser availability on mount
  useEffect(() => {
    void checkBrowserAvailability()
      .then((result) => setBrowsers(result))
      .catch(() => setBrowsers([]));
  }, []);

  const handleDefaultOpen = () => {
    void openUrl(url);
  };

  const handleBrowserOpen = async (browserId: string) => {
    setOpeningBrowser(browserId);
    try {
      await openUrlInBrowser(url, browserId);
      setShowDropdown(false);
    } catch (e) {
      logger.error(`Failed to open in ${browserId}`, { error: e });
    } finally {
      setOpeningBrowser(null);
    }
  };

  const getBrowserIcon = (browserId: string) => {
    const IconComponent = BROWSER_ICONS[browserId] || GlobeIcon;
    return <IconComponent size={14} />;
  };

  // If no browsers detected, show simple button
  if (browsers.length === 0) {
    return (
      <button className={buttonClassName} onClick={handleDefaultOpen} title="Open in Browser">
        <ExternalLinkIcon size={14} />
        <span>Open in Browser</span>
      </button>
    );
  }

  return (
    <div
      className={`browser-dropdown-container ${className}`}
      onMouseEnter={() => setShowDropdown(true)}
      onMouseLeave={() => setShowDropdown(false)}
    >
      <button
        className={`${buttonClassName} browser-dropdown-trigger`}
        onClick={handleDefaultOpen}
        title="Open in Browser (click for default, hover for options)"
      >
        <ExternalLinkIcon size={14} />
        <span>Open in Browser</span>
        <ChevronIcon size={10} className="browser-dropdown-chevron" />
      </button>
      {showDropdown && (
        <div className="browser-dropdown">
          <div className="browser-dropdown-inner">
            {browsers.map((browser) => (
              <button
                key={browser.id}
                onClick={() => void handleBrowserOpen(browser.id)}
                disabled={openingBrowser !== null}
              >
                {getBrowserIcon(browser.id)}
                {openingBrowser === browser.id ? 'Opening...' : browser.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
