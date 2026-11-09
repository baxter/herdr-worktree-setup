import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, TomlError } from "../mods/worktree-setup/toml.js";

test("reads a Conductor settings file", () => {
  const text = `
# Shared with the team
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"
file_include_globs = ".env*"

[scripts]
setup = """
npm install
cp "$CONDUCTOR_ROOT_PATH/.env" .env
"""
archive = 'rm -rf "$HOME/Library/Application Support/my-app-$CONDUCTOR_WORKSPACE_NAME"'
run_mode = "nonconcurrent"

[scripts.run.web]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true

[environment_variables]
NODE_ENV = "development"

[environment_variables.local]
API_URL = "http://localhost:3000"
`;
  assert.deepEqual(parseToml(text), {
    $schema: "https://conductor.build/schemas/settings.repo.schema.json",
    file_include_globs: ".env*",
    scripts: {
      setup: 'npm install\ncp "$CONDUCTOR_ROOT_PATH/.env" .env\n',
      archive: 'rm -rf "$HOME/Library/Application Support/my-app-$CONDUCTOR_WORKSPACE_NAME"',
      run_mode: "nonconcurrent",
      run: { web: { command: "pnpm dev --port $CONDUCTOR_PORT", default: true } },
    },
    environment_variables: { NODE_ENV: "development", local: { API_URL: "http://localhost:3000" } },
  });
});

test("dotted keys and inline tables build nested tables", () => {
  assert.deepEqual(parseToml('scripts.setup = "make"\nenv = { a = 1, b.c = "x" }'), {
    scripts: { setup: "make" },
    env: { a: 1, b: { c: "x" } },
  });
});

test("strings: escapes, literal strings and line-ending backslashes", () => {
  assert.deepEqual(
    parseToml(`a = "tab\\there \\u00e9"\nb = 'C:\\path'\nc = """one \\\n    two"""\nd = '''\nraw \\n'''`),
    { a: "tab\there é", b: "C:\\path", c: "one two", d: "raw \\n" },
  );
});

test("quotes just before the closing triple quote belong to the string", () => {
  assert.deepEqual(parseToml('a = """say "hi"""""'), { a: 'say "hi""' });
});

test("arrays span lines and allow comments and a trailing comma", () => {
  assert.deepEqual(parseToml('args = [\n  "--port", # the port\n  "3000",\n]\nn = [[1, 2], []]'), {
    args: ["--port", "3000"],
    n: [[1, 2], []],
  });
});

test("numbers, booleans and dates", () => {
  assert.deepEqual(parseToml("a = 1_000\nb = -0.5\nc = 0xff\nd = true\ne = 1979-05-27 07:32:00Z\nf = inf"), {
    a: 1000,
    b: -0.5,
    c: 255,
    d: true,
    e: "1979-05-27 07:32:00Z",
    f: Infinity,
  });
});

test("arrays of tables", () => {
  assert.deepEqual(parseToml('[[preview_urls]]\nurl = "a"\n[[preview_urls]]\nurl = "b"\nname = "B"'), {
    preview_urls: [{ url: "a" }, { url: "b", name: "B" }],
  });
});

test("mistakes are reported with their line", () => {
  assert.throws(() => parseToml('[scripts]\nsetup = "npm install'), new TomlError("line 2: unterminated string"));
  assert.throws(() => parseToml("a = 1\na = 2"), /line 2: "a" is defined twice/);
  assert.throws(() => parseToml("a = 1 b = 2"), /line 1: expected the end of the line/);
  assert.throws(() => parseToml("a = nope"), /line 1: unexpected "nope"/);
});
