import React, { forwardRef } from 'react';

export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  direction?: 'row' | 'column';
  gap?: number;
  align?: React.CSSProperties['alignItems'];
  justify?: React.CSSProperties['justifyContent'];
  wrap?: boolean;
}

export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { direction = 'column', gap = 8, align, justify, wrap, style, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        flexDirection: direction,
        gap,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : undefined,
        ...style,
      }}
      {...rest}
    />
  );
});
