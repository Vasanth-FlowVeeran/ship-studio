import { describe, it, expect } from 'vitest';
import { parseNalUnits, nalType, codecString, buildAvcC, toAvcc } from './androidMirror';

/** Build an Annex-B buffer from NAL bodies, each prefixed with a 4-byte start code. */
function annexB(...nals: number[][]): Uint8Array {
  const parts: number[] = [];
  for (const n of nals) parts.push(0, 0, 0, 1, ...n);
  return new Uint8Array(parts);
}

describe('parseNalUnits', () => {
  it('splits complete NALs and holds the trailing (possibly partial) one as rest', () => {
    // Two complete NALs + the start of a third. The third must be kept in `rest`
    // because more of it may arrive on the next chunk.
    const buf = annexB([0x67, 0x42], [0x68, 0x01], [0x65, 0xaa]);
    const { nals, rest } = parseNalUnits(buf);
    expect(nals.map((n) => Array.from(n))).toEqual([
      [0x67, 0x42],
      [0x68, 0x01],
    ]);
    // rest is the last start code onward (the third NAL, treated as incomplete).
    expect(Array.from(rest)).toEqual([0, 0, 1, 0x65, 0xaa]);
  });

  it('reassembles a NAL split across two chunks', () => {
    const whole = annexB([0x67, 0x11, 0x22], [0x65, 0x33, 0x44]);
    const a = whole.slice(0, 7); // exactly the first NAL + its start code
    const b = whole.slice(7);
    const first = parseNalUnits(a);
    // Only one start code seen → nothing is complete yet; it's all held in rest.
    expect(first.nals).toEqual([]);
    // Feed rest + the next chunk + a sentinel start code so both NALs are now
    // bounded and emitted. Each NAL surfaces exactly once across the two calls.
    const merged = new Uint8Array([...first.rest, ...b, 0, 0, 0, 1, 0x09]);
    const second = parseNalUnits(merged);
    expect(second.nals.map((n) => Array.from(n))).toEqual([
      [0x67, 0x11, 0x22],
      [0x65, 0x33, 0x44],
    ]);
    expect(Array.from(second.rest)).toEqual([0, 0, 1, 0x09]);
  });

  it('handles 3-byte start codes and discards leading junk', () => {
    const buf = new Uint8Array([0xde, 0xad, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x65]);
    const { nals } = parseNalUnits(buf);
    expect(nals.map((n) => Array.from(n))).toEqual([[0x67, 0x42]]);
  });

  it('returns everything as rest when no start code is present yet', () => {
    const buf = new Uint8Array([1, 2, 3]);
    const { nals, rest } = parseNalUnits(buf);
    expect(nals).toEqual([]);
    expect(Array.from(rest)).toEqual([1, 2, 3]);
  });
});

describe('nalType', () => {
  it('masks the low 5 bits of the NAL header', () => {
    expect(nalType(new Uint8Array([0x67]))).toBe(7); // SPS
    expect(nalType(new Uint8Array([0x68]))).toBe(8); // PPS
    expect(nalType(new Uint8Array([0x65]))).toBe(5); // IDR
    expect(nalType(new Uint8Array([0x41]))).toBe(1); // non-IDR
  });
});

describe('codecString', () => {
  it('derives avc1.<profile><constraint><level> from the SPS', () => {
    // Real screenrecord SPS header: 67 42 c0 29 → Baseline, level 4.1.
    expect(codecString(new Uint8Array([0x67, 0x42, 0xc0, 0x29, 0x8d]))).toBe('avc1.42c029');
  });
});

describe('buildAvcC', () => {
  it('lays out a valid AVCDecoderConfigurationRecord', () => {
    const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x29]);
    const pps = new Uint8Array([0x68, 0xce]);
    const avcc = buildAvcC(sps, pps);
    expect(avcc[0]).toBe(1); // configurationVersion
    expect(avcc[1]).toBe(0x42); // profile
    expect(avcc[2]).toBe(0xc0); // constraints
    expect(avcc[3]).toBe(0x29); // level
    expect(avcc[4]).toBe(0xff); // lengthSizeMinusOne = 3
    expect(avcc[5]).toBe(0xe1); // numSPS = 1
    expect([avcc[6], avcc[7]]).toEqual([0, sps.length]); // SPS length
    expect(Array.from(avcc.slice(8, 8 + sps.length))).toEqual(Array.from(sps));
    const ppsCountIdx = 8 + sps.length;
    expect(avcc[ppsCountIdx]).toBe(1); // numPPS
    expect([avcc[ppsCountIdx + 1], avcc[ppsCountIdx + 2]]).toEqual([0, pps.length]);
    expect(Array.from(avcc.slice(ppsCountIdx + 3))).toEqual(Array.from(pps));
  });
});

describe('toAvcc', () => {
  it('prefixes each NAL with a 4-byte big-endian length', () => {
    const out = toAvcc([new Uint8Array([0xaa, 0xbb]), new Uint8Array([0xcc])]);
    expect(Array.from(out)).toEqual([0, 0, 0, 2, 0xaa, 0xbb, 0, 0, 0, 1, 0xcc]);
  });
});
