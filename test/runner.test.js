import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER, ARCHIVE_RUNNER, SETUP_ARGV, PROCESS_NAME } from "../mods/worktree-setup/runner.js";

let base, root;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const touch = (path, text = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

// A main checkout with ignored files of every kind the patterns should and shouldn't reach.
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-")));
  root = join(base, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  touch(join(root, ".gitignore"), ".env*\nnode_modules/\nsecrets/\n*.log\n");
  touch(join(root, "README.md"), "hi\n");
  git(root, "add", ".");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  touch(join(root, ".env"), "SECRET=1\n");
  touch(join(root, ".env.example"), "");
  touch(join(root, "apps/web/.env.local"), "WEB=1\n");
  touch(join(root, "node_modules/pkg/.env"), "");
  touch(join(root, "secrets/key.json"), "{}");
  touch(join(root, "debug.log"), "");
});

after(() => rmSync(base, { recursive: true, force: true }));

// `input` is what the person types; without it, stdin closes at once.
function setUp(branch, { include = ".env*\n!.env.example\nsecrets/", script = "", env = {}, input } = {}) {
  const workspace = join(base, branch);
  git(root, "worktree", "add", "-q", "-b", branch, workspace);
  const marker = join(base, `${branch}.marker`);
  const result = spawnSync("bash", ["-c", RUNNER], {
    encoding: "utf8",
    input,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SHELL: "/usr/bin/true", // the shell s opens after a failure: exits at once here
      CONDUCTOR_ROOT_PATH: root,
      CONDUCTOR_WORKSPACE_PATH: workspace,
      CONDUCTOR_WORKSPACE_NAME: branch,
      WORKTREE_SETUP_INCLUDE: include,
      WORKTREE_SETUP_SCRIPT: script,
      WORKTREE_SETUP_MARKER: marker,
      ...env,
    },
  });
  return { workspace, result, marker: readFileSync(marker, "utf8").trim() };
}

