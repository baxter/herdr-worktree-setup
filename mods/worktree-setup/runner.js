// The script the setup pane runs, with bash. Everything it needs comes in its environment:
//
//   CONDUCTOR_ROOT_PATH, CONDUCTOR_WORKSPACE_PATH, CONDUCTOR_WORKSPACE_NAME  (and the other CONDUCTOR_*)
//   WORKTREE_SETUP_INCLUDE  Files to copy patterns, one per line (.gitignore syntax)
//   WORKTREE_SETUP_SCRIPT   the setup script, run with zsh like Conductor does (bash without zsh)
//   WORKTREE_SETUP_MARKER   a file in the worktree's git folder: "running", "ok", "failed <code>",
//                           or "retry" once the person chooses to run a failed setup again
//
// Files to copy: git lists the main checkout's ignored entries (an ignored folder such as
// node_modules is one entry and isn't walked), then git matches them against the patterns,
// in an empty scratch repo so only the patterns count. Folders that match are copied whole.
// Nothing already in the worktree is overwritten.
//
// It's a String.raw template, so it can't hold a backtick or a dollar-brace: those would end
// or interpolate the template.
//
// Herdr's pane header names a shell's pane after the shell ("bash", "zsh") and any other
// program's after its title, and it tells which by argv[0]. So the runner, and the shell a
// failed setup opens, run as PROCESS_NAME: the header then shows the title the runner sets.
// The bash below spells the name out too; keep the two the same.

export const PROCESS_NAME = "worktree-setup";

// Herdr starts terminals with the login shell's PATH. On macOS that puts /usr/bin ahead of
// what interactive startup files add (a version manager, say), so a setup script found the
// system's copy of a tool where a terminal finds the version-managed one. So before running a script,
// both runners ask the person's shell, started as an interactive login shell in the current
// folder, for its PATH, and run the script with that. Only PATH: the rest of a terminal's
// environment is about prompts and terminals, not scripts.
//
// - The shell writes PATH to a file, so whatever its startup prints doesn't matter.
// - It reads nothing (stdin is /dev/null) and is given up on after WORKTREE_SETUP_SHELL_WAIT
//   seconds (default 10), so a startup file that asks a question can't hold setup up.
//   DISABLE_AUTO_UPDATE stops oh-my-zsh asking whether to update.
// - +m turns job control off. Without it, an interactive zsh takes the terminal over and
//   never hands it back, and the runner can't read from the terminal afterwards.
// - zsh and bash only: both take +m -lic. With any other shell, or when the shell fails, the
//   script keeps the PATH it was given.
const SHELL_PATH = String.raw`
use_shell_path() {
  local file found pid waited=0 limit=$WORKTREE_SETUP_SHELL_WAIT
  case $SHELL in */zsh|*/bash) ;; *) return 1 ;; esac
  [ -n "$limit" ] || limit=10
  file=$(mktemp) || return 1
  WORKTREE_SETUP_PATH_FILE=$file DISABLE_AUTO_UPDATE=true \
    "$SHELL" +m -lic 'printenv PATH > "$WORKTREE_SETUP_PATH_FILE"' < /dev/null > /dev/null 2>&1 &
  pid=$!
  while kill -0 "$pid" 2> /dev/null; do
    if [ "$waited" -ge $((limit * 10)) ]; then kill "$pid" 2> /dev/null; break; fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid" 2> /dev/null
  found=$(cat "$file")
  rm -f "$file"
  [ -n "$found" ] || return 1
  export PATH="$found"
}
`;

export const RUNNER = SHELL_PATH + String.raw`
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
marker=$WORKTREE_SETUP_MARKER
printf '\033]0;Setup · %s\007' "$CONDUCTOR_WORKSPACE_NAME"
printf 'running\n' > "$marker"

copy_files() {
  [ -n "$WORKTREE_SETUP_INCLUDE" ] || return 0
  local scratch entry path inside= copied=0
  scratch=$(mktemp -d) || return 1
  git init -q "$scratch/matcher" || return 1
  printf '%s\n' "$WORKTREE_SETUP_INCLUDE" > "$scratch/patterns"
  dim "Copying files from $CONDUCTOR_ROOT_PATH"
  while IFS= read -r -d '' entry; do
    # Inside a folder that was just copied whole.
    if [ -n "$inside" ]; then case $entry in "$inside"*) continue ;; esac; fi
    path=$entry
    case $entry in */) inside=$entry; path=$(printf '%s' "$entry" | sed 's#/$##') ;; esac
    if [ -e "$CONDUCTOR_WORKSPACE_PATH/$path" ]; then dim "  $entry is already there"; continue; fi
    mkdir -p "$(dirname "$CONDUCTOR_WORKSPACE_PATH/$path")" &&
      cp -Rp "$CONDUCTOR_ROOT_PATH/$path" "$CONDUCTOR_WORKSPACE_PATH/$path" || { rm -rf "$scratch"; return 1; }
    echo "  $entry"
    copied=$((copied + 1))
  done < <(git -C "$CONDUCTOR_ROOT_PATH" ls-files -z -o -i --exclude-standard --directory |
    git -C "$scratch/matcher" -c core.excludesFile="$scratch/patterns" check-ignore --no-index -z --stdin)
  rm -rf "$scratch"
  [ "$copied" -gt 0 ] || dim "  nothing matched"
}

run_setup() {
  [ -n "$WORKTREE_SETUP_SCRIPT" ] || return 0
  echo
  dim "Running the setup script"
  printf '%s\n' "$WORKTREE_SETUP_SCRIPT" | while IFS= read -r line; do dim "  $line"; done
  use_shell_path || dim "  with Herdr's PATH: your shell's couldn't be read"
  echo
  if command -v zsh > /dev/null 2>&1; then zsh -c "$WORKTREE_SETUP_SCRIPT"; else bash -c "$WORKTREE_SETUP_SCRIPT"; fi
}

cd "$CONDUCTOR_WORKSPACE_PATH" && copy_files && run_setup
code=$?
if [ "$code" -eq 0 ]; then
  printf 'ok\n' > "$marker"
  printf '\n\033[32m✓ Setup finished\033[0m\n'
  exit 0
fi
printf 'failed %s\n' "$code" > "$marker"
printf '\n\033[31m✗ Setup failed (exit %s).\033[0m\n' "$code"
printf 'How would you like to proceed?\n'
shell=$SHELL
[ -n "$shell" ] || shell=/bin/bash
# What happens next is the person's choice, one key at a time, until they run setup again or
# skip it. Skipping leaves the marker at "failed", as closing the pane does, so the mod
# doesn't retry. When stdin closes there's nobody to ask, so that skips too.
while :; do
  printf '\033]0;Setup failed · %s\007' "$CONDUCTOR_WORKSPACE_NAME"
  printf '\n  \033[1mr\033[0m  Run setup again\n'
  printf '  \033[1ms\033[0m  Open a shell in the worktree (exit to come back here)\n'
  printf '  \033[1mq\033[0m  Skip setup and close this pane\n\n'
  key=
  until case $key in r|R|s|S|q|Q) true ;; *) false ;; esac; do
    read -r -s -n 1 key || key=q
  done
  case $key in
    r|R) printf 'retry\n' > "$marker"; exit 0 ;;
    q|Q) exit 0 ;;
  esac
  dim "Type exit to come back to these choices."
  # Renamed so the header keeps the title. DISABLE_AUTO_TITLE stops oh-my-zsh retitling the
  # terminal at every prompt; a prompt that sets its own title another way still wins.
  (export DISABLE_AUTO_TITLE=true; exec -a worktree-setup "$shell" -l)
done
`;

