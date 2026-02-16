/**
 * Hello World test plugin for Ship Studio.
 *
 * Validates the entire plugin pipeline:
 * - Module loading via Blob URL
 * - React globals from host
 * - Plugin context bridge (showToast)
 * - Slot rendering in toolbar
 */

const React = window.__SHIPSTUDIO_REACT__;

function HelloWorldButton() {
  const ctx = window.__SHIPSTUDIO_PLUGIN_CONTEXT__;

  const handleClick = () => {
    if (ctx && ctx.actions && ctx.actions.showToast) {
      ctx.actions.showToast('Hello from plugin!', 'success');
    }
  };

  return React.createElement(
    'button',
    {
      onClick: handleClick,
      title: 'Hello World Plugin',
      className: 'workspace-tab icon-only',
      style: {
        fontSize: '11px',
        fontWeight: 600,
        padding: '0 6px',
        minWidth: 'auto',
      },
    },
    'HW'
  );
}

// Plugin module exports
export const name = 'Hello World';

export const slots = {
  toolbar: HelloWorldButton,
};

export function onActivate() {
  console.log('[hello-world] Plugin activated');
}

export function onDeactivate() {
  console.log('[hello-world] Plugin deactivated');
}
