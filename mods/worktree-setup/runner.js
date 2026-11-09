// The script the setup pane runs, with bash. Everything it needs comes in its environment:
//
//   CONDUCTOR_ROOT_PATH, CONDUCTOR_WORKSPACE_PATH, CONDUCTOR_WORKSPACE_NAME  (and the other CONDUCTOR_*)
//   WORKTREE_SETUP_INCLUDE  Files to copy patterns, one per line (.gitignore syntax)
//   WORKTREE_SETUP_SCRIPT   the setup script, run with zsh like Conductor does (bash without zsh)
//   WORKTREE_SETUP_MARKER   a file in the worktree's git folder: "running", "ok", "failed <code>",
//                           or "retry" once the person leaves the shell a failed setup opens
//
// Files to copy: git lists the main checkout's ignored entries (an ignored folder such as
// node_modules is one entry and isn't walked), then git matches them against the patterns,
// in an empty scratch repo so only the patterns count. Folders that match are copied whole.
// Nothing already in the worktree is overwritten.
//
// It's a String.raw template, so it can't hold a backtick or a dollar-brace: those would end
// or interpolate the template.

export const RUNNER = String.raw`
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
printf '\033]0;Setup failed · %s\007' "$CONDUCTOR_WORKSPACE_NAME"
printf '\n\033[31m✗ Setup failed (exit %s).\033[0m\n' "$code"
printf 'Fix the problem here or in the settings, then type \033[1mexit\033[0m to run setup again.\n'
printf 'To skip setup, close this pane.\n\n'
shell=$SHELL
[ -n "$shell" ] || shell=/bin/bash
"$shell" -l
printf 'retry\n' > "$marker"
`;

// The script a background terminal runs after a worktree is removed. Conductor runs its
// archive script inside the workspace before deleting it; here the worktree is already gone,
// so it runs from the main checkout (HERDR_ROOT_PATH). Its exit code is the script's.
//
//   WORKTREE_ARCHIVE_SCRIPT  the archive script, run with zsh (bash without zsh)
export const ARCHIVE_RUNNER = String.raw`
printf '\033]0;Clean up · %s\007' "$HERDR_WORKSPACE_NAME"
cd "$HERDR_ROOT_PATH" || exit 1
printf '\033[2mCleaning up after %s, removed from %s\033[0m\n' "$HERDR_WORKSPACE_NAME" "$HERDR_WORKSPACE_PATH"
printf '%s\n' "$WORKTREE_ARCHIVE_SCRIPT" | while IFS= read -r line; do printf '\033[2m  %s\033[0m\n' "$line"; done
echo
if command -v zsh > /dev/null 2>&1; then exec zsh -c "$WORKTREE_ARCHIVE_SCRIPT"; fi
exec bash -c "$WORKTREE_ARCHIVE_SCRIPT"
`;
