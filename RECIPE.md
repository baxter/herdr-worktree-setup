# Worktree setup

When a space opens on a new git worktree, a pane slides in under its first terminal and
runs the repository's setup: it copies gitignored files such as `.env` from the main
checkout, then runs `scripts.setup` from `.herdr/settings.toml` (or Conductor's
`.conductor/settings.toml`, which takes the same keys). When setup
succeeds, the pane closes and a toast says so. When it fails, the pane stays open on a shell
in the worktree, and a toast says what happened.

![Worktree setup](preview.png)

## What you see

- Nothing, most of the time. The mod is a floating block that renders an empty `div()`,
  so it takes no space and draws no frame.
- When a new worktree's space opens: a terminal pane splits **down** from the space's first
  pane (half the height). Its title is `Setup · <worktree folder name>`. It prints, dimmed:
  `Copying files from <main checkout>`, then each copied path indented two spaces (or
  `nothing matched`, or `<path> is already there`); then `Running the setup script` and the
  script's lines, each indented; then the script's own output. It ends with a green
  `✓ Setup finished`, or a red `✗ Setup failed (exit N).` followed by `Fix the problem
  here or in the settings, then type exit to run setup again.` and `To skip setup, close
  this pane.`
- Toasts (Herdr's `notify`): success `"<name> is set up"` (level success, 4 s). Failure
  `"Setup failed in <name>"`, body `Exit N. Its pane is still open: fix the problem, then
  type exit to run setup again.` (level error; clicking it selects that space). A settings
  file that can't be parsed: `"Worktree setup didn't start"` with the file name and line.

## How it behaves

- The pane above (usually an agent) keeps the keyboard: the mod refocuses it right after
  the split.
- A worktree counts as new when it has no marker file and was made after the mod was
  installed. The install time is stored in `shared("worktree-setup.installed-at")` (unix
  seconds) on the first start.
- A repository with no settings at all (none of the `.herdr` or `.conductor` files, no
  `conductor.json`, no `.worktreeinclude`, nothing in `~/.config/herdr-app/worktree-setup.toml` or
  `~/.conductor`) gets no pane.
- Success: the runner writes `ok` to the marker and exits, and the pane closes itself. The
  mod, polling every 1.5 s while a setup is open, posts the success toast.
- Failure: the runner writes `failed N` and starts a login shell in the worktree, with the
  `HERDR_*` and `CONDUCTOR_*` variables set. Typing `exit` writes `retry` and ends the
  runner, which closes the pane. The mod then reads the settings again and opens a fresh
  setup pane in the same place. Closing the
  pane instead abandons setup: the marker stays `failed N`, so it isn't retried.
- Agent statuses: it doesn't show any.
- No clicks or keys of its own.

## Built from

- Layout: one floating block on the root node:
  `{ "id": "worktree-setup", "content": { "mod": "worktree-setup" }, "edge": "bottom", "align": "end" }`.
  `mod.json` is `{ "place": "none" }`.
- `main.js` (the View): `render()` walks `spaces()`. For each space not seen before whose
  first tab already has a terminal pane (`panes()`), it checks the worktree with `exec("git", …)`:
  - `rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`. Linked
    when git-dir differs from common-dir; the main checkout is common-dir without `/.git`.
  - `readTextFile("<git-dir>/herdr-worktree-setup")` must be null.
  - `log -g --date=unix --format=%gd HEAD`: the oldest `HEAD@{<unix>}` is the creation time.

  It then reads every file in `settings.js`'s `FILES` with `readTextFile` (each entry says
  whether its path is under the main checkout or the home folder). Then `run("pane.split", { direction: "down", pane, argv })` with
  `argv = ["env", "NAME=value"…, "bash", "-c", RUNNER]`, and `run("pane.focus", { pane })`.
  `cx.timer.every(1500)` polls the marker files of open setups. It uses `notify`, `shared` /
  `setShared` (install time; ports keyed by worktree path), `home`, and `exec("sh", ["-c",
  'printf %s "$HOME"'], { on })` on other machines.
- `settings.js`: three levels, first match wins: local > repo > user. Each level merges its
  files key by key, later winning:
  - local: `.conductor/settings.local.json`, `.conductor/settings.local.toml`,
    `.herdr/settings.local.toml`
  - repo: `conductor.json` (only while `.conductor/settings.toml` is absent),
    `.conductor/settings.json`, `.conductor/settings.toml`, `.herdr/settings.toml`
  - user: `~/.conductor/settings.json`, `~/.conductor/settings.toml`,
    `~/.config/herdr-app/worktree-setup.toml`

  So a level never loses to a lower one, and within a level Herdr's file beats Conductor's. Files to copy: `.worktreeinclude`, else
  `file_include_globs` (string or array), else `.env*`. Environment: `environment_variables`
  plain values, overridden by `environment_variables.local`; `cloud` is ignored.
