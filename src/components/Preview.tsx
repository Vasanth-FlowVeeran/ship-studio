import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// Constants
const PAGE_REFRESH_INTERVAL_MS = 5000;
const SERVER_CHECK_TIMEOUT_MS = 3000;
const SERVER_MAX_RETRIES = 60;

type Breakpoint = "desktop" | "tablet" | "mobile";

interface PageInfo {
  route: string;
  file_path: string;
}

const BREAKPOINTS: Record<Breakpoint, { width: string; label: string }> = {
  desktop: { width: "100%", label: "Desktop" },
  tablet: { width: "768px", label: "Tablet" },
  mobile: { width: "375px", label: "Mobile" },
};

// SVG icons for breakpoints
const BreakpointIcon = ({ type }: { type: Breakpoint }) => {
  if (type === "desktop") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    );
  }
  if (type === "tablet") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" />
    </svg>
  );
};

interface PreviewProps {
  port?: number;
  projectPath: string;
  onServerReady?: () => void;
  onPageChange?: (page: string) => void;
}

export interface PreviewHandle {
  captureForClaude: () => Promise<string | null>;
  isCapturing: () => boolean;
}

export const Preview = forwardRef<PreviewHandle, PreviewProps>(function Preview({ port = 3000, projectPath, onServerReady, onPageChange }, ref) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [serverReady, setServerReady] = useState(false);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("desktop");
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [currentPage, setCurrentPage] = useState("/");
  const [hasSanity, setHasSanity] = useState(false);
  const [sanityMissingEnvKeys, setSanityMissingEnvKeys] = useState<string[]>([]);
  const [showEnvWarning, setShowEnvWarning] = useState(false);
  const [showPageDropdown, setShowPageDropdown] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  const [showCmsModal, setShowCmsModal] = useState(false);
  const [cmsWebviewReady, setCmsWebviewReady] = useState(false);
  const [isCapturing] = useState(false); // Capture disabled for now
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cmsModalRef = useRef<HTMLDivElement>(null);

  // Dev server URL (for health checks and page loading)
  const devServerUrl = `http://localhost:${port}`;
  // For now, always use dev server directly (proxy disabled due to issues)
  const currentUrl = `${devServerUrl}${currentPage === "/" ? "" : currentPage}`;

  // Reset state when project changes
  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
    setServerReady(false);
    setRetryCount(-1); // -1 = not checking yet
    setCurrentPage("/");
    setPages([]);
    setHasSanity(false);
    setSanityMissingEnvKeys([]);
    setShowEnvWarning(false);
    setShowPageDropdown(false);
    setPageSearch("");
    setShowCmsModal(false);
    setCmsWebviewReady(false);

    // Delay server check to allow old dev server to terminate
    const timer = setTimeout(() => setRetryCount(0), 1500);
    return () => clearTimeout(timer);
  }, [projectPath]);

  // Proxy disabled for now - using dev server directly
  // TODO: Implement capture using Tauri webview script injection instead

  // Load pages
  const loadPages = async () => {
    try {
      const pageList = await invoke<PageInfo[]>("list_pages", { projectPath });
      setPages(pageList);
    } catch (error) {
      console.error("Failed to load pages:", error);
    }
  };

  // Load pages on mount and periodically
  useEffect(() => {
    loadPages();
    const interval = setInterval(loadPages, PAGE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [projectPath]);

  // Check for Sanity CMS (on interval to detect when added)
  useEffect(() => {
    const checkSanity = async () => {
      if (!projectPath) return;
      try {
        const installed = await invoke<boolean>('check_sanity_installed', { projectPath });
        setHasSanity(installed);
        if (installed) {
          const missing = await invoke<string[]>('check_sanity_env_keys', { projectPath });
          setSanityMissingEnvKeys(missing);
        } else {
          setSanityMissingEnvKeys([]);
        }
      } catch {
        setHasSanity(false);
        setSanityMissingEnvKeys([]);
      }
    };

    checkSanity();
    const interval = setInterval(checkSanity, PAGE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [projectPath]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowPageDropdown(false);
        setPageSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (showPageDropdown && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showPageDropdown]);

  // Notify parent when server becomes ready
  useEffect(() => {
    if (serverReady && onServerReady) {
      onServerReady();
    }
  }, [serverReady, onServerReady]);

  // Notify parent when page changes
  useEffect(() => {
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

  useEffect(() => {
    // Skip if not ready to check yet (-1 means waiting for old server to die)
    if (retryCount < 0) return;

    setIsLoading(true);
    setHasError(false);
    setServerReady(false);

    const checkServer = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);

        await fetch(devServerUrl, {
          mode: "no-cors",
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        setIsLoading(false);
        setHasError(false);
        setServerReady(true);
      } catch {
        if (retryCount < SERVER_MAX_RETRIES) {
          setTimeout(() => setRetryCount((c) => c + 1), 1000);
        } else {
          setIsLoading(false);
          setHasError(true);
        }
      }
    };

    checkServer();
  }, [devServerUrl, retryCount]);

  const handleRefresh = () => {
    if (iframeRef.current) {
      iframeRef.current.src = currentUrl + "?t=" + Date.now();
    }
  };

  const handlePageSelect = (route: string) => {
    setCurrentPage(route);
    setShowPageDropdown(false);
    setPageSearch("");
    if (iframeRef.current && serverReady) {
      const newUrl = `${devServerUrl}${route === "/" ? "" : route}`;
      iframeRef.current.src = newUrl;
    }
  };

  // Capture preview screenshot using Tauri window capture + crop
  const captureForClaude = useCallback(async (): Promise<string | null> => {
    if (!iframeWrapperRef.current) {
      return null;
    }

    try {
      const { getScreenshotableWindows, getWindowScreenshot } = await import("tauri-plugin-screenshots-api");

      const windows = await getScreenshotableWindows();
      const ourWindow = windows.find(w =>
        w.title?.toLowerCase().includes("marketingstack") ||
        w.title?.toLowerCase().includes("tauri")
      );

      if (!ourWindow) {
        return null;
      }

      // Capture the full window
      const tempPath = await getWindowScreenshot(ourWindow.id);

      // Get the iframe's bounding rect and account for device pixel ratio
      const rect = iframeWrapperRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Crop to iframe bounds and save
      const finalPath = await invoke<string>("crop_and_save_screenshot", {
        projectPath,
        sourcePath: tempPath,
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      });

      return finalPath;
    } catch (error) {
      console.error("[Preview] Capture failed:", error);
      return null;
    }
  }, [projectPath]);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    captureForClaude,
    isCapturing: () => isCapturing,
  }), [captureForClaude, isCapturing]);

  // Open CMS modal with native webview
  const handleOpenCms = () => {
    setShowCmsModal(true);
  };

  // Close CMS modal and destroy webview
  const handleCloseCms = async () => {
    try {
      await invoke("destroy_preview_webview");
    } catch (error) {
      console.error("Failed to destroy webview:", error);
    }
    setCmsWebviewReady(false);
    setShowCmsModal(false);
  };

  // Create webview when CMS modal opens
  useEffect(() => {
    if (!showCmsModal || !cmsModalRef.current || !serverReady) return;

    const createCmsWebview = async () => {
      const TITLE_BAR_HEIGHT = 31;
      const MAX_RETRIES = 20;
      const RETRY_DELAY_MS = 50;

      // Wait for modal to have valid dimensions (retry until rect is valid)
      let rect: DOMRect | null = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        rect = cmsModalRef.current?.getBoundingClientRect() ?? null;

        // Check if rect has valid dimensions
        if (rect && rect.width > 0 && rect.height > 0) {
          break;
        }

        // Wait before next retry
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }

      if (!rect || rect.width === 0 || rect.height === 0) {
        console.error("CMS modal never achieved valid dimensions");
        return;
      }

      try {
        // Load Sanity Studio (use dev server directly, not proxy)
        await invoke("create_preview_webview", {
          url: `${devServerUrl}/studio`,
          x: rect.left,
          y: rect.top + TITLE_BAR_HEIGHT,
          width: rect.width,
          height: rect.height + 2, // Small buffer to prevent gap at bottom
        });
        setCmsWebviewReady(true);
      } catch (error) {
        console.error("Failed to create CMS webview:", error);
      }
    };

    createCmsWebview();

    // Handle resize
    const handleResize = async () => {
      if (!cmsModalRef.current) return;
      const rect = cmsModalRef.current.getBoundingClientRect();
      const TITLE_BAR_HEIGHT = 31;
      try {
        await invoke("resize_preview_webview", {
          x: rect.left,
          y: rect.top + TITLE_BAR_HEIGHT,
          width: rect.width,
          height: rect.height + 2,
        });
      } catch (error) {
        console.error("Failed to resize webview:", error);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [showCmsModal, serverReady, devServerUrl]);

  const filteredPages = pages
    .filter(page => page.route !== "/studio") // Hide Sanity Studio from page list
    .filter(page => page.route.toLowerCase().includes(pageSearch.toLowerCase()));

  if (isLoading) {
    return (
      <div className="preview-loading">
        <div className="spinner" />
        <p>Starting dev server...</p>
        <p className="hint">Waiting for localhost:{port}</p>
        <p className="hint" style={{ marginTop: 8, fontSize: 11 }}>
          {retryCount > 0 && `Attempt ${retryCount}/${SERVER_MAX_RETRIES}`}
        </p>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="preview-error">
        <p>Could not connect to dev server</p>
        <p className="hint">Ask Claude to run: npm run dev</p>
        <button onClick={() => setRetryCount(0)}>Retry</button>
      </div>
    );
  }

  return (
    <div className="preview-container">
      <div className="preview-toolbar">
        {/* Page Switcher */}
        <div className="page-switcher" ref={dropdownRef}>
          <button
            className="page-switcher-btn"
            onClick={() => setShowPageDropdown(!showPageDropdown)}
          >
            <span className="page-route">{currentPage}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showPageDropdown && (
            <div className="page-dropdown">
              <input
                ref={searchInputRef}
                type="text"
                className="page-search"
                placeholder="Search pages..."
                value={pageSearch}
                onChange={(e) => setPageSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filteredPages.length > 0) {
                    handlePageSelect(filteredPages[0].route);
                  }
                  if (e.key === "Escape") {
                    setShowPageDropdown(false);
                    setPageSearch("");
                  }
                }}
              />
              <div className="page-list">
                {filteredPages.length === 0 ? (
                  <div className="page-list-empty">No pages found</div>
                ) : (
                  filteredPages.map((page) => (
                    <button
                      key={page.route}
                      className={`page-item ${page.route === currentPage ? "active" : ""}`}
                      onClick={() => handlePageSelect(page.route)}
                    >
                      {page.route}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button
          className="preview-refresh"
          onClick={handleRefresh}
          title="Refresh preview"
        >
          ↻
        </button>

        {hasSanity && (
          <div className="cms-button-wrapper">
            <button
              className={`cms-button ${sanityMissingEnvKeys.length > 0 ? 'cms-button-warning' : ''}`}
              onClick={() => {
                if (sanityMissingEnvKeys.length > 0) {
                  setShowEnvWarning(!showEnvWarning);
                } else {
                  handleOpenCms();
                }
              }}
              title={sanityMissingEnvKeys.length > 0 ? "Sanity env vars missing" : "Open Sanity Studio"}
            >
              <svg width="14" height="14" viewBox="30 46 195 163" fill="currentColor">
                <path d="M215.759 152.483L208.799 140.366L175.13 160.88L212.526 113.252L218.179 109.933L216.78 107.831L219.349 104.548L207.549 94.7227L202.147 101.608L93.1263 165.414L133.434 116.925L208.512 75.7566L201.379 61.963L160.486 84.3775L180.623 60.168L169.087 50L123.767 104.513L78.7575 129.206L113.217 83.6335L134.811 72.3909L127.953 58.4438L65.0424 91.2034L82.1978 68.4937L70.2143 58.8926L34 106.839L34.5619 107.288L41.3277 121.07L81.4753 100.155L44.8826 148.539L50.8801 153.345L54.4465 160.242L96.7156 137.06L50.1691 193.061L61.7054 203.229L64.0218 200.442L176.311 134.509L139.031 182.007L139.638 182.515L139.581 182.55L147.31 196.001L196.895 165.781L177.802 196.603L190.6 205L221 155.931L215.759 152.483Z" />
              </svg>
              {sanityMissingEnvKeys.length > 0 ? 'Sanity' : 'Open Sanity'}
              {sanityMissingEnvKeys.length > 0 && (
                <span className="cms-warning-badge">!</span>
              )}
            </button>
            {showEnvWarning && sanityMissingEnvKeys.length > 0 && (
              <div className="cms-env-warning">
                <div className="cms-env-warning-header">
                  <span>Missing Sanity Environment Variables</span>
                  <button onClick={() => setShowEnvWarning(false)}>×</button>
                </div>
                <p>Add these keys to your environment variables:</p>
                <ul>
                  {sanityMissingEnvKeys.map(key => (
                    <li key={key}><code>{key}</code></li>
                  ))}
                </ul>
                <p className="cms-env-warning-hint">Click the Env Vars button in the sidebar to configure.</p>
              </div>
            )}
          </div>
        )}

        <div className="preview-breakpoints">
          {(Object.keys(BREAKPOINTS) as Breakpoint[]).map((bp) => (
            <button
              key={bp}
              className={`breakpoint-btn ${breakpoint === bp ? "active" : ""}`}
              onClick={() => setBreakpoint(bp)}
              title={BREAKPOINTS[bp].label}
            >
              <BreakpointIcon type={bp} />
            </button>
          ))}
        </div>
      </div>
      <div className="preview-viewport">
        <div
          ref={iframeWrapperRef}
          className="preview-iframe-wrapper"
          style={{
            width: BREAKPOINTS[breakpoint].width,
            maxWidth: "100%",
          }}
        >
          <iframe
            key={projectPath}
            ref={iframeRef}
            src={serverReady ? currentUrl : "about:blank"}
            className="preview-iframe"
            title="Preview"
          />
        </div>
      </div>

      {/* CMS Modal with native webview */}
      {showCmsModal && (
        <div className="cms-modal-overlay">
          <div className="cms-modal">
            <div className="cms-modal-header">
              <span className="cms-modal-title">Sanity Studio</span>
              <button className="cms-modal-close" onClick={handleCloseCms}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="cms-modal-content" ref={cmsModalRef}>
              {!cmsWebviewReady && (
                <div className="cms-modal-loading">
                  <div className="spinner" />
                  <p>Loading Sanity Studio...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
