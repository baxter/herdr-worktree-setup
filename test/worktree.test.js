import { test } from "node:test";
import assert from "node:assert/strict";
import * as worktree from "../mods/worktree-setup/worktree.js";

test("a linked worktree knows its main checkout", () => {
  assert.deepEqual(
    worktree.parseRevParse("/w/feature\n/r/.git/worktrees/feature\n/r/.git\n"),
    { top: "/w/feature", gitDir: "/r/.git/worktrees/feature", commonDir: "/r/.git", root: "/r", linked: true },
  );
  assert.equal(worktree.parseRevParse("/r\n/r/.git\n/r/.git\n").linked, false);
  assert.equal(worktree.parseRevParse("/w/x\n/b.git/worktrees/x\n/b.git\n").root, null);
  assert.equal(worktree.parseRevParse(""), null);
});

test("a worktree was made at its oldest reflog entry", () => {
  assert.equal(worktree.createdAt("HEAD@{1794149900}\nHEAD@{1794149777}\n"), 1794149777);
  assert.equal(worktree.createdAt(""), null);
});

test("only worktrees made since the mod was installed are new", () => {
  assert.equal(worktree.isNew(200, 100), true);
  assert.equal(worktree.isNew(50, 100), false);
  assert.equal(worktree.isNew(null, 100), false);
  assert.equal(worktree.isNew(200, undefined), false);
});

test("each worktree keeps its own block of ten ports", () => {
  assert.equal(worktree.allocatePort({}, "/a"), 55000);
  assert.equal(worktree.allocatePort({ "/a": 55000 }, "/b"), 55010);
  assert.equal(worktree.allocatePort({ "/a": 55000, "/b": 55010 }, "/b"), 55010);
  assert.equal(worktree.allocatePort({ "/b": 55010 }, "/c"), 55000, "a freed block is reused");
});

test("the default branch comes from origin/HEAD", () => {
  assert.equal(worktree.defaultBranch("origin/develop\n"), "develop");
  assert.equal(worktree.defaultBranch(""), "main");
});

test("setup variables come under Herdr's names and Conductor's", () => {
  const variables = worktree.setupVariables({ name: "x", path: "/w/x", root: "/r", defaultBranch: "main", port: 55010 });
  assert.equal(variables.HERDR_ROOT_PATH, "/r");
  assert.equal(variables.CONDUCTOR_ROOT_PATH, "/r");
  assert.equal(variables.HERDR_PORT, "55010");
  assert.equal(variables.CONDUCTOR_PORT, "55010");
  assert.equal(variables.CONDUCTOR_IS_LOCAL, "1");
  assert.equal(Object.keys(variables).length, 11);
});

test("env arguments skip names a shell can't hold", () => {
  assert.deepEqual(worktree.envArguments({ A: "1", "B-C": "2", _D: "multi\nline" }), ["A=1", "_D=multi\nline"]);
});

test("the marker says how setup went", () => {
  assert.deepEqual(worktree.parseMarker("ok\n"), { state: "ok" });
  assert.deepEqual(worktree.parseMarker("failed 3\n"), { state: "failed", code: 3 });
  assert.deepEqual(worktree.parseMarker("retry\n"), { state: "retry" });
  assert.equal(worktree.parseMarker(null), null);
});

test("a worktree's git folder and branch come from its .git file and HEAD", () => {
  assert.equal(worktree.gitDirOf("gitdir: /r/.git/worktrees/x\n", "/w/x"), "/r/.git/worktrees/x");
  assert.equal(worktree.gitDirOf("gitdir: ../r/.git/worktrees/x\n", "/w/x"), "/w/x/../r/.git/worktrees/x");
  assert.equal(worktree.gitDirOf(null, "/w/x"), null);
  assert.equal(worktree.branchOf("ref: refs/heads/feature/one\n"), "feature/one");
  assert.equal(worktree.branchOf("3f2a9c0d1e\n"), null, "detached");
  assert.equal(worktree.branchOf(null), null);
});

test("on first sight, a setup left over from before a reload is followed or retried", () => {
  const sight = (marker, isNew, setupPaneOpen) => worktree.onFirstSight(marker, { isNew, setupPaneOpen });
  assert.equal(sight(null, true, false), "launch", "new");
  assert.equal(sight(null, false, false), null, "made before install");
  assert.equal(sight("failed 1\n", false, true), "watch", "failed, its pane still open");
  assert.equal(sight("running\n", false, true), "watch", "still running");
  assert.equal(sight("failed 1\n", false, false), null, "its pane was closed: abandoned");
  assert.equal(sight("running\n", false, false), null, "its pane is gone");
  assert.equal(sight("retry\n", false, false), "launch", "r pressed while nothing was watching");
  assert.equal(sight("ok\n", false, false), null, "done");
  assert.equal(sight("", false, true), null, "a marker it can't read");
});
