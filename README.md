# Worktree setup for Herdr

Runs your repository's setup script whenever a new git worktree opens in Herdr. Put it in
`.herdr/settings.toml`:

```toml
[scripts]
setup = "npm ci"
```

It also reads [Conductor](https://conductor.build)'s settings, so a team that already has a
`.conductor/settings.toml` (or `conductor.json`) needs no changes.

When a space opens on a new worktree:

1. A pane opens under the space's first terminal, like Conductor's setup panel.
2. Gitignored files you've listed (`.env*` by default) are copied in from the main checkout.
3. The setup script runs, with variables such as `HERDR_ROOT_PATH` set.
4. If setup succeeds, the pane closes and a toast says so. If it fails, the pane stays
   open on a shell in the worktree. Fix the problem there or in the settings, then type
   `exit` to run setup again. Close the pane to skip setup.

## Install

1. Copy `mods/worktree-setup` into `~/.config/herdr-app/mods/`.
2. The mod draws nothing, but it has to be in your layout to run. Add it as a floating
   block on your layout's root node (`~/.config/herdr-app/layouts/<your layout>.json`):

   ```json
   "floating": [
     { "id": "worktree-setup", "content": { "mod": "worktree-setup" }, "edge": "bottom", "align": "end" }
   ]
   ```

   Herdr's shipped layouts are read-only, so if you use one, clone it first
   (`herdr-app do layout.clone --name main --as my-main`).
3. Run `herdr-app check ~/.config/herdr-app/mods/worktree-setup`.

Worktrees made before you installed the mod are left alone.

## What it reads

Herdr's files and Conductor's take the same keys. There are three levels, and the first one
that sets a key wins:

| Level | Herdr | Conductor |
|---|---|---|
| Your overrides for one repo (keep out of git) | `<repo>/.herdr/settings.local.toml` | `<repo>/.conductor/settings.local.toml` |
| The repo's shared settings | `<repo>/.herdr/settings.toml` | `<repo>/.conductor/settings.toml`, or legacy `<repo>/conductor.json` until that exists |
| Your defaults for every repo | `~/.config/herdr-app/worktree-setup.toml` | `~/.conductor/settings.toml` |

Within a level, Herdr's file beats Conductor's key by key. So a `.herdr/settings.toml` can
change one thing in a team's Conductor setup and keep the rest. Conductor's older
`settings.json` files are read too, under their `.toml`. `<repo>` is the main checkout.

From those files it uses:

- `scripts.setup`: the setup script. It runs with `zsh` (or `bash` when there's no zsh) in
  the new worktree.
- Files to copy: `.worktreeinclude` at the repo root, else `file_include_globs`, else `.env*`.
  Patterns use `.gitignore` syntax, and only gitignored files are copied. Files already in
  the worktree are never overwritten.
- `environment_variables` and `environment_variables.local`.

The setup script gets these variables, each under a `HERDR_` name and a `CONDUCTOR_` name,
so Conductor scripts work unchanged:

| Variable | Value |
|---|---|
| `HERDR_WORKSPACE_NAME` | The worktree's folder name |
| `HERDR_WORKSPACE_PATH` | The worktree |
| `HERDR_ROOT_PATH` | The main checkout |
| `HERDR_DEFAULT_BRANCH` | From `origin/HEAD`, else `main` |
| `HERDR_PORT` | The first of ten ports kept for this worktree, from 55000 |

`CONDUCTOR_IS_LOCAL=1` is set too.

A repo with none of these files is left alone.

## Not covered yet

- The archive script and Run actions (`scripts.archive`, `scripts.run`).
- The `HERDR_*` and `CONDUCTOR_*` variables reach the setup script only. Your agent's
  terminal doesn't get them.
- Repository settings are read from the main checkout's working tree. Conductor reads them
  from the default branch.
- Worktrees of a bare repository (there's no main checkout to copy from).

## How it knows a worktree is new

The mod keeps a marker file, `herdr-worktree-setup`, in the worktree's own git folder
(`.git/worktrees/<name>/`). The marker records `running`, `ok`, `failed <code>` or `retry`,
and it goes when the worktree is removed. A worktree with no marker gets set up only if it
was made after the mod was installed. Its creation time comes from the oldest entry in its
HEAD reflog.

## Development

`npm test` runs the tests with Node's built-in runner. They cover the TOML reader, the
settings precedence, the worktree helpers, and the setup script itself against real git
worktrees. `main.js` needs Herdr, so check it with `herdr-app check`.
