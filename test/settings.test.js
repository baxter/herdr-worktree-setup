import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, DEFAULT_INCLUDE, FILES } from "../mods/worktree-setup/settings.js";

const none = Object.fromEntries(Object.keys(FILES).map((key) => [key, null]));
const resolve = (files) => resolveSettings({ ...none, ...files });

test("with no Conductor files at all, nothing is configured", () => {
  assert.deepEqual(resolve({}), { configured: false, setup: "", archive: "", include: DEFAULT_INCLUDE, env: {} });
});

test("the archive script follows the same precedence, legacy file included", () => {
  assert.equal(resolve({ legacy: '{"scripts": {"archive": "docker compose down"}}' }).archive, "docker compose down");
  assert.equal(resolve({ repoToml: '[scripts]\narchive = "conductor"', herdrRepo: '[scripts]\narchive = "herdr"' }).archive, "herdr");
  assert.equal(resolve({ herdrRepo: '[scripts]\nsetup = "npm ci"' }).archive, "");
});

test("the repository's settings.toml gives the setup script", () => {
  const result = resolve({ repoToml: '[scripts]\nsetup = "npm install"' });
  assert.equal(result.configured, true);
  assert.equal(result.setup, "npm install");
});

test("project overrides beat the repository, which beats the user", () => {
  const user = '[scripts]\nsetup = "user"\n[environment_variables]\nA = "user"\nB = "user"\nC = "user"';
  const repo = '[scripts]\nsetup = "repo"\n[environment_variables]\nB = "repo"\nC = "repo"';
  const local = '[environment_variables]\nC = "local"';
  assert.equal(resolve({ userToml: user }).setup, "user");
  assert.equal(resolve({ userToml: user, repoToml: repo }).setup, "repo");
  assert.equal(resolve({ userToml: user, repoToml: repo, localToml: '[scripts]\nsetup = "local"' }).setup, "local");
  assert.deepEqual(resolve({ userToml: user, repoToml: repo, localToml: local }).env, { A: "user", B: "repo", C: "local" });
});

test("within a layer, settings.toml wins over the older settings.json", () => {
  const result = resolve({
    repoJson: '{"scripts": {"setup": "from json"}, "file_include_globs": ".env.local"}',
    repoToml: '[scripts]\nsetup = "from toml"',
  });
  assert.equal(result.setup, "from toml");
  assert.equal(result.include, ".env.local");
});

test("legacy conductor.json is used until .conductor/settings.toml exists", () => {
  const legacy = '{"scripts": {"setup": "bun install", "run": "bun dev"}, "runScriptMode": "concurrent"}';
  assert.equal(resolve({ legacy }).setup, "bun install");
  assert.equal(resolve({ legacy, repoToml: 'file_include_globs = ".env"' }).setup, "");
});

test("files to copy: .worktreeinclude, then file_include_globs, then .env*", () => {
  assert.equal(resolve({ repoToml: "x = 1" }).include, ".env*");
  assert.equal(resolve({ repoToml: 'file_include_globs = ".env.local"' }).include, ".env.local");
  assert.equal(resolve({ repoToml: 'file_include_globs = ["a", "b/"]' }).include, "a\nb/");
  const include = "# local files\n.env*\n!.env.example\n";
  assert.equal(resolve({ include, repoToml: 'file_include_globs = ".env.local"' }).include, "# local files\n.env*\n!.env.example");
});

test("a .worktreeinclude alone counts as configured", () => {
  assert.equal(resolve({ include: ".env.local" }).configured, true);
});

test("local environment variables apply, cloud ones don't", () => {
  const repoToml = '[environment_variables]\nA = "plain"\nB = 2\n[environment_variables.local]\nA = "local"\n[environment_variables.cloud]\nC = "cloud"';
  assert.deepEqual(resolve({ repoToml }).env, { A: "local", B: "2" });
});

test("a broken file is reported by name", () => {
  assert.throws(() => resolve({ repoToml: "[scripts\nsetup = 1" }), /^Error: \.conductor\/settings\.toml: line 1: expected "\]"/);
  assert.throws(() => resolve({ legacy: "{" }), /^Error: conductor\.json: /);
  assert.throws(() => resolve({ herdrUser: "x =" }), /^Error: ~\/\.config\/herdr-app\/worktree-setup\.toml: line 1: /);
});

test("a repo with only .herdr/settings.toml is set up", () => {
  const result = resolve({ herdrRepo: '[scripts]\nsetup = "npm ci"' });
  assert.equal(result.configured, true);
  assert.equal(result.setup, "npm ci");
});

test(".herdr beats .conductor key by key, within each level", () => {
  const repoToml = '[scripts]\nsetup = "conductor"\n[environment_variables]\nA = "conductor"\nB = "conductor"';
  const herdrRepo = '[environment_variables]\nB = "herdr"';
  const result = resolve({ repoToml, herdrRepo });
  assert.equal(result.setup, "conductor", "a key .herdr doesn't set comes from .conductor");
  assert.deepEqual(result.env, { A: "conductor", B: "herdr" });
  assert.equal(resolve({ userToml: '[scripts]\nsetup = "conductor"', herdrUser: '[scripts]\nsetup = "herdr"' }).setup, "herdr");
});

test("levels still come first: Conductor's local file beats Herdr's repo file", () => {
  const result = resolve({ localToml: '[scripts]\nsetup = "local"', herdrRepo: '[scripts]\nsetup = "repo"' });
  assert.equal(result.setup, "local");
  assert.equal(resolve({ herdrUser: '[scripts]\nsetup = "user"', repoToml: '[scripts]\nsetup = "repo"' }).setup, "repo");
});
