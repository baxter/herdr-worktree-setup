// Worktree setup: when a space opens on a git worktree made since this mod was installed, run
// the repo's setup (Files to copy, then scripts.setup, from .herdr/ or Conductor's settings)
// in a pane under its first terminal. Success closes the pane. Failure leaves it open on a
// shell and posts a toast; leaving that shell runs setup again with the settings read afresh.
//
// When a worktree it set up is removed, it runs the repo's scripts.archive in a background
// terminal from the main checkout, and posts a toast with the result.
//
// It draws nothing: put it in the layout as a floating block (see the README).

import { View, div } from "gpui-kit";
import { spaces, panes, exec, hc, readTextFile, run, notify, shared, setShared, home } from "herdr";
import { resolveSettings, FILES } from "./settings.js";
import { SETUP_ARGV, ARCHIVE_RUNNER } from "./runner.js";
import * as worktree from "./worktree.js";

// The marker file, kept in the worktree's own git folder so it goes when the worktree does.
const MARKER = "herdr-worktree-setup";
const INSTALLED_AT = "worktree-setup.installed-at";
// Every worktree the mod has set up: { [path]: { root, port, on } }. Its ports come from here,
// and so does the list of worktrees to clean up after.
const WORKTREES = "worktree-setup.worktrees";
// How often to look for removed worktrees, and how soon after a space closes.
const SWEEP_EVERY_MS = 60_000;
const SWEEP_AFTER_CLOSE_MS = 3_000;

async function git(cwd, args, on) {
  const result = await exec("git", args, { cwd, on });
  return { ok: result.code === 0, out: (result.stdout ?? "").trim() };
}

async function homeOf(on) {
  if (!on) return home();
  const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Couldn't find the home folder on ${on}.`);
  return result.stdout.trim();
}

async function readSettings(root, on) {
  const userHome = await homeOf(on);
  const files = {};
  for (const [key, { base, path }] of Object.entries(FILES)) {
    files[key] = await readTextFile(`${base === "home" ? userHome : root}/${path}`, { on });
  }
  return resolveSettings(files);
}

// The variables both scripts get, from the settings and the worktree.
async function variables(settings, { name, path, root, port, on }) {
  const origin = await git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"], on);
  const defaultBranch = worktree.defaultBranch(origin.ok ? origin.out : "");
  return { ...settings.env, ...worktree.setupVariables({ name, path, root, defaultBranch, port }) };
}

function reportError(title, error) {
  notify({ title, body: String(error?.message ?? error), level: "error" });
}

export default class WorktreeSetup extends View {
  init(_props, cx) {
    this.considered = new Set(); // space ids already looked at
    this.jobs = new Map(); // git folder -> a setup that is running or failed
    this.cleanups = new Map(); // terminal address -> a cleanup that is running
    this.polling = false;
    this.sweeping = false;
    this.nextSweep = Date.now() + 5_000; // soon after start: catches removals while Herdr was closed
    this.spaceCount = null;
    if (typeof shared(INSTALLED_AT) !== "number") setShared(INSTALLED_AT, Math.floor(Date.now() / 1000));
    cx.timer.every(1500, (cx) => {
      if ((this.jobs.size || this.cleanups.size) && !this.polling) cx.spawn(async () => this.poll());
      if (Date.now() >= this.nextSweep && !this.sweeping) {
        this.nextSweep = Date.now() + SWEEP_EVERY_MS;
        cx.spawn(async () => this.sweep());
      }
    });
  }

  render(cx) {
    const allSpaces = spaces();
    // Herdr's "Remove worktree" closes the space, then removes the checkout: look soon after.
    if (this.spaceCount !== null && allSpaces.length < this.spaceCount) {
      this.nextSweep = Math.min(this.nextSweep, Date.now() + SWEEP_AFTER_CLOSE_MS);
    }
    this.spaceCount = allSpaces.length;

    const allPanes = panes();
    for (const space of allSpaces) {
      if (this.considered.has(space.id)) continue;
      const firstTab = space.tabs[0];
      const pane = firstTab && allPanes.find((p) => p.tab === firstTab.id && p.terminal);
      if (!pane) continue; // its first terminal isn't up yet; the change that brings it renders again
      this.considered.add(space.id);
      cx.spawn(async () => {
        try {
          const job = await this.newWorktree(space, pane);
          if (job) await this.launch(job);
        } catch (error) {
          reportError("Worktree setup didn't start", error);
        }
      });
    }
    return div();
  }

  // A job when the space shows a worktree that was made since install and has no marker yet.
  async newWorktree(space, pane) {
    const on = space.machine ?? null;
    const folder = space.folder || pane.cwd;
    if (!folder) return null;
    const paths = await git(folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], on);
    const repo = paths.ok ? worktree.parseRevParse(paths.out) : null;
    if (!repo?.linked || !repo.root || this.jobs.has(repo.gitDir)) return null;

