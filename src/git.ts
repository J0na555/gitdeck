import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import type { RepoFacts } from "./types";

/** Directories never worth descending into when hunting for repos. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "target", "venv", ".venv"]);

const execFileAsync = promisify(execFile);

/**
 * Run a git command in `cwd`. Returns trimmed stdout on success, or null when
 * git fails. Many probes are expected to fail on healthy repos (a repo with no
 * commits makes `git log` exit 128), so failure is normal, not exceptional.
 *
 * Async on purpose: a scan of dozens of repos used to run every probe with
 * `spawnSync`, which froze the renderer until the last child exited. `execFile`
 * rejects on a non-zero status, which is exactly the null case here.
 */
export async function gitProbe(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			windowsHide: true,
		});
		return stdout.trim();
	} catch {
		return null;
	}
}

/** True when `dir` is the root of a git repository (dir or worktree file). */
async function isRepo(dir: string): Promise<boolean> {
	try {
		await fs.promises.access(path.join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}

/**
 * Find git repositories under `root`, up to `maxDepth` directory levels below it.
 * Hidden directories are skipped so we never walk into .git internals.
 */
export async function findRepos(root: string, maxDepth = 2): Promise<string[]> {
	const found: string[] = [];

	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const child = path.join(dir, entry.name);
			if (await isRepo(child)) {
				found.push(child);
				// A repo's own subdirectories are its content, not separate projects.
				continue;
			}
			if (depth >= maxDepth) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			await walk(child, depth + 1);
		}
	};

	await walk(root, 0);
	return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Strip common remote forms down to an owner/name slug.
 * Handles `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`,
 * `https://github.com/owner/repo.git`, and bare `owner/repo`.
 */
export function parseGithubSlug(remote: string | null): string | null {
	if (!remote) return null;

	const patterns = [
		/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/,
		/^ssh:\/\/[^@]+@[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
		/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
		/^git:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
	];

	for (const pattern of patterns) {
		const match = remote.match(pattern);
		if (match) return `${match[1]}/${match[2]}`;
	}
	return null;
}

/**
 * Split a remote URL into its host and owner/repo, or null when the shape is one
 * we do not recognise.
 *
 * Kept separate from `parseGithubSlug` on purpose. That function throws the host
 * away, so `git@gitlab.com:me/tool.git` and `git@github.com:me/tool.git` both come
 * back as `me/tool`. Building a browser URL from it would hand a GitLab user a
 * github.com link to whatever repo happened to share the name.
 *
 * Handles scp-style (`git@host:owner/repo.git`), scheme URLs with or without a
 * user and a port, and both `.git` suffixes.
 */
function splitRemote(remote: string): { host: string; owner: string; repo: string } | null {
	const scp = remote.match(/^(?:[^@/]+@)?([^:/]+):([^/]+\/.+)$/);
	if (scp) {
		const path = splitRepoPath(scp[2]);
		return path ? { host: scp[1], ...path } : null;
	}

	const url = remote.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
	if (url) {
		const path = splitRepoPath(url[2]);
		return path ? { host: url[1], ...path } : null;
	}

	return null;
}

/** Split `owner/repo(.git)` and strip the `.git` and any trailing slash. */
function splitRepoPath(value: string): { owner: string; repo: string } | null {
	const path = value.replace(/\/+$/, "").replace(/\.git$/i, "");
	const slash = path.indexOf("/");
	if (slash <= 0 || slash === path.length - 1) return null;
	return { owner: path.slice(0, slash), repo: path.slice(slash + 1) };
}

/**
 * Turn a git remote into a URL that opens in a browser, or null when no honest
 * one can be built.
 *
 * Only github.com qualifies. A GitLab or self-hosted remote comes back null
 * rather than a github.com guess, because a plausible-looking link to the wrong
 * host is worse than no link.
 *
 * `git@github.com:owner/repo.git`  ->  https://github.com/owner/repo
 * `ssh://git@github.com/owner/repo` ->  https://github.com/owner/repo
 * `https://github.com/owner/repo`   ->  https://github.com/owner/repo
 */
export function toWebUrl(remote: string | null): string | null {
	if (!remote) return null;
	const parts = splitRemote(remote);
	if (!parts) return null;
	if (parts.host.toLowerCase() !== "github.com") return null;
	return `https://github.com/${parts.owner}/${parts.repo}`;
}

/**
 * Resolve the branch origin treats as default.
 *
 * `refs/remotes/origin/HEAD` is the correct source but it is unset on roughly a
 * third of the local repos here, so fall back to the well-known names before
 * giving up and reporting an unknown default.
 */
async function resolveDefaultBranch(cwd: string): Promise<string | null> {
	const head = await gitProbe(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (head) return head.replace(/^origin\//, "");

	const refs = await gitProbe(cwd, ["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)"]);
	if (!refs) return null;

	const names = refs
		.split("\n")
		.map((line) => line.replace(/^origin\//, ""))
		.filter((name) => name && name !== "HEAD");

	for (const candidate of ["main", "master", "trunk", "develop"]) {
		if (names.includes(candidate)) return candidate;
	}
	return null;
}

/**
 * Count entries in `git stash list`, or null when the probe failed.
 *
 * Exit 0 with empty output is the healthy answer, so zero and "could not ask" are
 * different results and stay different types here.
 */
async function readStashCount(cwd: string): Promise<number | null> {
	const out = await gitProbe(cwd, ["stash", "list"]);
	if (out === null) return null;
	return out.split("\n").filter((line) => line.length > 0).length;
}

/**
 * Count commits on this branch that its upstream does not have, or null.
 *
 * `@{u}` is git's own reflog shorthand and is passed literally: no shell is
 * involved, so nothing expands it before git sees it. A repo with no upstream
 * makes this fail, which is null and not zero. That is deliberate: a repo that
 * was never pushed is a normal state, and "every commit here is unpushed" would
 * fire on every local-only repo ever written.
 */
async function readUnpushedCount(cwd: string): Promise<number | null> {
	const out = await gitProbe(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
	if (out === null) return null;
	const parsed = Number.parseInt(out.trim(), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Collect git facts for one repository. Assumes `repoPath` is a repo root.
 * Every probe degrades to null rather than throwing, so a single odd repo
 * cannot abort a whole scan.
 */
export async function readRepoFacts(repoPath: string, root: string): Promise<RepoFacts> {
	const name = path.basename(repoPath);

	// Independent probes run together. A scan walks repos one at a time, so this
	// caps the number of live git children at the handful one repo needs.
	const [remote, branchResult, defaultBranch, readable, lastCommit, porcelain] = await Promise.all([
		gitProbe(repoPath, ["remote", "get-url", "origin"]),
		gitProbe(repoPath, ["branch", "--show-current"]),
		resolveDefaultBranch(repoPath),
		// `rev-parse --git-dir` succeeds for a readable repository whether or not it has
		// any commits, so a false here means the failure was not "this value is absent".
		// Every absent probe result below is only trustworthy when this is true.
		gitProbe(repoPath, ["rev-parse", "--git-dir"]),
		// `--format=%cI` is committer date in strict ISO 8601, timezone included.
		gitProbe(repoPath, ["log", "-1", "--format=%cI"]),
		gitProbe(repoPath, ["status", "--porcelain"]),
	]);
	const branch = branchResult || null;
	const gitReadable = readable !== null;
	const dirtyCount = porcelain === null ? 0 : porcelain.split("\n").filter((l) => l.length > 0).length;

	// Both health probes are skipped entirely when git could not read the repo.
	// Running them anyway would cost two spawns to learn nothing, and the null
	// they return is exactly the value that must not overwrite good data.
	const [stashCount, unpushedCount] = gitReadable
		? await Promise.all([readStashCount(repoPath), readUnpushedCount(repoPath)])
		: [null, null];

	let dirMtime = 0;
	try {
		dirMtime = (await fs.promises.stat(repoPath)).mtimeMs;
	} catch {
		dirMtime = 0;
	}

	return {
		path: repoPath,
		name,
		root,
		gitReadable,
		remote,
		github: parseGithubSlug(remote),
		branch,
		defaultBranch,
		// With no known default, treating the branch as default avoids a
		// permanent false +25 on every repo missing an origin/HEAD ref.
		onNonDefaultBranch: branch !== null && defaultBranch !== null && branch !== defaultBranch,
		lastCommit,
		dirtyCount,
		stashCount,
		unpushedCount,
		dirMtime,
	};
}

/**
 * Hand the renderer one macrotask before the first probe starts.
 *
 * `window` is absent under `node --test`, where `setImmediate` is the same
 * "let the current turn finish" primitive. Production never takes that branch.
 */
function yieldToPaint(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof window === "undefined") setImmediate(resolve);
		else window.setTimeout(resolve, 0);
	});
}

/**
 * Scan `root` and read facts for every repository found.
 *
 * Yields one macrotask before touching the filesystem, so the panel can paint
 * the scanning state before the first probe starts. Repos are walked in order
 * to keep the result stable and the number of live children bounded.
 */
export async function scanProjects(root: string, maxDepth = 2): Promise<RepoFacts[]> {
	await yieldToPaint();
	if (!fs.existsSync(root)) return [];

	const repos = await findRepos(root, maxDepth);
	const facts: RepoFacts[] = [];
	for (const repo of repos) facts.push(await readRepoFacts(repo, root));
	return facts;
}

/**
 * Count commits on HEAD since `since`, a `YYYY-MM-DD` date, or 0 when the probe failed.
 *
 * `--since` is git's own date filter and is passed literally: no shell is involved, so nothing
 * expands it before git sees it. HEAD only, which is what "did this project move this week"
 * means for a repo you are working in.
 *
 * Zero and "could not ask" are the same number here, unlike `readStashCount`, because this is
 * read by the weekly writer and a scan that could not count must not invent activity. A repo
 * with no commits, a path that is not a repo, and a missing git all land on 0. This never
 * throws: one odd repo in a scan of 45 must not abort the note.
 */
export async function countCommitsSince(repoPath: string, since: string): Promise<number> {
	const out = await gitProbe(repoPath, ["log", `--since=${since}`, "--format=%H"]);
	if (out === null || out === "") return 0;
	return out.split("\n").filter((line) => line.length > 0).length;
}
