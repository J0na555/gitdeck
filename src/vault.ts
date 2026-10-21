import { App, TFile, TFolder, normalizePath } from "obsidian";
import { spawnSync } from "child_process";
import type { AtomicOptions, AtomicOutcome, AtomicTarget } from "./atomic-write";
import { atomicUpdate } from "./atomic-write";
import { assertSafeTarget, dashboardPath, renderDashboard } from "./dashboard";
import { replaceSection } from "./markers";
import type { NoteCandidate } from "./note-link";
import type { LegacyNoteState, LegacySummaryFrontmatter } from "./machine-state";
import { legacyNoteStateFromFrontmatter } from "./legacy-notes";
import { PluginSettings, Project, ProjectFrontmatter } from "./types";
import { assertSafeWeeklyTarget, isWeeklyNotePath, renderWeeklySection, weeklyFolder, weeklyPath, weeklySectionState } from "./week";

/** Create `folder` and any missing parents. No-op when it already exists. */
export async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// Lost a race with another writer; the folder existing is what matters.
			}
		}
	}
}

/**
 * Every folder in the vault, for the notes-folder dropdown.
 *
 * Walked rather than read off `getAllFolderPaths`, which exists but is not in every Obsidian
 * version this plugin supports, and a settings tab that throws on an older app is worse than a
 * slower list.
 */
export function listVaultFolders(app: App): string[] {
	const root = app.vault.getRoot();
	const found: string[] = [];
	const walk = (folder: TFolder): void => {
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			found.push(child.path);
			walk(child);
		}
	};
	walk(root);
	return found;
}

/**
 * Every note in the vault that could belong to a project, for `resolveProjectNote` to choose from.
 *
 * The whole vault is searched rather than the notes folder, because the notes folder is now the
 * dashboard's home and a project note is wherever the user keeps their notes. A project's own
 * project note is what that folder used to hold, so somebody upgrading has 45 notes in there and
 * will keep adding new ones wherever they write them.
 *
 * The dashboard is excluded. A repository named `Dashboard` would otherwise resolve to the
 * dashboard as its own project note and link to itself, and the plugin's one file is not a
 * document about any one project.
 *
 * The weekly notes are excluded for the same reason: one more document the plugin owns, named
 * after a week rather than a project, and not a note about any one project either. Only the
 * plugin's own week files are skipped, not everything in the folder: `isWeeklyNotePath` explains
 * why the folder alone cannot be the test.
 */
export function readNoteCandidates(app: App, settings: PluginSettings): NoteCandidate[] {
	const dashboard = dashboardPath(settings);
	const candidates: NoteCandidate[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.path === dashboard) continue;
		if (isWeeklyNotePath(settings, file.path)) continue;
		// `tracked` has two forms and only one of them is a boolean. `tracked: true` promotes the
		// note for the project it is named after; `tracked: api-ai` binds it to that project
		// whatever it is called. A string is therefore never read as a flag: `tracked: "yes"` in a
		// note somebody wrote is a claim about a project called "yes".
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
			| { tracked?: unknown }
			| undefined;
		const raw = frontmatter?.tracked;
		const tracks = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
		candidates.push({
			path: file.path,
			basename: file.basename,
			tracked: raw === true,
			tracks: tracks === "true" ? null : tracks,
		});
	}
	return candidates;
}

/**
 * A path-addressed target for `atomicUpdate`.
 *
 * Every method resolves the path again rather than holding the `TFile` from before the read. A
 * delete or rename between the two then looks like "not a regular file" and fails safely,
 * instead of writing through a stale handle or to whatever now sits at the path.
 *
 * `read` uses `vault.read`, not `cachedRead`: the point of the snapshot is to notice a change,
 * and the cache is the thing that would not.
 */
function noteTarget(app: App, path: string): AtomicTarget {
	return {
		read: async () => {
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return null;
			return app.vault.read(file);
		},
		process: async (transform) => {
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new Error(`no file at ${path}`);
			return app.vault.process(file, transform);
		},
		create: async (content) => {
			await app.vault.create(path, content);
		},
	};
}

/**
 * Run a dashboard update through `atomicUpdate`.
 *
 * The guard stays here rather than inside `atomicUpdate` because it is about the dashboard path,
 * not about atomic writes in general. It also runs before the file is touched, so a caller that
 * computed the wrong path fails loudly without writing there first.
 */
export async function updateDashboard(
	app: App,
	settings: PluginSettings,
	transform: (doc: string) => string,
	options: AtomicOptions,
): Promise<AtomicOutcome> {
	const target = dashboardPath(settings);
	assertSafeTarget(settings, target);
	return atomicUpdate(noteTarget(app, target), transform, options);
}

/**
 * Write the dashboard: the project table inside its markers, and nothing else.
 *
 * The marker replacement runs inside `vault.process`, on the fresh contents, so a user edit
 * outside the markers between the read and the write survives. The first transform on the
 * snapshot only decides whether there is anything to do; the callback redoes the work against
 * whatever is actually on disk.
 *
 * The caller must hold `dashboardWrites`: the scan and summary generation both write this file,
 * and serialising only the writes would still let the second writer start from a stale read.
 *
 * A failure here is not worth a notice. The panel already has everything it shows; this file is a
 * view of the same data, and a vault that cannot be written is the user's problem to see in
 * Obsidian's own terms.
 */
