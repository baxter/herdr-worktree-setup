// Pure helpers for deciding when a worktree needs setting up and what the setup pane gets.
// No Herdr imports, so they can be tested outside the app.

// `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`, one path a
// line. `root` is the main checkout (null for a bare repository, which has none).
export function parseRevParse(stdout) {
  const [top, gitDir, commonDir] = stdout.trim().split("\n");
  if (!top || !gitDir || !commonDir) return null;
  const root = commonDir.endsWith("/.git") ? commonDir.slice(0, -"/.git".length) : null;
  return { top, gitDir, commonDir, root, linked: gitDir !== commonDir };
}

// `git log -g --date=unix --format=%gd HEAD` in the worktree, newest first: "HEAD@{1794149777}".
// Its oldest entry is when the worktree was made. null when the reflog is empty or off.
export function createdAt(stdout) {
  const times = [...stdout.matchAll(/@\{(\d+)\}/g)].map((match) => Number(match[1]));
  return times.length ? times[times.length - 1] : null;
}

// Worktrees made before the mod was installed are left as they are.
export function isNew(created, installedAt) {
  return created !== null && typeof installedAt === "number" && created >= installedAt;
}

// Conductor gives each workspace ten ports, CONDUCTOR_PORT to CONDUCTOR_PORT + 9.
export const FIRST_PORT = 55000;
export const PORTS_EACH = 10;

// The worktree's port block: the one it already has, else the lowest one nobody holds.
export function allocatePort(taken, worktree) {
  if (taken[worktree]) return taken[worktree];
  const used = new Set(Object.values(taken));
  let port = FIRST_PORT;
  while (used.has(port)) port += PORTS_EACH;
  return port;
}

// `git rev-parse --abbrev-ref origin/HEAD` gives "origin/main"; without it, "main".
export function defaultBranch(stdout) {
  const ref = stdout.trim();
  return ref && ref !== "origin/HEAD" ? ref.replace(/^origin\//, "") : "main";
}

export const workspaceName = (path) => path.split("/").filter(Boolean).pop() ?? path;

// A linked worktree's `.git` is a file, "gitdir: <its git folder>", which git may write
// relative to the worktree. null when it isn't one.
export function gitDirOf(gitFile, path) {
  const dir = String(gitFile ?? "").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!dir) return null;
  return dir.startsWith("/") ? dir : `${path}/${dir}`;
}

// A git folder's HEAD file, "ref: refs/heads/<branch>": the branch. null when it's detached.
export function branchOf(head) {
  return String(head ?? "").match(/^ref: refs\/heads\/(.+?)\s*$/m)?.[1] ?? null;
}

// The variables a setup script gets, each under Herdr's name and Conductor's, so Conductor
// scripts work unchanged. CONDUCTOR_IS_LOCAL has no Herdr twin: Herdr has no cloud workspaces.
export function setupVariables({ name, path, root, defaultBranch, port }) {
  const values = {
    WORKSPACE_NAME: name,
    WORKSPACE_PATH: path,
    ROOT_PATH: root,
    DEFAULT_BRANCH: defaultBranch,
    PORT: String(port),
  };
  const variables = { CONDUCTOR_IS_LOCAL: "1" };
  for (const [key, value] of Object.entries(values)) {
    variables[`HERDR_${key}`] = value;
    variables[`CONDUCTOR_${key}`] = value;
  }
  return variables;
}

// `env NAME=value ...` arguments. Names a shell can't hold are left out.
export function envArguments(env) {
  return Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${value}`);
}

// What the marker file in the worktree's git folder says: "running", "ok", "failed <code>" or
// "retry" (the person fixed a failure and wants setup run again).
export function parseMarker(text) {
  const [state, code] = String(text ?? "").trim().split(/\s+/);
  if (state === "ok" || state === "running" || state === "retry") return { state };
  if (state === "failed") return { state, code: Number(code) };
  return null;
}

// What to do about a worktree the first time the mod sees its space: on start, after a reload,
// or when the space opens. The mod keeps its setups in memory, so a setup it started before a
// reload or a restart is only known by its marker (null when there's none) and its pane.
// "launch": set it up. It's new, or the person pressed r to retry while nothing was watching.
// "watch": follow the setup pane that's still open, as if the mod had just started it.
// null: leave it alone. It's done, its pane was closed (setup abandoned), or it's from before install.
export function onFirstSight(markerText, { isNew, setupPaneOpen }) {
  if (markerText === null) return isNew ? "launch" : null;
  const state = parseMarker(markerText)?.state;
  if (state === "retry") return "launch";
  if (state === "running" || state === "failed") return setupPaneOpen ? "watch" : null;
  return null;
}