    const marker = `${repo.gitDir}/${MARKER}`;
    if ((await readTextFile(marker, { on })) !== null) return null; // set up already
    const reflog = await git(repo.top, ["log", "-g", "--date=unix", "--format=%gd", "HEAD"], on);
    if (!worktree.isNew(worktree.createdAt(reflog.out), shared(INSTALLED_AT))) return null;
    return { repo, marker, on, name: worktree.workspaceName(repo.top), space: space.id, tab: pane.tab, anchor: pane.pane };
  }

  // Reads the settings and starts the setup pane under the job's anchor pane.
  async launch(job) {
    const { repo, on } = job;
    const settings = await readSettings(repo.root, on);
    if (!settings.configured) return;

    const tracked = shared(WORKTREES) ?? {};
    const taken = Object.fromEntries(Object.entries(tracked).map(([path, record]) => [path, record.port]));
    const port = worktree.allocatePort(taken, repo.top);
    if (!tracked[repo.top]) setShared(WORKTREES, { ...tracked, [repo.top]: { root: repo.root, port, on } });
    const env = {
      ...(await variables(settings, { name: job.name, path: repo.top, root: repo.root, port, on })),
      WORKTREE_SETUP_INCLUDE: settings.include,
      WORKTREE_SETUP_SCRIPT: settings.setup,
      WORKTREE_SETUP_MARKER: job.marker,
    };

    const tabPanes = panes().filter((p) => p.tab === job.tab);
    const anchor = tabPanes.find((p) => p.pane === job.anchor) ?? tabPanes[0];
    if (!anchor) return; // the tab is gone
    job.before = new Set(tabPanes.map((p) => p.pane));
    job.pane = null;
    job.state = "running";
    run("pane.split", { direction: "down", pane: anchor.pane, argv: ["env", ...worktree.envArguments(env), ...SETUP_ARGV] });
    run("pane.focus", { pane: anchor.pane }); // the agent keeps the keyboard
    this.jobs.set(repo.gitDir, job);
  }

  // Finds worktrees the mod set up that are gone, forgets them and cleans up after them.
  // A worktree is gone when its `.git` file is.
  async sweep() {
    this.sweeping = true;
    try {
      for (const [path, record] of Object.entries(shared(WORKTREES) ?? {})) {
        let gitFile;
        try {
          gitFile = await readTextFile(`${path}/.git`, { on: record.on });
        } catch {
          continue; // its machine is out of reach: look again next time
        }
        if (gitFile !== null) continue;
        const { [path]: _gone, ...rest } = shared(WORKTREES) ?? {};
        setShared(WORKTREES, rest);
        const name = worktree.workspaceName(path);
        await this.cleanUp(name, path, record).catch((error) => reportError(`Cleanup after ${name} didn't start`, error));
      }
    } finally {
      this.sweeping = false;
    }
  }

  // Runs scripts.archive in a background terminal, from the main checkout.
  async cleanUp(name, path, { root, port, on }) {
    const settings = await readSettings(root, on);
    if (!settings.archive) return;
    const env = {
      ...(await variables(settings, { name, path, root, port, on })),
      WORKTREE_ARCHIVE_SCRIPT: settings.archive,
    };
    const where = on ? ["--on", on] : [];
    const result = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", ...where, "--cwd", root, "--",
      "env", ...worktree.envArguments(env), "bash", "-c", ARCHIVE_RUNNER]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "hc run failed.");
    this.cleanups.set(JSON.parse(result.stdout).address, { name });
  }

  // Follows each setup through its marker file until it succeeds or its pane is closed, and
  // each cleanup until its terminal finishes.
  async poll() {
    this.polling = true;
    try {
      // A copy: a retry deletes its job and launch() adds it back, and a Map visits a key
      // added during the loop again, which would launch it twice.
      for (const [gitDir, job] of [...this.jobs]) {
        const tabPanes = panes().filter((p) => p.tab === job.tab);
        job.pane ??= tabPanes.find((p) => !job.before.has(p.pane))?.pane ?? null;
        // The runner exits after writing "ok" or "retry", and a pane closes itself when its
        // program exits, so the mod never closes one. Read the marker before checking whether
        // the pane is gone: a pane that closed after "ok" wasn't closed by the person.
        const status = worktree.parseMarker(await readTextFile(job.marker, { on: job.on }));
        if (status?.state === "ok") {
          this.jobs.delete(gitDir);
          notify({ title: `${job.name} is set up`, level: "success", timeout: 4000 });
        } else if (status?.state === "retry") {
          this.jobs.delete(gitDir);
          await this.launch(job).catch((error) => reportError("Worktree setup didn't start", error));
        } else if (job.pane && !tabPanes.some((p) => p.pane === job.pane)) {
          this.jobs.delete(gitDir); // the person closed it
        } else if (status?.state === "failed" && job.state !== "failed") {
          job.state = "failed";
          notify({
            title: `Setup failed in ${job.name}`,
            body: `Exit ${status.code}. Its pane is still open: fix the problem, then type exit to run setup again.`,
            level: "error",
            action: { name: "space.select", args: { id: job.space } },
          });
        }
      }

      for (const [address, cleanup] of [...this.cleanups]) {
        const result = await hc(["get", address, "--json"]);
        if (result.code !== 0) {
          this.cleanups.delete(address); // someone removed the terminal
          continue;
        }
        const terminal = JSON.parse(result.stdout);
        if (terminal.state !== "finished") continue;
        this.cleanups.delete(address);
        if (terminal.exit_code === 0) {
          notify({ title: `Cleaned up after ${cleanup.name}`, level: "success", timeout: 4000 });
          await hc(["rm", address]);
        } else {
          notify({
            title: `Cleanup failed after ${cleanup.name}`,
            body: `Exit ${terminal.exit_code}. Click to see its output (or run: hc read ${address}).`,
            level: "error",
            action: { name: "terminal.peek", args: { terminal: address } },
          });
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
