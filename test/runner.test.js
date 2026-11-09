import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER, ARCHIVE_RUNNER } from "../mods/worktree-setup/runner.js";

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

function setUp(branch, { include = ".env*\n!.env.example\nsecrets/", script = "" } = {}) {
  const workspace = join(base, branch);
  git(root, "worktree", "add", "-q", "-b", branch, workspace);
  const marker = join(base, `${branch}.marker`);
  const result = spawnSync("bash", ["-c", RUNNER], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SHELL: "/usr/bin/true", // the shell a failed setup leaves open: exits at once here
      CONDUCTOR_ROOT_PATH: root,
      CONDUCTOR_WORKSPACE_PATH: workspace,
      CONDUCTOR_WORKSPACE_NAME: branch,
      WORKTREE_SETUP_INCLUDE: include,
      WORKTREE_SETUP_SCRIPT: script,
      WORKTREE_SETUP_MARKER: marker,
    },
  });
  return { workspace, result, marker: readFileSync(marker, "utf8").trim() };
}

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

test("a failing script opens a shell, and leaving it asks for setup again", () => {
  const { result, marker } = setUp("fails", { script: "echo about to fail\nexit 3" });
  assert.match(result.stdout, /Setup failed \(exit 3\)/);
  assert.match(result.stdout, /type .*exit.* to run setup again/);
  assert.equal(marker, "retry", "the shell (true here) exited at once");
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

function cleanUp(script) {
  return spawnSync("bash", ["-c", ARCHIVE_RUNNER], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      HERDR_ROOT_PATH: root, HERDR_WORKSPACE_NAME: "gone", HERDR_WORKSPACE_PATH: join(base, "gone"),
      WORKTREE_ARCHIVE_SCRIPT: script,
    },
  });
}

test("the archive script runs from the main checkout and keeps its exit code", () => {
  const result = cleanUp('pwd\necho "cleaning $HERDR_WORKSPACE_NAME"');
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`\n${root}\ncleaning gone\n`));
  assert.equal(cleanUp("exit 4").status, 4);
});
