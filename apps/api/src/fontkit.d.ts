declare module 'fontkit' {
  /** Only the immutable glyph-coverage surface is used for contract preflight. */
  export function openSync(path: string): {
    hasGlyphForCodePoint(codePoint: number): boolean;
  };
}
