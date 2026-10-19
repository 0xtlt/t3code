/**
 * devcontainer.json is JSONC: line and block comments plus trailing commas.
 * A scan rather than a regex pass, so `//` inside a string ("https://...") and
 * comment markers inside other comments are never mistaken for syntax.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      out += text.slice(start, index);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < length && text[index] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      // Keeps `a/* x */b` from fusing into `ab`.
      out += " ";
    } else {
      out += char;
      index += 1;
    }
  }
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      out += text.slice(start, index);
    } else if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < length && /\s/.test(text[lookahead]!)) lookahead += 1;
      const next = text[lookahead];
      if (next !== "}" && next !== "]") out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** Returns `undefined` for text that is not valid JSONC. */
export function parseJsonc(text: string): unknown {
  try {
    // A UTF-8 BOM is common in files saved by Windows editors.
    return JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
  } catch {
    return undefined;
  }
}
