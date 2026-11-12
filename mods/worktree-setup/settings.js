// Setup settings: Conductor's, resolved the way Conductor does, plus Herdr's own files with
// the same keys. No Herdr imports, so it can be tested outside the app.
//
// - Layers, first match wins: project overrides (settings.local.toml in the repo), repository
//   shared (settings.toml in the repo), user (your own file in the home folder).
//   Conductor's managed settings can't set scripts or Files to copy, so they're not read.
// - Within one layer, later files win key by key: Conductor's legacy settings.json, then
//   Conductor's settings.toml, then Herdr's file.
// - Legacy conductor.json counts as the repository layer until .conductor/settings.toml exists.
// - Files to copy: .worktreeinclude, else file_include_globs, else ".env*".

import { parseToml, TomlError } from "./toml.js";

export const DEFAULT_INCLUDE = ".env*";

// Where each file lives: `base` "repo" is the main checkout, "home" the home folder.
export const FILES = {
  localJson: { base: "repo", path: ".conductor/settings.local.json" },
  localToml: { base: "repo", path: ".conductor/settings.local.toml" },
  herdrLocal: { base: "repo", path: ".herdr/settings.local.toml" },
  repoJson: { base: "repo", path: ".conductor/settings.json" },
  repoToml: { base: "repo", path: ".conductor/settings.toml" },
  herdrRepo: { base: "repo", path: ".herdr/settings.toml" },
  legacy: { base: "repo", path: "conductor.json" },
  include: { base: "repo", path: ".worktreeinclude" },
  userJson: { base: "home", path: ".conductor/settings.json" },
  userToml: { base: "home", path: ".conductor/settings.toml" },
  herdrUser: { base: "home", path: ".config/herdr-app/worktree-setup.toml" },
};

const isTable = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// Later tables win, key by key, at every depth. The result has no prototype, so a JSON file's
// own "__proto__" key is copied as a key rather than becoming the table's prototype.
function merge(...tables) {
  const out = Object.create(null);
  for (const table of tables) {
    for (const [key, value] of Object.entries(table ?? {})) {
      out[key] = isTable(value) && isTable(out[key]) ? merge(out[key], value) : value;
    }
  }
  return out;
}

// The file's contents as a table (null when it's absent). JSON or TOML by its extension.
function parse(files, key) {
  const text = files[key];
  if (text === null || text === undefined) return null;
  const { base, path } = FILES[key];
  const name = base === "home" ? `~/${path}` : path;
  try {
    const value = path.endsWith(".json") ? JSON.parse(text) : parseToml(text);
    if (!isTable(value)) throw new TomlError("expected a table at the top");
    return value;
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
}

// The old conductor.json names, moved to where settings.toml keeps them.
function fromLegacy(legacy) {
  if (!legacy) return null;
  const scripts = {};
  if (typeof legacy.scripts?.setup === "string") scripts.setup = legacy.scripts.setup;
  if (typeof legacy.scripts?.archive === "string") scripts.archive = legacy.scripts.archive;
  return { scripts };
}

function lookup(layers, path) {
  for (const layer of layers) {
    let at = layer;
    for (const part of path) at = isTable(at) ? at[part] : undefined;
    if (at !== undefined) return at;
  }
  return undefined;
}

// `environment_variables` holds plain values and two tables, `local` and `cloud`.
// Herdr's worktrees are always local, so `local` applies and wins over the plain ones.
function environment(layers) {
  const env = {};
  for (const layer of [...layers].reverse()) {
    const table = layer.environment_variables;
    if (!isTable(table)) continue;
    for (const [key, value] of Object.entries(table)) if (!isTable(value)) env[key] = String(value);
    if (isTable(table.local)) for (const [key, value] of Object.entries(table.local)) env[key] = String(value);
  }
  return env;
}

function includePatterns(worktreeinclude, layers) {
  if (typeof worktreeinclude === "string") return worktreeinclude;
  const globs = lookup(layers, ["file_include_globs"]);
  if (Array.isArray(globs)) return globs.join("\n");
  if (typeof globs === "string") return globs;
  return DEFAULT_INCLUDE;
}

/**
 * files: each key of FILES mapped to that file's text, or null when it's absent.
 * Returns { configured, setup, archive, include, env }: `configured` is false unless some file
 * sets a setup or archive script or Files to copy, so nothing should run. A file that exists
 * for other reasons (Conductor's own ~/.conductor/settings.toml, say) doesn't count, and nor
 * does the default ".env*". Throws when a file can't be read, naming the file.
 */
export function resolveSettings(files) {
  const local = merge(parse(files, "localJson"), parse(files, "localToml"), parse(files, "herdrLocal"));
  const repoToml = parse(files, "repoToml");
  const legacy = repoToml ? null : fromLegacy(parse(files, "legacy"));
  const repo = merge(legacy, parse(files, "repoJson"), repoToml, parse(files, "herdrRepo"));
  const user = merge(parse(files, "userJson"), parse(files, "userToml"), parse(files, "herdrUser"));
  const layers = [local, repo, user];

  const script = (name) => {
    const value = lookup(layers, ["scripts", name]);
    return typeof value === "string" ? value.trim() : "";
  };
  const setup = script("setup");
  const archive = script("archive");
  const includeSet = typeof files.include === "string" || lookup(layers, ["file_include_globs"]) !== undefined;
  return {
    configured: Boolean(setup || archive || includeSet),
    setup,
    archive,
    include: includePatterns(files.include, layers).trim(),
    env: environment(layers),
  };
}