// The setup pane's program: bash, running RUNNER as PROCESS_NAME.
export const SETUP_ARGV = ["bash", "-c", `exec -a ${PROCESS_NAME} bash -c "$1"`, PROCESS_NAME, RUNNER];

// The script a background terminal runs after a worktree is removed. Conductor runs its
// archive script inside the workspace before deleting it. Herdr removes the worktree first,
// so this makes a stand-in: a fresh checkout of the worktree's branch (detached at the main
// checkout's HEAD when there's no branch, or it's checked out elsewhere), in a scratch folder
// with the worktree's folder name. So a script that names things after basename "$PWD", runs
// git, or runs a file from the repo works as it does in Conductor. It's a separate checkout,
// so a script that deletes local files can't touch the main checkout. The worktree's own
// untracked files (.env, installed packages) are gone and aren't in it.
//
// - Checking out runs no git hooks, and Git LFS files stay pointers: nothing to download.
// - The script's stdin is /dev/null: there's nobody to answer a question, as in Conductor.
// - The stand-in is removed when the script ends, however it ends. Its exit code is the script's.
// - When the stand-in can't be made, the script runs from the main checkout, and says so.
//
//   HERDR_ROOT_PATH, HERDR_WORKSPACE_NAME, HERDR_WORKSPACE_PATH  (and the other HERDR_*, CONDUCTOR_*)
//   WORKTREE_ARCHIVE_SCRIPT  the archive script, run with zsh (bash without zsh)
//   WORKTREE_ARCHIVE_BRANCH  the branch the worktree was last seen on; empty when unknown
export const ARCHIVE_RUNNER = SHELL_PATH + String.raw`
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
quiet_git() { GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null "$@" > /dev/null 2>&1; }
printf '\033]0;Clean up · %s\007' "$HERDR_WORKSPACE_NAME"
cd "$HERDR_ROOT_PATH" || exit 1
dim "Cleaning up after $HERDR_WORKSPACE_NAME, removed from $HERDR_WORKSPACE_PATH"

scratch=$(mktemp -d) || exit 1
stand_in=$scratch/$HERDR_WORKSPACE_NAME
remove_stand_in() {
  cd "$HERDR_ROOT_PATH" && quiet_git worktree remove --force "$stand_in"
  rm -rf "$scratch"
  quiet_git -C "$HERDR_ROOT_PATH" worktree prune
}
trap remove_stand_in EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Where the script runs. remove_stand_in only ever removes the stand-in, never this.
here=$stand_in
if [ -n "$WORKTREE_ARCHIVE_BRANCH" ] && quiet_git worktree add -q "$stand_in" "$WORKTREE_ARCHIVE_BRANCH"; then
  dim "  in a checkout of $WORKTREE_ARCHIVE_BRANCH at $stand_in"
elif quiet_git worktree add -q --detach "$stand_in"; then
  dim "  in a checkout at $stand_in"
else
  here=$HERDR_ROOT_PATH
  dim "  from the main checkout: a stand-in checkout couldn't be made"
fi
cd "$here" || exit 1
printf '%s\n' "$WORKTREE_ARCHIVE_SCRIPT" | while IFS= read -r line; do dim "  $line"; done
use_shell_path || dim "  with Herdr's PATH: your shell's couldn't be read"
echo
if command -v zsh > /dev/null 2>&1; then
  zsh -c "$WORKTREE_ARCHIVE_SCRIPT" < /dev/null
else
  bash -c "$WORKTREE_ARCHIVE_SCRIPT" < /dev/null
fi
`;