- `toml.js`: a small TOML reader (tables, arrays of tables, dotted and quoted keys, all four
  string forms, numbers, booleans, arrays, inline tables; dates kept as text). Its errors
  name the line.
- `runner.js`: the bash script, as a `String.raw` template. Its inputs come from the
  environment:
  - `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_WORKSPACE_NAME`
  - `WORKTREE_SETUP_INCLUDE`, `WORKTREE_SETUP_SCRIPT`, `WORKTREE_SETUP_MARKER`

  Files to copy are found like this:
  1. `git -C <main> ls-files -z -o -i --exclude-standard --directory` lists the ignored
     entries. Ignored folders come out as one entry and aren't walked.
  2. That list is piped into `git -C <scratch repo> -c core.excludesFile=<patterns>
     check-ignore --no-index -z --stdin`, so git applies the include patterns with real
     `.gitignore` rules, `!` negation included.
  3. Matches are copied with `cp -Rp`, skipping anything that already exists and anything
     inside a folder that was just copied.

  The setup script runs with `zsh -c` (else `bash -c`).
- `worktree.js`: pure helpers (rev-parse parsing, creation time, ports, setup variables, env
  arguments, marker parsing).
- Variables given to the setup, each as `HERDR_<X>` and `CONDUCTOR_<X>` from one value
  (`setupVariables`): `WORKSPACE_NAME` (the worktree's folder name), `WORKSPACE_PATH`,
  `ROOT_PATH`, `DEFAULT_BRANCH` (from `origin/HEAD`, else `main`), `PORT` (the lowest free
  block of 10 from 55000, kept per worktree). Plus `CONDUCTOR_IS_LOCAL=1` and the settings'
  environment variables (the built-in ones win).
- Programs it runs: `git`, `bash`, `zsh` if present, `env`, `cp`, `mktemp`, `sed`. No
  network.

## Watch out

- A `Map` visits keys added during a `for…of` loop. A retry deletes its job and `launch()`
  re-adds it, so poll over a copy (`[...this.jobs]`), or a retry launches twice.
- `String.raw` keeps a backslash before `${`, so the bash script can't use `${…}` at all.
  Use `case` patterns instead (`case $entry in "$inside"*)`, `sed 's#/$##'`). It can't hold
  a backtick either.
- `%ct` in `git log -g` is the commit's date, not the reflog entry's. Use
  `--date=unix --format=%gd`.
- `ls-files -o -i -x <patterns>` without `--exclude-standard` walks `node_modules` and
  copies `.env` files from packages. List the ignored entries first, then match.
- Don't run setup from a `post-checkout` hook or inside `exec`. `exec` has a 30-second
  limit, and setup output belongs in a pane.
- `pane.split` with `argv` runs the program directly: when it exits, the terminal ends and
  its pane closes itself. So the runner opens its own login shell on failure, and the mod
  must never `pane.close` a setup pane: it races the exit and fails with `no pane "…"`. Interactive login-shell PATH
  additions (mise, nvm) did reach the script in testing on macOS.
- Spaces the person opens on existing worktrees made before install are skipped on purpose.
  Clearing `worktree-setup.installed-at` would make every unmarked worktree look new.
- `space.new` selects the new space, so testing live moves the person's window.
- Assumes `bash` and `git` on the machine (a remote space's machine too). Bare repositories
  have no main checkout and are skipped. Repository settings are read from the main
  checkout's working tree, not the default branch as Conductor does.
- Not built: `scripts.archive`, `scripts.run` actions, `preview_urls`. The `HERDR_*` and
  `CONDUCTOR_*` variables reach the setup pane only, not the space's other terminals.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/worktree-setup` passes, and `herdr-app status`
  shows the `worktree-setup` float with no errors and nothing visible on screen.
- In a repo with `.conductor/settings.toml` setting `scripts.setup`, and a gitignored `.env`
  in the main checkout: `git worktree add` a branch, then open a space on it. A pane opens
  below, copies `.env`, runs the script with `HERDR_PORT` and `CONDUCTOR_PORT` both
  `55000`, closes itself, and a success toast appears.
- The same with only `.herdr/settings.toml`. With both, a key set in `.herdr` wins and the
  others come from `.conductor`. The marker in `.git/worktrees/<name>/herdr-worktree-setup` reads
  `ok`.
- With a `settings.local.toml` setup that ends in `exit 1`, the pane stays open showing the
  failure message, and an error toast appears. Fixing the file and typing `exit` opens one
  new pane (not two), which runs the fixed script and closes.
- A space on a worktree made before install, or in a repo with no Conductor files, gets no
  pane.
- `npm test` passes.
