import React, { forwardRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { tokens } from './styles';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { fontSize: tokens.fontSize.sm, padding: '6px 10px' },
  md: { fontSize: tokens.fontSize.md, padding: '10px 16px' },
  lg: { fontSize: tokens.fontSize.lg, padding: '12px 20px' },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', disabled, style, onMouseEnter, onMouseLeave, ...rest },
  ref
) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);

  const variantStyles: Record<ButtonVariant, { base: React.CSSProperties; hover: React.CSSProperties }> = {
    primary: {
      base: {
        background: theme.action,
        color: theme.actionText,
        fontWeight: 500,
        border: 'none',
      },
      hover: {
        background: theme.actionHover,
      },
    },
    secondary: {
      base: {
        background: theme.bgTertiary,
        color: theme.textSecondary,
        fontWeight: 500,
        border: `1px solid ${theme.border}`,
      },
      hover: {
        background: theme.border,
        color: theme.textPrimary,
      },
    },
    danger: {
      base: {
        background: 'transparent',
        color: theme.error,
        fontWeight: 500,
        border: `1px solid ${theme.error}`,
      },
      hover: {
        background: theme.error,
        color: theme.textPrimary,
      },
    },
    ghost: {
      base: {
        background: 'transparent',
        color: theme.textSecondary,
        border: 'none',
      },
      hover: {
        background: theme.bgTertiary,
        color: theme.textPrimary,
      },
    },
  };

  const v = variantStyles[variant];

  return (
    <button
      ref={ref}
      disabled={disabled}
      style={{
        fontFamily: tokens.fontFamily,
        borderRadius: tokens.borderRadius.md,
        transition: `all ${tokens.transition}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...sizeStyles[size],
        ...v.base,
        ...(hovered && !disabled ? v.hover : {}),
        ...style,
      }}
      onMouseEnter={(e) => {
        setHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        onMouseLeave?.(e);
      }}
      {...rest}
    />
  );
});
