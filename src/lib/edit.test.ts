import { describe, expect, it } from 'vitest';
import {
  scaleValue,
  steppedScale,
  SPACING_CONTROLS,
  ENUM_CONTROLS,
  activeEnumToken,
  boxSideValue,
  boxSideToken,
  boxInlineStyle,
  arbitraryColor,
  colorToken,
  arbitraryColorRaw,
  colorClassToken,
  colorFormatOf,
  tokensForVariant,
  withVariant,
  resolveCascade,
  breakpointPrefixes,
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
  type Breakpoint,
} from './edit';

const ORDERED: Breakpoint[] = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];
const KNOWN = breakpointPrefixes(DEFAULT_BREAKPOINTS);
const BP = (name: string) => ORDERED.find((b) => b.name === name)!;

describe('tokensForVariant', () => {
  it('scopes the base layer, keeping hover/focus but dropping breakpoint tokens', () => {
    expect(tokensForVariant('p-4 md:p-8 hover:p-2 lg:flex', null, KNOWN)).toBe('p-4 hover:p-2');
  });
  it('scopes a breakpoint layer, stripping exactly that one prefix', () => {
    expect(tokensForVariant('p-4 md:p-8 md:hover:p-2 lg:p-12', 'md', KNOWN)).toBe('p-8 hover:p-2');
  });
  it('never mis-parses a colon-bearing arbitrary value (stays in base)', () => {
    // The colon is inside the bracket; its lead isn't a known breakpoint.
    expect(tokensForVariant('bg-[url(http://x.com/a.png)]', null, KNOWN)).toBe(
      'bg-[url(http://x.com/a.png)]'
    );
    expect(tokensForVariant('bg-[url(http://x.com/a.png)]', 'md', KNOWN)).toBe('');
  });
  it('reads a scale value out of a breakpoint layer via the existing reader', () => {
    expect(scaleValue(tokensForVariant('p-4 md:p-8', 'md', KNOWN), 'p')).toBe(8);
    expect(scaleValue(tokensForVariant('p-4 md:p-8', null, KNOWN), 'p')).toBe(4);
  });
});

describe('withVariant', () => {
  it('prefixes for a breakpoint and is identity for base', () => {
    expect(withVariant('md', 'p-6')).toBe('md:p-6');
    expect(withVariant(null, 'p-6')).toBe('p-6');
    // Round-trips arbitrary color tokens (escaping already applied upstream).
    expect(withVariant('md', 'text-[oklch(0.62_0.18_39)]')).toBe('md:text-[oklch(0.62_0.18_39)]');
  });
});

describe('resolveCascade', () => {
  const readP = (scoped: string) => scaleValue(scoped, 'p');

  it('returns the value set on the active breakpoint (set here)', () => {
    const r = resolveCascade('p-4 md:p-8', BP('md'), ORDERED, readP, KNOWN);
    expect(r.value).toBe(8);
    expect(r.definedAt?.name).toBe('md');
  });
  it('inherits from a smaller breakpoint when the active one is unset', () => {
    // At lg there is no lg:p-*; the cascade falls to md:p-8.
    const r = resolveCascade('p-4 md:p-8', BP('lg'), ORDERED, readP, KNOWN);
    expect(r.value).toBe(8);
    expect(r.definedAt?.name).toBe('md');
  });
  it('falls all the way to base', () => {
    const r = resolveCascade('p-4', BP('xl'), ORDERED, readP, KNOWN);
    expect(r.value).toBe(4);
    expect(r.definedAt?.name).toBe('Base');
  });
  it('returns null/definedAt null when nothing matches', () => {
    const r = resolveCascade('flex', BP('md'), ORDERED, readP, KNOWN);
    expect(r.value).toBeNull();
    expect(r.definedAt).toBeNull();
  });
  it('composes with the box-model per-side cascade across breakpoints', () => {
    // base pt-2 + md:py-8: at md the top side is 8 (md axis beats base side);
    // at base the top side is 2.
    const cls = 'pt-2 md:py-8';
    const topAt = (bp: Breakpoint) =>
      resolveCascade(cls, bp, ORDERED, (s) => boxSideValue(s, 'padding', 'top'), KNOWN).value;
    expect(topAt(BP('md'))).toBe(8);
    expect(topAt(BASE_BREAKPOINT)).toBe(2);
  });
});

describe('arbitrary color (any format)', () => {
  it('reads hex / rgb / oklch and un-escapes underscores', () => {
    expect(arbitraryColorRaw('text-[#1a2b3c] p-4', 'text')).toBe('#1a2b3c');
    expect(arbitraryColorRaw('bg-[oklch(0.62_0.18_39)] flex', 'bg')).toBe('oklch(0.62 0.18 39)');
    expect(arbitraryColorRaw('text-[rgb(194,65,12)]', 'text')).toBe('rgb(194,65,12)');
    expect(arbitraryColorRaw('text-[var(--foreground)]', 'text')).toBe('var(--foreground)');
  });
  it('ignores non-color bracket values and absence', () => {
    expect(arbitraryColorRaw('text-[14px] leading-5', 'text')).toBeNull();
    expect(arbitraryColorRaw('p-4', 'bg')).toBeNull();
  });
  it('builds a class token, escaping spaces to underscores', () => {
    expect(colorClassToken('text', 'oklch(0.62 0.18 39)')).toBe('text-[oklch(0.62_0.18_39)]');
    expect(colorClassToken('bg', '#ffffff')).toBe('bg-[#ffffff]');
  });
  it('detects the format for match-existing', () => {
    expect(colorFormatOf('oklch(0.6 0.1 30)')).toBe('oklch');
    expect(colorFormatOf('rgb(0,0,0)')).toBe('rgb');
    expect(colorFormatOf('hsl(0,0%,0%)')).toBe('hsl');
    expect(colorFormatOf('#abcdef')).toBe('hex');
    expect(colorFormatOf('var(--x)')).toBe('hex');
  });
});