export async function syncDashboard(
	app: App,
	settings: PluginSettings,
	projects: Project[],
	now: number = Date.now(),
): Promise<string | null> {
	const target = dashboardPath(settings);
	assertSafeTarget(settings, target);
	await ensureFolder(app, settings.notesFolder);

	// A generated body carrying a marker would break the section structure the next write
	// depends on. `renderDashboard` throws for that, which `atomicUpdate` turns into a failed
	// outcome and no write.
	const outcome = await updateDashboard(
		app,
		settings,
		(doc) => renderDashboard(doc, projects, now),
		{ missing: "create" },
	);
	return outcome.status === "written" || outcome.status === "unchanged" ? target : null;
}

/**
 * Write this week's note: the two tables inside their markers, and nothing else.
 *
 * Modelled on `syncDashboard`, with one difference that matters: the path is a week, so `now`
 * is passed to the guard, the renderer and the path from the same value. A scan that straddles
 * midnight on Sunday must not render one week and validate against another, and re-deriving
 * `now` anywhere below is how that would happen.
 *
 * The marker replacement runs inside `vault.process`, on the fresh contents, so a user edit
 * outside the markers between the read and the write survives. The first transform on the
 * snapshot only decides whether there is anything to do; the callback redoes the work against
 * whatever is actually on disk. A scan that changes nothing still skips the write, for the same
 * reason the dashboard does: this sits in the user's vault and rewriting an identical file every
 * 30 seconds shows up as a change in whatever syncs that vault. Only this week's file is ever
 * touched; earlier weeks stay where they were written.
 *
 * Unlike the dashboard, this never adopts a file that is already at its path. The dashboard's
 * path comes from a setting the user points at the plugin's own file, so an existing file there
 * is expected and appending to it is the feature. This path is generated from the week, so a file
 * already sitting on it was not made by the plugin. Obsidian's core weekly notes use the same
 * filename shape, and appending machine tables into somebody's journal is not a thing to guess
 * at. The guard runs both before the write and again inside the callback, because a file can
 * appear or lose its section while the write is in flight. When the file exists but has no
 * weekly section, the write is skipped and null returned.
 *
 * A refused write or an unreadable vault returns null rather than throwing. The panel already
 * has everything it shows; this file is a view of the same data.
 */
export interface WeeklySyncResult {
	/** The path the writer aimed at, whether or not a write happened. */
	path: string;
	/** The atomic outcome, so the caller can tell a foreign file from a failed write. */
	outcome: AtomicOutcome;
}

export async function syncWeekly(
	app: App,
	settings: PluginSettings,
	projects: readonly Project[],
	commitsThisWeek: ReadonlyMap<string, number>,
	now: number = Date.now(),
): Promise<WeeklySyncResult> {
	const target = weeklyPath(settings, now);
	assertSafeWeeklyTarget(settings, target, now);
	await ensureFolder(app, weeklyFolder(settings));

	// A file already at this path was not made by us. Obsidian's core weekly notes share the
	// `YYYY-Www.md` name, so a file with no weekly section is left alone rather than having
	// machine tables appended into it. The dashboard does the opposite on purpose: see the
	// header comment for why the two paths differ. The guard runs on the pre-read snapshot and
	// again inside the callback, where the file may have changed.
	const outcome = await atomicUpdate(
		noteTarget(app, target),
		(doc) => replaceSection(doc, "weekly", renderWeeklySection(projects, commitsThisWeek, now)),
		{
			missing: "create",
			guard: (doc) => {
				const state = weeklySectionState(doc);
				return state === "ours" ? null : state;
			},
		},
	);
	return { path: target, outcome };
}

/**
 * Every legacy note's managed frontmatter, for the one-time state seed and the key migration.
 *
 * Called once per refresh while either job is still owed, and the same read feeds both: the
 * seed wants pins and dirty counts, and the migration wants `repo_path`, which the notes have
 * carried all along. After the seed, this plugin never reads `pinned` or `dirty` out of a note
 * again: a note is a document the user owns, and state that has to be right cannot live in one.
 * See `applyLegacyNotes` and `migrateStateToPaths`.
 *
 * `pending` is how many markdown children Obsidian has not indexed yet. The seed must not run
 * on a cold cache: every note would look like it had no frontmatter, the seed would find
 * nothing, and it would still write `version = STATE_VERSION`, so the real pins in those notes
 * would never be read. A caller waits for `pending` to reach zero before seeding.
 */
export function readLegacyNotes(
	app: App,
	settings: PluginSettings,
): { notes: LegacyNoteState[]; pending: number } {
	const notes: LegacyNoteState[] = [];
	let pending = 0;
	const folder = app.vault.getAbstractFileByPath(normalizePath(settings.notesFolder));
	if (!(folder instanceof TFolder)) return { notes, pending };

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		// Read as both shapes at once because a note in this folder is one of two things: a
		// generated project note, or a generated summary note. Both were written by this plugin,
		// so either key set appearing without the other is a hand edit rather than a normal case.
		const cache = app.metadataCache.getFileCache(child);
		if (cache === undefined) pending++;
		const fm = cache?.frontmatter as (ProjectFrontmatter & LegacySummaryFrontmatter) | undefined;
		// The helper owns the fallbacks and the trimming, so the seed and the migration cannot
		// disagree about what a note said.
		notes.push(legacyNoteStateFromFrontmatter(child.basename, fm));
	}
	return { notes, pending };
}

/**
 * Short HEAD sha for a repo, used to judge whether a summary has gone stale.
 *
 * Exported because staleness is now a comparison between data.json and the repo, and this is
 * the other half of it. One `rev-parse` per project, exactly as before.
 */
export function headSha(repoPath: string): string | null {
	const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: repoPath,
		encoding: "utf8",
		windowsHide: true,
	});
	if (res.error || res.status !== 0) return null;
	return res.stdout.trim() || null;
}
