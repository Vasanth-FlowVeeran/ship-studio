import React, { forwardRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import { tokens } from './styles';

type BadgeVariant = 'default' | 'success' | 'error' | 'info';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'default', style, ...rest },
  ref
) {
  const theme = useTheme();

  const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
    default: {
      background: theme.bgTertiary,
      color: theme.textSecondary,
    },
    success: {
      background: `color-mix(in srgb, ${theme.success} 12%, transparent)`,
      color: theme.success,
    },
    error: {
      background: `color-mix(in srgb, ${theme.error} 12%, transparent)`,
      color: theme.error,
    },
    info: {
      background: `color-mix(in srgb, ${theme.accent} 12%, transparent)`,
      color: theme.accent,
    },
  };

  return (
    <span
      ref={ref}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: tokens.fontFamily,
        fontSize: tokens.fontSize.xs,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: tokens.borderRadius.sm,
        whiteSpace: 'nowrap',
        ...variantStyles[variant],
        ...style,
      }}
      {...rest}
    />
  );
});