describe('color helpers', () => {
  it('reads an arbitrary hex for a color utility', () => {
    expect(arbitraryColor('flex text-[#1a2b3c] p-4', 'text')).toBe('#1a2b3c');
    expect(arbitraryColor('bg-[#fff] rounded', 'bg')).toBe('#fff');
    // named colors / absent → null (can't map back to a swatch)
    expect(arbitraryColor('text-red-500', 'text')).toBeNull();
    expect(arbitraryColor('p-4', 'bg')).toBeNull();
  });
  it('builds a color token', () => {
    expect(colorToken('text', '#000000')).toBe('text-[#000000]');
    expect(colorToken('bg', '#ff0000')).toBe('bg-[#ff0000]');
  });
});

describe('scaleValue', () => {
  it('reads <prefix>-N for the requested utility', () => {
    expect(scaleValue('bg-white p-10 flex', 'p')).toBe(10);
    expect(scaleValue('m-4 p-2', 'm')).toBe(4);
    expect(scaleValue('flex gap-6', 'gap')).toBe(6);
    expect(scaleValue('p-0', 'p')).toBe(0);
  });

  it('does not confuse prefixes (p vs px vs m)', () => {
    expect(scaleValue('px-4 py-2', 'p')).toBeNull(); // px/py are not p
    expect(scaleValue('mx-3', 'm')).toBeNull(); // mx is not m
  });

  it('ignores arbitrary and absent values', () => {
    expect(scaleValue('p-[22px]', 'p')).toBeNull();
    expect(scaleValue('flex gap-2', 'p')).toBeNull();
  });
});

describe('steppedScale', () => {
  it('steps by one integer with no skips (regression: 8→9→10)', () => {
    expect(steppedScale('p-8 flex', 'p', 1)).toBe('p-9');
    expect(steppedScale('p-9 flex', 'p', 1)).toBe('p-10');
    expect(steppedScale('p-10 flex', 'p', -1)).toBe('p-9');
    expect(steppedScale('m-3', 'm', 1)).toBe('m-4');
    expect(steppedScale('gap-5', 'gap', -1)).toBe('gap-4');
  });

  it('clamps at 0 and treats absent as 0', () => {
    expect(steppedScale('p-0', 'p', -1)).toBe('p-0');
    expect(steppedScale('flex', 'm', -1)).toBe('m-0');
    expect(steppedScale('flex', 'gap', 1)).toBe('gap-1');
  });
});

describe('activeEnumToken', () => {
  const align = ENUM_CONTROLS.find((c) => c.label === 'Align')!;
  const weight = ENUM_CONTROLS.find((c) => c.label === 'Weight')!;

  it('detects the active option token in a class string', () => {
    expect(activeEnumToken('flex text-center gap-2', align)).toBe('text-center');
    expect(activeEnumToken('font-bold text-xl', weight)).toBe('font-bold');
  });

  it('returns null when no option is present', () => {
    expect(activeEnumToken('flex gap-2', align)).toBeNull();
    // text-xl is a size, not an alignment — must not false-match.
    expect(activeEnumToken('text-xl', align)).toBeNull();
  });
});

describe('per-side box helpers', () => {
  it('resolves the cascade: side > axis > all', () => {
    // p-4 sets all sides; px-2 overrides left/right; pt-8 overrides top.
    const cls = 'p-4 px-2 pt-8';
    expect(boxSideValue(cls, 'padding', 'top')).toBe(8); // pt wins
    expect(boxSideValue(cls, 'padding', 'left')).toBe(2); // px wins
    expect(boxSideValue(cls, 'padding', 'right')).toBe(2); // px wins
    expect(boxSideValue(cls, 'padding', 'bottom')).toBe(4); // falls back to p
  });

  it('returns null for a side with no relevant utility', () => {
    expect(boxSideValue('flex gap-2', 'margin', 'top')).toBeNull();
  });

  it('builds side tokens', () => {
    expect(boxSideToken('padding', 'top', 6)).toBe('pt-6');
    expect(boxSideToken('margin', 'left', 0)).toBe('ml-0');
  });

  it('emits all four longhand inline values (N × 0.25rem)', () => {
    expect(boxInlineStyle('p-4 pt-8', 'padding')).toEqual({
      'padding-top': '2rem', // 8 × 0.25
      'padding-right': '1rem', // 4 × 0.25
      'padding-bottom': '1rem',
      'padding-left': '1rem',
    });
    // Absent utilities resolve to 0.
    expect(boxInlineStyle('flex', 'margin')['margin-top']).toBe('0rem');
  });
});

describe('SPACING_CONTROLS', () => {
  it('maps each kind to a Tailwind prefix and a CSS property', () => {
    expect(SPACING_CONTROLS.map((c) => c.kind)).toEqual(['padding', 'margin', 'gap']);
    expect(SPACING_CONTROLS.find((c) => c.kind === 'padding')).toMatchObject({
      prefix: 'p',
      css: 'padding',
    });
    expect(SPACING_CONTROLS.find((c) => c.kind === 'gap')).toMatchObject({
      prefix: 'gap',
      css: 'gap',
    });
  });
});
