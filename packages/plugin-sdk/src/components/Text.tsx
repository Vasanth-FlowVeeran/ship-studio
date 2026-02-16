import React, { forwardRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import { tokens } from './styles';

type TextColor = 'primary' | 'secondary' | 'muted' | 'error' | 'success';
type TextSize = keyof typeof tokens.fontSize;

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  size?: TextSize;
  color?: TextColor;
  weight?: React.CSSProperties['fontWeight'];
  as?: 'span' | 'p' | 'div' | 'label' | 'h1' | 'h2' | 'h3' | 'h4';
}

const colorMap: Record<TextColor, string> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  muted: 'textMuted',
  error: 'error',
  success: 'success',
};

export const Text = forwardRef<HTMLElement, TextProps>(function Text(
  { size = 'base', color = 'primary', weight, as: Tag = 'span', style, ...rest },
  ref
) {
  const theme = useTheme();
  const themeKey = colorMap[color] as keyof typeof theme;

  return (
    <Tag
      ref={ref as React.Ref<never>}
      style={{
        fontFamily: tokens.fontFamily,
        fontSize: tokens.fontSize[size],
        fontWeight: weight,
        color: theme[themeKey],
        margin: 0,
        ...style,
      }}
      {...rest}
    />
  );
});
