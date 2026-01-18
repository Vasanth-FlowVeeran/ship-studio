import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// Constants
const ZOOM_MIN = 50;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;
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
}

export function Preview({ port = 3000, projectPath, onServerReady }: PreviewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [serverReady, setServerReady] = useState(false);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("desktop");
  const [zoom, setZoom] = useState(100);
  const [zoomInputValue, setZoomInputValue] = useState(""); // Only used while editing
  const [isEditingZoom, setIsEditingZoom] = useState(false);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [currentPage, setCurrentPage] = useState("/");
  const [showPageDropdown, setShowPageDropdown] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const baseUrl = `http://localhost:${port}`;
  const currentUrl = `${baseUrl}${currentPage === "/" ? "" : currentPage}`;

  // Zoom calculations
  const zoomScale = zoom / 100;
  const inverseZoom = 100 / zoomScale; // For scaling iframe to compensate

  // Clamp zoom to valid range
  const clampZoom = (value: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));

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

  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
    setServerReady(false);

    const checkServer = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);

        await fetch(baseUrl, {
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
  }, [baseUrl, retryCount]);

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
      const newUrl = `${baseUrl}${route === "/" ? "" : route}`;
      iframeRef.current.src = newUrl;
    }
  };

  const handleZoomChange = (delta: number) => {
    setZoom(clampZoom(zoom + delta));
  };

  const handleZoomInputBlur = () => {
    const parsed = parseInt(zoomInputValue, 10);
    setZoom(isNaN(parsed) ? 100 : clampZoom(parsed));
    setIsEditingZoom(false);
  };

  const filteredPages = pages.filter(page =>
    page.route.toLowerCase().includes(pageSearch.toLowerCase())
  );

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

        <div className="preview-zoom">
          <button onClick={() => handleZoomChange(-ZOOM_STEP)} title="Zoom out">−</button>
          <input
            type="text"
            value={isEditingZoom ? zoomInputValue : `${zoom}%`}
            onChange={(e) => setZoomInputValue(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={() => {
              setIsEditingZoom(true);
              setZoomInputValue(String(zoom));
            }}
            onBlur={handleZoomInputBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <button onClick={() => handleZoomChange(ZOOM_STEP)} title="Zoom in">+</button>
        </div>
      </div>
      <div className="preview-viewport">
        <div
          className="preview-iframe-wrapper"
          style={{
            width: BREAKPOINTS[breakpoint].width,
            maxWidth: "100%",
          }}
        >
          <iframe
            ref={iframeRef}
            src={serverReady ? currentUrl : "about:blank"}
            className="preview-iframe"
            style={{
              width: `${inverseZoom}%`,
              height: `${inverseZoom}%`,
              transform: `scale(${zoomScale})`,
              transformOrigin: "top left",
            }}
            title="Preview"
          />
        </div>
      </div>
    </div>
  );
}
