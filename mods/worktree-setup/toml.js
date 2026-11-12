// A small TOML reader, enough for Conductor's settings files: tables, dotted and quoted keys,
// every string form, numbers, booleans, arrays and inline tables. Dates and times are kept as
// their text. No Herdr imports, so it can be tested outside the app.

export class TomlError extends Error {}

export function parseToml(text) {
  return new Parser(text).document();
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

class Parser {
  constructor(text) {
    this.text = text.replace(/\r\n/g, "\n");
    this.position = 0;
  }

  fail(message) {
    const line = this.text.slice(0, this.position).split("\n").length;
    throw new TomlError(`line ${line}: ${message}`);
  }

  peek(offset = 0) {
    return this.text[this.position + offset];
  }

  startsWith(token) {
    return this.text.startsWith(token, this.position);
  }

  expect(token) {
    if (!this.startsWith(token)) this.fail(`expected "${token}"`);
    this.position += token.length;
  }

  skipSpaces() {
    while (this.peek() === " " || this.peek() === "\t") this.position++;
  }

  skipComment() {
    if (this.peek() === "#") while (this.position < this.text.length && this.peek() !== "\n") this.position++;
  }

  // Spaces, comments and newlines: what may sit between array items and between lines.
  skipBlank() {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.peek() !== "\n") return;
      this.position++;
    }
  }

  endOfLine() {
    this.skipSpaces();
    this.skipComment();
    if (this.position < this.text.length && this.peek() !== "\n") this.fail("expected the end of the line");
  }

  document() {
    const root = {};
    let table = root;
    const defined = new Set();
    for (;;) {
      this.skipBlank();
      if (this.position >= this.text.length) return root;
      if (this.startsWith("[[")) {
        this.position += 2;
        const path = this.key();
        this.expect("]]");
        const parent = this.descend(root, path.slice(0, -1));
        const last = path[path.length - 1];
        if (!Object.hasOwn(parent, last)) parent[last] = [];
        if (!Array.isArray(parent[last])) this.fail(`"${path.join(".")}" is not an array of tables`);
        table = {};
        parent[last].push(table);
      } else if (this.peek() === "[") {
        this.position++;
        const path = this.key();
        this.expect("]");
        const name = path.join(".");
        if (defined.has(name)) this.fail(`table "${name}" is defined twice`);
        defined.add(name);
        table = this.descend(root, path);
      } else {
        this.keyValue(table);
      }
      this.endOfLine();
    }
  }

  // The table at `path` under `table`, creating any that are missing. An array of tables
  // descends into its last element, as TOML says.
  descend(table, path) {
    let at = table;
    for (const part of path) {
      if (!Object.hasOwn(at, part)) at[part] = {};
      let next = at[part];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== "object" || next === null || Array.isArray(next)) this.fail(`"${part}" is not a table`);
      at = next;
    }
    return at;
  }

  keyValue(table) {
    const path = this.key();
    this.skipSpaces();
    this.expect("=");
    this.skipSpaces();
    const value = this.value();
    const parent = this.descend(table, path.slice(0, -1));
    const last = path[path.length - 1];
    if (Object.hasOwn(parent, last)) this.fail(`"${path.join(".")}" is defined twice`);
    parent[last] = value;
  }

  // A key's parts. Tables are plain objects, and setting "__proto__" on one replaces its
  // prototype (or, through a table that inherits Object.prototype, every object's), so no
  // part may be "__proto__". Conductor's settings never use it.
  key() {
    const parts = [];
    for (;;) {
      this.skipSpaces();
      if (this.peek() === '"') parts.push(this.basicString());
      else if (this.peek() === "'") parts.push(this.literalString());
      else {
        const start = this.position;
        while (this.position < this.text.length && BARE_KEY.test(this.peek())) this.position++;
        if (this.position === start) this.fail("expected a key");
        parts.push(this.text.slice(start, this.position));
      }
      if (parts[parts.length - 1] === "__proto__") this.fail(`"__proto__" can't be a key`);
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.position++;
    }
  }

  value() {
    if (this.startsWith('"""')) return this.multilineBasicString();
    if (this.startsWith("'''")) return this.multilineLiteralString();
    if (this.peek() === '"') return this.basicString();
    if (this.peek() === "'") return this.literalString();
    if (this.peek() === "[") return this.array();
    if (this.peek() === "{") return this.inlineTable();
    return this.scalar();
  }

  escape() {
    const letter = this.peek();
    this.position++;
    if (letter in ESCAPES) return ESCAPES[letter];
    if (letter === "u" || letter === "U") {
      const length = letter === "u" ? 4 : 8;
      const hex = this.text.slice(this.position, this.position + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) this.fail("bad unicode escape");
      this.position += length;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    this.fail(`unknown escape "\\${letter}"`);
  }

  basicString() {
    this.expect('"');
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "\n") this.fail("unterminated string");
      this.position++;
      if (c === '"') return out;
      out += c === "\\" ? this.escape() : c;
    }
  }

  literalString() {
    this.expect("'");
    const end = this.text.indexOf("'", this.position);
    const newline = this.text.indexOf("\n", this.position);
    if (end === -1 || (newline !== -1 && newline < end)) this.fail("unterminated string");
    const out = this.text.slice(this.position, end);
    this.position = end + 1;
    return out;
  }

  // A newline straight after the opening quotes is dropped. Up to two quotes may sit just
  // before the closing three, so `""""a""""` style edges come out right.
  multiline(quote, escapes) {
    this.expect(quote.repeat(3));
    if (this.peek() === "\n") this.position++;
    let out = "";
    for (;;) {
      if (this.position >= this.text.length) this.fail("unterminated string");
      if (this.startsWith(quote.repeat(3))) {
        let extra = 0;
        while (extra < 2 && this.peek(3 + extra) === quote) extra++;
        out += quote.repeat(extra);
        this.position += 3 + extra;
        return out;
      }
      const c = this.peek();
      this.position++;
      if (escapes && c === "\\") {
        // A backslash at the end of a line joins it to the next non-blank text.
        const rest = this.text.slice(this.position).match(/^[ \t]*\n[\s]*/);
        if (rest) this.position += rest[0].length;
        else out += this.escape();
      } else out += c;
    }
  }

  multilineBasicString() {
    return this.multiline('"', true);
  }

  multilineLiteralString() {
    return this.multiline("'", false);
  }

  array() {
    this.expect("[");
    const items = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") break;
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") this.position++;
      else if (this.peek() !== "]") this.fail('expected "," or "]"');
    }
    this.position++;
    return items;
  }

  inlineTable() {
    this.expect("{");
    const table = {};
    this.skipSpaces();
    if (this.peek() === "}") {
      this.position++;
      return table;
    }
    for (;;) {
      this.keyValue(table);
      this.skipSpaces();
      if (this.peek() === "}") break;
      this.expect(",");
    }
    this.position++;
    return table;
  }

  // Booleans, numbers and dates: a bare token up to the next delimiter.
  scalar() {
    const start = this.position;
    while (this.position < this.text.length && !/[\s,\]}#]/.test(this.peek())) this.position++;
    let token = this.text.slice(start, this.position);
    // A date and time may be split by a space: "1979-05-27 07:32:00".
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && /^ \d{2}:/.test(this.text.slice(this.position, this.position + 4))) {
      this.position++;
      while (this.position < this.text.length && !/[\s,\]}#]/.test(this.peek())) this.position++;
      token = this.text.slice(start, this.position);
    }
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}:\d{2}/.test(token)) return token;
    const digits = token.replace(/_/g, "");
    if (/^[+-]?(0|[1-9]\d*)$/.test(digits)) return Number(digits);
    if (/^0x[0-9A-Fa-f]+$/.test(digits)) return parseInt(digits.slice(2), 16);
    if (/^0o[0-7]+$/.test(digits)) return parseInt(digits.slice(2), 8);
    if (/^0b[01]+$/.test(digits)) return parseInt(digits.slice(2), 2);
    if (/^[+-]?inf$/.test(digits)) return digits.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(digits)) return NaN;
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(digits)) return Number(digits);
    this.position = start;
    this.fail(token ? `unexpected "${token}"` : "expected a value");
  }
}
