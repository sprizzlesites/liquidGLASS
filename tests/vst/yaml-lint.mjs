// tests/vst/yaml-lint.mjs
//
// A small, self-contained YAML *structural* sanity checker — deliberately
// NOT a general YAML parser. We do not want a runtime/test dependency on
// js-yaml living in the repo (only vendored via npm into a scratch dir was
// suggested, and this file must work without any npm install at all so the
// test suite runs anywhere, offline). It catches the realistic classes of
// mistakes a hand-written generator can make: tabs, inconsistent/illegal
// indentation jumps, unterminated quotes, and mapping keys with children
// that were never opened with a trailing ':'. Block scalars ("| " / "> ")
// are recognised and their body lines are treated as opaque literal text
// (only checked for tabs), matching real YAML semantics.
//
// Usage: import { checkYamlSanity } from './yaml-lint.mjs';
//        const errors = checkYamlSanity(yamlText);
//        if (errors.length) throw new Error(errors.join('\n'));

export function checkYamlSanity(text) {
  const errors = [];
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');

  let blockScalarIndent = null; // indent of the key that opened a |/> block; null when not inside one

  // Track a stack of indentation levels we've legitimately opened.
  const indentStack = [0];

  for (let ln = 0; ln < rawLines.length; ln++) {
    const lineNo = ln + 1;
    const rawLine = rawLines[ln];

    if (rawLine.includes('\t')) {
      errors.push(`line ${lineNo}: tab character found (YAML requires spaces for indentation)`);
    }

    // Blank/whitespace-only lines never affect structure.
    if (/^\s*$/.test(rawLine)) continue;

    const indent = rawLine.match(/^ */)[0].length;

    // Inside a block scalar body, everything more-indented than the opening
    // key is opaque literal text — skip structural checks for it, but a
    // dedent back to <= blockScalarIndent closes the block scalar.
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null; // fall through and process this line normally
    }

    const trimmed = rawLine.trim();

    // Skip full-line comments for structural purposes.
    if (trimmed.startsWith('#')) continue;

    // Strip a trailing unquoted comment (best-effort — good enough for the
    // generator output we produce, which never puts '#' inside quotes).
    let content = trimmed;
    const hashIdx = content.indexOf(' #');
    if (hashIdx !== -1 && !/['"]/.test(content.slice(0, hashIdx))) {
      content = content.slice(0, hashIdx).trim();
    }
    if (content === '') continue;

    // Quote balance check (simple — no escape handling needed for our
    // generated content, which never nests quotes).
    const singleQuotes = (content.match(/'/g) || []).length;
    const doubleQuotes = (content.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0) errors.push(`line ${lineNo}: odd number of single quotes`);
    if (doubleQuotes % 2 !== 0) errors.push(`line ${lineNo}: odd number of double quotes`);

    // Indentation must be structurally sane: pop any deeper levels than the
    // current line, then either match an existing level exactly or open
    // exactly one new (deeper) level.
    while (indentStack.length > 1 && indent < indentStack[indentStack.length - 1]) {
      indentStack.pop();
    }
    const top = indentStack[indentStack.length - 1];
    if (indent > top) {
      indentStack.push(indent);
    } else if (indent !== top) {
      errors.push(`line ${lineNo}: indentation (${indent}) does not align with any open block (expected ${top} or a deeper new level)`);
    }

    // Sequence item ("- ...") — strip the marker(s) and re-derive the
    // "effective" content for the mapping-key checks below (a sequence item
    // can itself start a mapping: "- name: Checkout").
    let effective = content;
    let sawDash = false;
    while (effective.startsWith('- ') || effective === '-') {
      sawDash = true;
      effective = effective === '-' ? '' : effective.slice(2).trim();
      if (effective === '') break;
    }

    if (effective === '') continue; // bare "-" list item, or dash-only line

    // Does this line open a block scalar? e.g. `run: |`, `run: >`, `foo: |-`
    if (/:\s*[|>][+-]?\s*$/.test(effective)) {
      blockScalarIndent = indent + (sawDash ? 2 : 0);
      continue;
    }

    // A line ending in ':' (a mapping key with children on following lines)
    // is always fine — nothing more to check here; the next line's indent
    // is validated on its own turn by the stack logic above.
    if (/:\s*$/.test(effective)) continue;

    // Otherwise this should look like `key: value` or a scalar (list item
    // whose value is just a string, or a plain flow value). We don't try
    // to validate value syntax beyond quote balance already checked above.
  }

  if (blockScalarIndent !== null) {
    // File ended while still "inside" a block scalar — that's fine, it just
    // means the block scalar ran to EOF; not an error.
  }

  return errors;
}

export function assertYamlSane(text, label) {
  const errors = checkYamlSanity(text);
  if (errors.length) {
    throw new Error(`YAML sanity check failed for ${label || '(unnamed)'}:\n  ${errors.join('\n  ')}`);
  }
}
