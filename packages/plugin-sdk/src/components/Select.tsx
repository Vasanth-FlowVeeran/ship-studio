import React, { forwardRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { tokens } from './styles';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, style, onFocus, onBlur, children, ...rest },
  ref
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error ? theme.error : focused ? theme.accent : theme.border;

  const select = (
    <select
      ref={ref}
      style={{
        width: '100%',
        fontFamily: tokens.fontFamily,
        fontSize: tokens.fontSize.md,
        padding: '8px 12px',
        borderRadius: tokens.borderRadius.md,
        border: `1px solid ${borderColor}`,
        background: theme.bgPrimary,
        color: theme.textPrimary,
        outline: 'none',
        transition: `border-color ${tokens.transition}`,
        cursor: 'pointer',
        ...style,
      }}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      {...rest}
    >
      {children}
    </select>
  );

  if (!label && !error) return select;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <label
          style={{
            fontFamily: tokens.fontFamily,
            fontSize: tokens.fontSize.sm,
            color: theme.textSecondary,
            fontWeight: 500,
          }}
        >
          {label}
        </label>
      )}
      {select}
      {error && (
        <span
          style={{
            fontFamily: tokens.fontFamily,
            fontSize: tokens.fontSize.xs,
            color: theme.error,
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
});
