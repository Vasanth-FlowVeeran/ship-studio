/**
 * Code browser tab container component.
 *
 * Combines a file tree sidebar with a syntax-highlighted code viewer.
 * Includes a draggable divider for resizing the two panes.
 */

import { useCallback, useRef, useState } from 'react';
import { useFileTree } from '../hooks/useFileTree';
import { FileTree } from './FileTree';
import { CodeViewer } from './CodeViewer';
import { ResetIcon } from './icons';

interface CodeTabProps {
  projectPath: string;
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  onSendToAgent?: (text: string) => void;
}

export function CodeTab({ projectPath, onToast, onSendToAgent }: CodeTabProps) {
  const {
    tree,
    expandedPaths,
    selectedFilePath,
    fileContent,
    isLoadingTree,
    isLoadingFile,
    treeError,
    fileError,
    toggleDirectory,
    selectFile,
    refreshTree,
  } = useFileTree(projectPath);

  const [sidebarWidth, setSidebarWidth] = useState(250);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = e.clientX - containerRect.left;
      setSidebarWidth(Math.max(150, Math.min(newWidth, 500)));
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  return (
    <div className="code-tab" ref={containerRef}>
      <div className="code-tab-sidebar" style={{ width: sidebarWidth }}>
        <div className="code-tab-sidebar-header">
          <span className="code-tab-sidebar-title">Files</span>
          <button className="code-tab-refresh-btn" onClick={refreshTree} title="Refresh file tree">
            <ResetIcon size={12} />
          </button>
        </div>
        <div className="code-tab-sidebar-content">
          {isLoadingTree ? (
            <div className="code-tab-sidebar-loading">
              <div className="capture-spinner" />
            </div>
          ) : treeError ? (
            <div className="code-tab-sidebar-error">
              <span>Failed to load files</span>
              <button className="code-tab-retry-btn" onClick={refreshTree}>
                Retry
              </button>
            </div>
          ) : tree.length === 0 ? (
            <div className="code-tab-sidebar-empty">No files found</div>
          ) : (
            <FileTree
              nodes={tree}
              expandedPaths={expandedPaths}
              selectedFilePath={selectedFilePath}
              onToggleDirectory={toggleDirectory}
              onSelectFile={selectFile}
            />
          )}
        </div>
      </div>
      <div className="code-tab-divider" onMouseDown={handleMouseDown} />
      <div className="code-tab-viewer">
        <CodeViewer
          projectPath={projectPath}
          filePath={selectedFilePath}
          fileContent={fileContent}
          isLoading={isLoadingFile}
          error={fileError}
          onToast={onToast}
          onSendToAgent={onSendToAgent}
        />
      </div>
    </div>
  );
}