// A stand-in for the person's shell, named zsh so the runners ask it for PATH. `body` is sh,
// with the arguments the runners pass ("+m", "-lic", the command).
function fakeShell(name, body) {
  const dir = join(base, `fake-shell-${name}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "zsh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

// Prints startup noise, as interactive startup files do, then runs the command with a PATH of its own.
const SHELL_WITH_PATH = 'echo "startup noise"; echo "more noise" >&2\n[ "$1 $2" = "+m -lic" ] || exit 9\nPATH="/from/the/shell:$PATH" exec /bin/sh -c "$3"';
// HOME without startup files: the real ~/.zshenv would change the PATH again when the script runs.
const quietHome = () => mkdtempSync(join(base, "home-"));

test("copies ignored files that match, whole folders included, and nothing else", () => {
  const { workspace, marker } = setUp("copy");
  assert.equal(marker, "ok");
  assert.equal(readFileSync(join(workspace, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(join(workspace, "apps/web/.env.local"), "utf8"), "WEB=1\n");
  assert.ok(existsSync(join(workspace, "secrets/key.json")));
  assert.ok(!existsSync(join(workspace, ".env.example")), "negated by !.env.example");
  assert.ok(!existsSync(join(workspace, "node_modules")), "not matched, and not walked");
  assert.ok(!existsSync(join(workspace, "debug.log")), "ignored but not matched");
});

test("runs the setup script in the worktree with the Conductor variables", () => {
  const { workspace, marker } = setUp("script", { script: 'echo "$CONDUCTOR_WORKSPACE_NAME" > made-by-setup\npwd >> made-by-setup' });
  assert.equal(marker, "ok");
  assert.equal(readFileSync(join(workspace, "made-by-setup"), "utf8"), `script\n${workspace}\n`);
});

const FAILING = "echo about to fail\nexit 3";
const choices = (stdout) => stdout.split("Run setup again").length - 1;

test("a failed setup asks what to do, and r runs setup again", () => {
  const { result, marker } = setUp("fails-retry", { script: FAILING, input: "r" });
  assert.match(result.stdout, /Setup failed \(exit 3\)/);
  assert.match(result.stdout, /r.*Run setup again[\s\S]*s.*Open a shell in the worktree \(exit to come back here\)[\s\S]*q.*Skip setup and close this pane/);
  assert.equal(result.status, 0);
  assert.equal(marker, "retry");
});

test("q skips setup, leaving the marker failed, and so does a closed stdin", () => {
  assert.equal(setUp("fails-skip", { script: FAILING, input: "q" }).marker, "failed 3");
  assert.equal(setUp("fails-closed", { script: FAILING }).marker, "failed 3");
});

test("s opens a shell, and leaving it comes back to the choices", () => {
  // The shell is true here: it exits at once, back to the choices, where r runs setup again.
  const { result, marker } = setUp("fails-shell", { script: FAILING, input: "sr" });
  assert.match(result.stdout, /Type exit to come back to these choices/);
  assert.equal(choices(result.stdout), 2, "the choices again after the shell");
  assert.equal(marker, "retry");
});

test("other keys are ignored", () => {
  const { result, marker } = setUp("fails-keys", { script: FAILING, input: "x\n yq" });
  assert.equal(choices(result.stdout), 1);
  assert.equal(marker, "failed 3");
});

test("the runner and the shell a failed setup opens run as worktree-setup, not as a shell", () => {
  const workspace = join(base, "named");
  git(root, "worktree", "add", "-q", "-b", "named", workspace);
  const marker = join(base, "named.marker");
  // The runner is the script's parent. s opens the shell, a login bash here, which reads its
  // commands from stdin up to its exit; then r, back at the choices, runs setup again.
  const result = spawnSync(SETUP_ARGV[0], SETUP_ARGV.slice(1), {
    encoding: "utf8",
    input: 's echo "$0 $DISABLE_AUTO_TITLE" > shell-name\nexit\nr',
    env: {
      PATH: process.env.PATH, HOME: base, SHELL: "/bin/bash",
      CONDUCTOR_ROOT_PATH: root, CONDUCTOR_WORKSPACE_PATH: workspace, CONDUCTOR_WORKSPACE_NAME: "named",
      WORKTREE_SETUP_INCLUDE: "", WORKTREE_SETUP_SCRIPT: "ps -o args= -p $PPID > runner-name; exit 1", WORKTREE_SETUP_MARKER: marker,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(workspace, "runner-name"), "utf8"), new RegExp(`^${PROCESS_NAME} `));
  assert.equal(readFileSync(join(workspace, "shell-name"), "utf8"), `${PROCESS_NAME} true\n`);
  assert.equal(readFileSync(marker, "utf8").trim(), "retry");
});

test("the setup script runs with the PATH the person's shell gives, whatever its startup prints", () => {
  const env = { SHELL: fakeShell("path", SHELL_WITH_PATH), HOME: quietHome() };
  const { workspace, result, marker } = setUp("shell-path", { script: 'printf %s "$PATH" > seen-path', env });
  assert.equal(marker, "ok");
  assert.match(readFileSync(join(workspace, "seen-path"), "utf8"), /^\/from\/the\/shell:/);
  assert.doesNotMatch(result.stdout, /noise|Herdr's PATH/);
});

test("when the shell gives no PATH, the script keeps the one it was given and the pane says so", () => {
  const env = { SHELL: fakeShell("fails", "exit 1"), HOME: quietHome() };
  const { workspace, result } = setUp("shell-fails", { script: 'printf %s "$PATH" > seen-path', env });
  assert.equal(readFileSync(join(workspace, "seen-path"), "utf8"), process.env.PATH);
  assert.match(result.stdout, /with Herdr's PATH: your shell's couldn't be read/);
});

test("a shell that never finishes starting is given up on", () => {
  const env = { SHELL: fakeShell("hangs", "sleep 30"), HOME: quietHome(), WORKTREE_SETUP_SHELL_WAIT: "1" };
  const started = Date.now();
  const { marker, result } = setUp("shell-hangs", { script: "true", env });
  assert.ok(Date.now() - started < 10_000, "waited for the shell");
  assert.equal(marker, "ok");
  assert.match(result.stdout, /with Herdr's PATH/);
});

test("files already in the worktree are left alone", () => {
  const workspace = join(base, "kept");
  git(root, "worktree", "add", "-q", "-b", "kept", workspace);
  touch(join(workspace, ".env"), "MINE=1\n");
  const marker = join(base, "kept.marker");
  spawnSync("bash", ["-c", RUNNER], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, SHELL: "/usr/bin/true",
      CONDUCTOR_ROOT_PATH: root, CONDUCTOR_WORKSPACE_PATH: workspace, CONDUCTOR_WORKSPACE_NAME: "kept",
      WORKTREE_SETUP_INCLUDE: ".env", WORKTREE_SETUP_SCRIPT: "", WORKTREE_SETUP_MARKER: marker,
    },
  });
  assert.equal(readFileSync(join(workspace, ".env"), "utf8"), "MINE=1\n");
});

function cleanUp(script, env = {}) {
  return spawnSync("bash", ["-c", ARCHIVE_RUNNER], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      HERDR_ROOT_PATH: root, HERDR_WORKSPACE_NAME: "gone", HERDR_WORKSPACE_PATH: join(base, "gone"),
      WORKTREE_ARCHIVE_SCRIPT: script,
      ...env,
    },
  });
}

test("the archive script runs from the main checkout and keeps its exit code", () => {
  const result = cleanUp('pwd\necho "cleaning $HERDR_WORKSPACE_NAME"');
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`\n${root}\ncleaning gone\n`));
  assert.equal(cleanUp("exit 4").status, 4);
});

test("the archive script runs with the PATH the person's shell gives too", () => {
  const result = cleanUp('printf "seen %s" "$PATH"', { SHELL: fakeShell("archive", SHELL_WITH_PATH), HOME: quietHome() });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /seen \/from\/the\/shell:/);
});
