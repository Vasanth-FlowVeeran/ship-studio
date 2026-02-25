/**
 * Application entry point.
 *
 * Renders the main App component into the DOM root element.
 * Wrapped in React.StrictMode for development warnings and checks.
 *
 * Supports multi-window: if a `project` URL parameter is present,
 * the window opens directly to that project instead of the projects list.
 *
 * @module main
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { exposeReactGlobals } from './lib/plugin-loader';
import { exposePluginContextRef } from './contexts/PluginContext';
import { OverlayScrollbars } from 'overlayscrollbars';
import 'overlayscrollbars/overlayscrollbars.css';

// Expose React globals and context ref for plugins before any rendering
exposeReactGlobals(React, ReactDOM);
exposePluginContextRef();

// Initialize OverlayScrollbars on scrollable elements.
// Uses a debounced MutationObserver to catch dynamically added containers.
// Skips elements with scrollbar-width: none (intentionally hidden scrollbars).
const OS_ATTR = 'data-os-init';
const OS_OPTS = { scrollbars: { theme: 'os-theme-shipstudio', autoHide: 'move' as const } };

function initScrollbars() {
  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (el.closest('.modal-overlay')) return;
    if (el.hasAttribute(OS_ATTR)) return;
    const style = getComputedStyle(el);
    if (style.scrollbarWidth === 'none') return;
    const oy = style.overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      el.setAttribute(OS_ATTR, '');
      OverlayScrollbars(el, OS_OPTS);
    }
  });
}

requestAnimationFrame(() => {
  initScrollbars();

  let timer: number;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(initScrollbars, 150);
  }).observe(document.body, { childList: true, subtree: true });
});

// Parse project path from URL if present (for project windows)
const urlParams = new URLSearchParams(window.location.search);
const initialProjectPath = urlParams.get('project');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App initialProjectPath={initialProjectPath} />
    </ErrorBoundary>
  </React.StrictMode>
);
