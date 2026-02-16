import React, { forwardRef, useEffect, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';

type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: SpinnerSize;
}

const sizeMap: Record<SpinnerSize, number> = { sm: 16, md: 24, lg: 32 };
const borderWidthMap: Record<SpinnerSize, number> = { sm: 2, md: 3, lg: 3 };

const KEYFRAMES_ID = '__shipstudio-plugin-spin';

function ensureKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `@keyframes __shipstudio-spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(style);
}

export const Spinner = forwardRef<HTMLDivElement, SpinnerProps>(function Spinner(
  { size = 'md', style, ...rest },
  ref
) {
  const theme = useTheme();
  const injected = useRef(false);

  useEffect(() => {
    if (!injected.current) {
      ensureKeyframes();
      injected.current = true;
    }
  }, []);

  const dim = sizeMap[size];
  const bw = borderWidthMap[size];

  return (
    <div
      ref={ref}
      style={{
        width: dim,
        height: dim,
        border: `${bw}px solid ${theme.border}`,
        borderTopColor: theme.textMuted,
        borderRadius: '50%',
        animation: '__shipstudio-spin 1s linear infinite',
        ...style,
      }}
      {...rest}
    />
  );
});
