import React, { useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import { tokens } from './styles';

export interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

function ModalActions({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const theme = useTheme();

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        paddingTop: 16,
        marginTop: 16,
        borderTop: `1px solid ${theme.border}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function ModalRoot({ onClose, children, style }: ModalProps) {
  const theme = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.5)',
        zIndex: 9999,
      }}
    >
      <div
        ref={panelRef}
        style={{
          background: theme.bgSecondary,
          border: `1px solid ${theme.border}`,
          borderRadius: tokens.borderRadius.lg,
          padding: 24,
          minWidth: 320,
          maxWidth: 480,
          maxHeight: '80vh',
          overflowY: 'auto',
          fontFamily: tokens.fontFamily,
          color: theme.textPrimary,
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export const Modal = Object.assign(ModalRoot, { Actions: ModalActions });
