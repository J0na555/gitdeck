/**
 * What a repository is called when the plugin has to remember something about it.
 *
 * The display name is the directory basename, and it is not an identity. Two repos can be named
 * `api` under different parents, and every persisted field that was keyed by the basename made
 * them one project: pinning one moved both, and generating a summary for one could overwrite the
 * other. The identity here is the absolute path, which is the only thing about a local repository
 * that is both stable across scans and distinct between two directories.
 *
 * No `obsidian` import, for the same reason `machine-state.ts` has none: `node --test` cannot
 * load that package, and this module's tests are the only check that a persisted key stays
 * readable across versions.
 */
import * as path from "path";

/**
 * The persisted identity of a repository, and the key every in-memory map uses.
 *
 * `path.resolve` before anything else, so `.`, `..` and a trailing slash all name the same
 * repository. `scanProjects` already reports absolute paths, but data.json is a file a person
 * can edit and a relative path written by hand must not become a second key for a repo that is
 * already stored under its absolute path.
 *
 * Lowercased only on Windows, where the filesystem is case-insensitive. Lowercasing on Linux
 * would merge two repos that really are `/repos/api` and `/repos/API`, which is a worse failure
 * than the one it prevents.
 */
export function projectKey(repoPath: string): string {
	const resolved = path.resolve(repoPath.trim());
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * A short, stable marker for a project key, for the dashboard callout.
 *
 * The dashboard needs to know which repo a summary block belongs to without putting an absolute
 * path in an HTML comment: a path can contain `--` or `>`, either of which ends the comment or
 * the line and breaks the document. Sixteen hex characters are a digest, not a secret, and two
 * FNV-1a lanes are enough to make a collision between the projects in one vault practically
 * impossible while keeping this dependency-free and deterministic across runs.
 *
 * `Math.imul` rather than `*` because a 32-bit product in JavaScript is a float above 2^53 and
 * loses the low bits that make the hash deterministic. The `>>> 0` after every multiply keeps
 * each lane an unsigned 32-bit integer, and `padStart` is what makes the result always 16
 * characters rather than sometimes 15.
 */
export function repoMarkerKey(key: string): string {
	// Two offset bases, so the lanes do not move together. The FNV prime is the same for both:
	// these are two FNV-1a passes with different starting states, which is enough entropy for a
	// marker whose only job is to tell a handful of local projects apart.
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < key.length; index++) {
		const code = key.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code, 0x01000193) >>> 0;
	}
	return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

/**
 * True when a stored key is an absolute path rather than a legacy basename.
 *
 * This is how the migration tells the two layouts apart without a version bump or a new flag:
 * a basename is never absolute, and a project key always is. The check is deliberately about
 * shape only. A stale absolute key for a repo that moved is still a key, and the migration has
 * no business deleting it.
 */
export function isProjectKey(value: string): boolean {
	return path.isAbsolute(value);
}

/** The parts of a project the panel needs to tell two same-named repos apart. */
export interface NamedProjectPath {
	name: string;
	path: string;
	root: string;
}

/**
 * A parent-folder label for every project whose display name is shared by another visible row.
 *
 * Two repos called `api` are two rows with the same words in them, and the panel keys pins and
 * summaries by path, so the rows are genuinely different. Showing only the basename makes them
 * look identical and sends the user to the wrong one. The qualifier is the parent path relative
 * to the scan root, which is the shortest label that tells those two apart in the common case.
 *
 * A project with a unique name gets no entry, so the ordinary panel looks unchanged.
 */
export function duplicateNameQualifiers(
	projects: readonly NamedProjectPath[],
): Map<string, string> {
	const counts = new Map<string, number>();
	for (const project of projects) {
		counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
	}

	const qualifiers = new Map<string, string>();
	for (const project of projects) {
		if ((counts.get(project.name) ?? 0) < 2) continue;
		qualifiers.set(projectKey(project.path), parentLabel(project));
	}
	return qualifiers;
}

/** The parent folder, relative to the scan root when it is underneath it. */
function parentLabel(project: NamedProjectPath): string {
	const parent = path.dirname(path.resolve(project.path));
	const root = path.resolve(project.root);
	const relative = path.relative(root, parent);
	const usable = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
	return (usable ? relative : path.basename(parent)).split(path.sep).join("/");
}
