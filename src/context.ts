/**
 * Git-only context for the model, and the prompt built from it.
 *
 * v0.1 sends git facts and nothing else. The user's other vault notes are never
 * read, never searched, and never sent anywhere. That is a deliberate limit
 * rather than a missing feature: a summary is only as trustworthy as the context
 * behind it, and a version that quietly starts reading the whole vault is a
 * different product with a different privacy story.
 *
 * Explicit `.ts` extensions and no `obsidian` import, so `node --test` loads it
 * directly.
 */
import { spawnSync } from "child_process";
import type { RepoFacts } from "./types.ts";

/** Bounds on what the plugin will read out of a repo for one prompt. */
export const COMMIT_COUNT_MIN = 1;
export const COMMIT_COUNT_MAX = 200;
export const COMMIT_COUNT_DEFAULT = 20;

/** One commit as the model sees it: a short sha and its subject, nothing else. */
export interface CommitLine {
	sha: string;
	subject: string;
}

/**
 * Everything the model is told about a project.
 *
 * `dirtyFiles` is a list of paths, never contents. Knowing that `src/main.ts` is
 * modified is what makes a summary useful; knowing what is inside it is the
 * user's business, and reading it would be sending the vault's contents to a
 * model provider.
 */
export interface GitContext {
	projectName: string;
	repoPath: string;
	branch: string | null;
	defaultBranch: string | null;
	onDefaultBranch: boolean;
	lastCommitDate: string | null;
	dirtyCount: number;
	dirtyFiles: string[];
	commits: CommitLine[];
	/** Short sha of HEAD, the anchor for the freshness stamp. */
	head: string | null;
	remote: string | null;
}

/** Run git and return raw stdout, or null when it fails. */
function gitRaw(cwd: string, args: string[]): string | null {
	const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
	if (res.error || res.status !== 0) return null;
	return res.stdout;
}

/** Run git and return trimmed stdout, or null when it fails. */
function git(cwd: string, args: string[]): string | null {
	const out = gitRaw(cwd, args);
	return out === null ? null : out.trim();
}

/** Clamp a user-entered commit count into a range that cannot blow up a prompt. */
export function clampCommitCount(value: number): number {
	if (!Number.isFinite(value)) return COMMIT_COUNT_DEFAULT;
	return Math.min(COMMIT_COUNT_MAX, Math.max(COMMIT_COUNT_MIN, Math.floor(value)));
}

/** Clamp a timeout in seconds, in both directions. */
export function clampTimeoutSeconds(value: number): number {
	if (!Number.isFinite(value)) return 120;
	return Math.min(1800, Math.max(5, Math.floor(value)));
}

/**
 * Read the git facts a summary prompt is built from.
 *
 * Everything degrades to an empty value rather than throwing, matching
 * `readRepoFacts`: one odd repository should produce a thin prompt, not a stack
 * trace in the middle of the panel.
 */
export function buildGitContext(facts: RepoFacts, commitCount: number): GitContext {
	const count = clampCommitCount(commitCount);
	const repo = facts.path;

	const rawLog = git(repo, ["log", `-n${count}`, "--format=%h%x09%s"]);
	const commits: CommitLine[] = rawLog
		? rawLog
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => {
					const tab = line.indexOf("\t");
					// A commit subject containing a tab would misparse, so fall back to
					// splitting on the first space and keep the whole remainder.
					return tab === -1
						? { sha: line.split(" ")[0], subject: line }
						: { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
				})
		: [];

	// Raw stdout: trimming would strip the leading status space from the first
	// entry (` M path`), shifting every path by one character.
	const porcelain = gitRaw(repo, ["status", "--porcelain", "-z"]);
	const dirtyFiles = porcelain ? parsePorcelainZ(porcelain) : [];

	const head = git(repo, ["rev-parse", "--short", "HEAD"]);

	return {
		projectName: facts.name,
		repoPath: repo,
		branch: facts.branch,
		defaultBranch: facts.defaultBranch,
		onDefaultBranch: facts.branch !== null && facts.branch === facts.defaultBranch,
		lastCommitDate: facts.lastCommit,
		dirtyCount: facts.dirtyCount,
		dirtyFiles,
		commits,
		head,
		remote: facts.remote,
	};
}

/**
 * Extract the paths from `git status --porcelain -z`.
 *
 * With `-z`, entries are NUL-separated and paths are raw: no quoting, no
 * escaping, and a path may contain spaces, tabs, or newlines. A rename or copy
 * emits an extra NUL-separated field holding the original path immediately after
 * the entry that names the new one, so that field has to be consumed rather than
 * parsed as an entry of its own.
 *
 * A field is `XY`, a space, then at least one path character, so anything
 * shorter cannot hold a path. Empty fields (including the one after a trailing
 * NUL) are ignored.
 */
export function parsePorcelainZ(output: string): string[] {
	const fields = output.split("\0");
	const paths: string[] = [];

	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		if (entry.length < 4) continue;

		paths.push(entry.slice(3));

		// The next field is the original path for a rename or copy. Consume it
		// so it is not mistaken for a status entry.
		if (entry[0] === "R" || entry[0] === "C") i++;
	}

	return paths;
}

/**
 * Render the context as the prompt body.
 *
 * Fixed layout with explicit section names, and a short instruction block that
 * asks for one JSON object and nothing else. The reply is parsed and validated
 * before anything is written, so a model that ignores the instruction produces a
 * reported error rather than a note full of prose.
 */
export function buildPrompt(context: GitContext): string {
	const lines: string[] = [];

	lines.push(`Summarise the software project "${context.projectName}" from the git facts below.`);
	lines.push("");
	lines.push("These facts are the only context you have. You cannot read the repository, its files, or");
	lines.push("any notes, so do not describe code you have not been told about. Say what the commit history");
	lines.push("and the working tree state suggest about where this project stands and what is in flight.");
	lines.push("");

	lines.push("## Repository");
	lines.push(`- Project name: ${context.projectName}`);
	lines.push(`- Local path: ${context.repoPath}`);
	lines.push(`- Remote: ${context.remote ?? "none configured"}`);
	lines.push(`- Current branch: ${context.branch ?? "detached or unknown"}`);
	lines.push(
		`- Default branch: ${context.defaultBranch ?? "unknown"}${context.onDefaultBranch ? " (you are on it)" : ""}`,
	);
	lines.push(`- Last commit date: ${context.lastCommitDate ?? "no commits yet"}`);
	lines.push(`- Uncommitted files: ${context.dirtyCount}`);

	lines.push("");
	lines.push(`## Uncommitted file paths (${context.dirtyFiles.length})`);
	if (context.dirtyFiles.length === 0) {
		lines.push("The working tree is clean.");
	} else {
		// Paths only. This is the whole reason v0.1 can be described as git-only.
		for (const file of context.dirtyFiles) lines.push(`- ${file}`);
	}

	lines.push("");
	lines.push(`## Recent commits (${context.commits.length})`);
	if (context.commits.length === 0) {
		lines.push("No commits.");
	} else {
		for (const commit of context.commits) lines.push(`- ${commit.sha} ${commit.subject}`);
	}

	lines.push("");
	lines.push("## Reply format");
	lines.push("Reply with one JSON object and nothing else. No prose, no code fences.");
	lines.push('{"summary": "two or three sentences on the state of this project", "next_steps": ["short imperative step"]}');
	lines.push('"next_steps" is optional and may be an empty array. Every value must be a string.');

	return lines.join("\n");
}
