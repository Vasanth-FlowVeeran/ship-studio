import React, { forwardRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { tokens } from './styles';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, style, onFocus, onBlur, ...rest },
  ref
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error ? theme.error : focused ? theme.accent : theme.border;

  const input = (
    <input
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
    />
  );

  if (!label && !error) return input;

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
      {input}
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
