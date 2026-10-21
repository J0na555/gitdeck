/**
 * The plugin's own state, as it sits in data.json: pin ranks, the previous scan's dirty
 * counts, and what each AI summary was written from.
 *
 * All three used to live in note frontmatter, and all three moved for one reason. They
 * are written on every scan and never hand-edited by the user, which makes them machine
 * state rather than note content, and they belong somewhere the user cannot delete by
 * rewriting a note. A user who tidied their vault lost their pin order along with it.
 *
 * Every reader here treats the stored value as hostile, because data.json is a file a
 * person can edit: `sanitizeMachineState` drops anything that is not the right shape
 * rather than letting it reach the panel. The model is the same one `sanitizeWeights`
 * uses for the score weights, and for the same reason: half a ranking reading NaN is worse
 * than ignoring the edit.
 *
 * No `obsidian` import, deliberately: `node --test` cannot load that package, so a module
 * that imports it is a module with no tests. Same rule as `pin-queue.ts`.
 */
import { isProjectKey, projectKey } from "./identity.ts";
import { detectStale } from "./summary.ts";
import type {
	MachineState,
	PluginSettings,
	Project,
	RepoFacts,
	SummaryRecord,
	SummaryState,
} from "./types.ts";

/**
 * Layout version of the persisted state.
 *
 * Bumping this re-runs the legacy seed, which only ever fills in what is missing, so a
 * future change to the shape costs a rescan and nothing else. It is a guard on the shape,
 * not a migration ledger: there is no per-version step to keep in step with it.
 */
export const STATE_VERSION = 1;

/**
 * The largest pin rank and dirty count accepted from disk.
 *
 * Ranks are the user's own integers and the menu grows them by one, so there is no natural
 * ceiling; this one exists only so a hand-edited `1e308` cannot be stored and read back as
 * a number no comparison behaves sensibly on. It is far above anything real.
 */
export const MAX_PIN_RANK = 1_000_000;
export const MAX_DIRTY_COUNT = 1_000_000;

/** Keys that must never be written into a record read from `data.json`. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Machine state for a plugin that has stored nothing yet. */
export function emptyMachineState(): MachineState {
	return { version: 0, pins: {}, previousDirty: {}, summaries: {}, legacySummariesImported: false };
}

/**
 * Turn whatever was in `data.json` into usable state.
 *
 * Always returns fresh objects, never `emptyMachineState()` itself, so a caller cannot
 * reach back into the defaults through its own settings the way a shared nested object
 * allows. Version is preserved from the file rather than forced forward: a load must not
 * quietly mark an unseeded upgrade as done.
 */
export function sanitizeMachineState(loaded: unknown): MachineState {
	const source = isRecord(loaded) ? loaded : {};
	return {
		version: typeof source.version === "number" && Number.isFinite(source.version) ? Math.floor(source.version) : 0,
		pins: numberRecord(source.pins, isPinRank),
		previousDirty: numberRecord(source.previousDirty, isDirtyCount),
		summaries: summaryRecords(source.summaries),
		// Absent means not yet done. Defaulting to true would skip the import for every install
		// that upgraded through a version whose data.json predates this key.
		legacySummariesImported: source.legacySummariesImported === true,
	};
}

/**
 * True when the persisted state predates this layout and still needs seeding from the
 * notes it used to be written to.
 *
 * Seeded once and then never again, which is the whole requirement: a seed that ran on
 * every load would quietly overwrite live state with whatever the notes still say, and a
 * user who has since pinned something would watch it unpin itself at startup.
 */
export function needsLegacySeed(state: MachineState): boolean {
	return state.version < STATE_VERSION;
}

/**
 * True when the v0.1 summary notes still need copying into the dashboard.
 *
 * Not the same guard as the seed, and deliberately so. The seed only fills gaps, so running it
 * twice costs nothing. Importing is not repeatable: it overwrites whatever is in the summaries
 * section, so running it after the user regenerated a summary would replace their newer text
 * with a model reply from months ago. Hence its own flag.
 */
export function needsLegacyImport(state: MachineState): boolean {
	return !state.legacySummariesImported;
}

/**
 * True when a state map still holds at least one legacy basename key.
 *
 * The migration needs no version bump and no new "migrated" flag: an absolute path is the
 * new shape, and a basename is the old one. If every key is an absolute path there is
 * nothing left to move, so writing another boolean into data.json would only be a second
 * place for the answer to be wrong.
 */
export function hasLegacyNameKeys(state: MachineState): boolean {
	return (
		Object.keys(state.pins).some((key) => !isProjectKey(key)) ||
		Object.keys(state.previousDirty).some((key) => !isProjectKey(key)) ||
		Object.keys(state.summaries).some((key) => !isProjectKey(key))
	);
}

/** What one pass of the name-to-path migration did, and what it could not decide. */
export interface MigrationResult {
	state: MachineState;
	/** Legacy names that were moved to their one evidence path. */
	migrated: string[];
	/** Names with more than one path, or a path with more than one owner. Left alone. */
	ambiguous: string[];
	/** Names with no note recording a path. Left alone. */
	unmapped: string[];
	/** True when any key was added or deleted. */
	changed: boolean;
}

/**
 * Move the old basename-keyed records onto project keys, using the notes as evidence.
 *
 * The only honest source for "which repo was this basename" is a legacy project note, which
 * recorded `project` and `repo_path` together. The scan cannot answer it: three different
 * `api` repos under the scan root are exactly the ambiguity this change exists to fix, and
 * picking one of them would be a guess that silently moved somebody's pin to the wrong repo.
 * So a name with no note, or with more than one note pointing at different paths, is left in
 * place and reported. It is inert, and a person can decide what it meant.
 *
 * Relative paths are ignored rather than resolved against the process cwd. A note saying
 * `repo_path: projects/api` does not say where the vault or the scan root was when it was
 * written, and resolving it against wherever Obsidian happened to start would invent a path.
 *
 * Idempotent: a second pass sees only absolute keys and changes nothing. Path keys win over a
 * name key that maps to them, because the path key could only have come from a newer write.
 */
export function migrateStateToPaths(state: MachineState, notes: readonly LegacyNoteState[]): MigrationResult {
	const byName = new Map<string, Set<string>>();
	for (const note of notes) {
		const repoPath = note.repoPath?.trim() ?? "";
		if (note.project === "" || repoPath === "" || !isProjectKey(repoPath)) continue;
		const key = projectKey(repoPath);
		const paths = byName.get(note.project) ?? new Set<string>();
		paths.add(key);
		byName.set(note.project, paths);
	}

	// The inverse, so a path claimed by two different names is caught before either is moved.
	const byPath = new Map<string, Set<string>>();
	for (const [name, keys] of byName) {
		for (const key of keys) {
			const owners = byPath.get(key) ?? new Set<string>();
			owners.add(name);
			byPath.set(key, owners);
		}
	}

	const migrated = new Set<string>();
	const ambiguous = new Set<string>();
	const unmapped = new Set<string>();
	let changed = false;

	const move = <T>(records: Readonly<Record<string, T>>): Record<string, T> => {
		const out: Record<string, T> = { ...records };
		for (const name of Object.keys(records)) {
			if (isProjectKey(name)) continue;

			const paths = byName.get(name);
			if (!paths || paths.size === 0) {
				unmapped.add(name);
				continue;
			}
			if (paths.size > 1) {
				ambiguous.add(name);
				continue;
			}

			const [key] = [...paths];
			const owners = byPath.get(key);
			if (owners && owners.size > 1) {
				ambiguous.add(name);
				continue;
			}

			// A path key that already exists is the winner. Copying over it would let old note
			// state undo a write that was made after the notes were last read.
			if (!(key in out)) out[key] = records[name];
			delete out[name];
			migrated.add(name);
			changed = true;
		}
		return out;
	};

	const pins = move(state.pins);
	const previousDirty = move(state.previousDirty);
	const summaries = move(state.summaries);

	return {
		state: {
			version: state.version,
			pins,
			previousDirty,
			summaries,
			legacySummariesImported: state.legacySummariesImported,
		},
		// Sets, then sorted, so the three maps reporting the same name do not produce three
		// notices' worth of duplicates and the order is stable between runs.
		migrated: [...migrated].sort(),
		ambiguous: [...ambiguous].sort(),
		unmapped: [...unmapped].sort(),
		changed,
	};
}

/** A project's pin rank. 0 means unpinned, which is also what an absent project key means. */
export function pinRankFor(pins: Readonly<Record<string, number>>, key: string): number {
	return pins[key] ?? 0;
}

/**
 * A project's uncommitted file count at the previous scan, or null when there is no
 * history.
 *
 * Null is not zero. The sustained-dirty warning compares the last scan against this one,
 * and a repo with no recorded history has not been clean before: it has never been looked
 * at, which is not evidence of anything.
 */
export function previousDirtyFor(counts: Readonly<Record<string, number>>, key: string): number | null {
	return counts[key] ?? null;
}

/** What a summary was generated from, rebuilt into the state the panel renders. */
export function stateFromRecord(
	record: SummaryRecord,
	facts: RepoFacts,
	currentHead: string | null,
): SummaryState {
	// `detectStale` reads the commit and the dirty count and nothing else, so a record and a
	// frontmatter stamp are the same question asked at different times. Passing only the two
	// fields it uses keeps one comparison behind both.
	const { stale, reason } = detectStale({ commit: record.commit, dirtyCount: record.dirtyCount }, facts, currentHead);
	return {
		generatedAt: record.generatedAt,
		commit: record.commit,
		dirty: record.dirtyCount > 0,
		dirtyCount: record.dirtyCount,
		stale,
		staleReason: reason,
	};
}

/**
 * Rebuild every project's summary state from machine state, comparing each against the repo
 * as it is now.
 *
 * Reads data.json, not notes. Freshness used to be the summary note's frontmatter, which put
 * the answer to "is this out of date" in a file whose whole purpose was to hold the thing
 * being judged. A project with no record is absent from the map, and the panel shows that as
 * "none", which is the normal case: summaries are made on request.
 *
 * Keyed by `projectKey(facts.path)` rather than the display name, so two repos named `api`
 * each get their own record. The lookup and the returned map use the same key on purpose:
 * a caller that iterated the map and looked projects up by name would reintroduce the
 * collision one layer above the state it just fixed.
 *
 * `head` is injected rather than called here so this stays a lookup and a comparison. The git
 * call behind it is one `rev-parse` per project, the same one the old reader made.
 */
export function readSummaryStates(
	settings: PluginSettings,
	projects: Project[],
	head: (facts: RepoFacts) => string | null,
): Map<string, SummaryState> {
	const states = new Map<string, SummaryState>();
	const records = settings.state.summaries;

	for (const project of projects) {
		const key = projectKey(project.facts.path);
		const record = records[key];
		if (!record) continue;
		states.set(key, stateFromRecord(record, project.facts, head(project.facts)));
	}

	return states;
}

/**
 * The frontmatter a v0.1 summary note wrote, read once to seed state.
 *
 * Only ever consulted by the upgrade path. After that this plugin never reads its own
 * freshness out of a note again: a note is a document, and a document the user can edit is
 * not a place to keep state that has to be right.
 */
export interface LegacySummaryFrontmatter {
	ai_generated?: boolean;
	generated_at?: string;
	commit?: string | null;
	dirty_count?: number;
}

/**
 * One legacy note's contribution to the seed, in whatever shape it came out of the vault.
 *
 * Structural, and every field `unknown`, because the caller reads it off the metadata cache
 * and that object is whatever the user's YAML parsed to. The validation is here, where it
 * can be tested, rather than in the vault walk that cannot be.
 */
export interface LegacyNoteState {
	/** The project the note belonged to, or the filename when it had no `project` key. */
	project: string;
	/**
	 * The exact repo path the old note recorded, used only to attribute name-keyed data
	 * during migration. Trimmed, or absent when the note did not say.
	 */
	repoPath?: string;
	/** `pinned` from the note, unvalidated. */
	pinned?: unknown;
	/** `dirty` from the note, unvalidated. */
	dirty?: unknown;
	/** Frontmatter of a generated summary note, or null for anything the user wrote. */
	summary?: LegacySummaryFrontmatter | null;
}

/**
 * Fill in machine state from the notes it used to live in.
 *
 * Only ever fills a name that has no value yet. That is what makes running the seed twice
 * harmless rather than a reset: a pin the user has made since is not a name the seed can
 * fill, and a rank already in `pins` is a decision somebody made after the notes were
 * written.
 *
 * An unseeded upgrade has real data here, 45 notes' worth of pin ranks and dirty counts,
 * and this is the only function that can ever read it. Skipping it would reset every pin
 * in every install, silently and on first load, which is the worst outcome available to
 * this change.
 */
export function applyLegacyNotes(state: MachineState, notes: readonly LegacyNoteState[]): MachineState {
	const pins = { ...state.pins };
	const previousDirty = { ...state.previousDirty };
	const summaries = { ...state.summaries };

	for (const note of notes) {
		const name = note.project;
		if (name === "") continue;

		const pin = toFiniteNumber(note.pinned);
		if (!(name in pins) && isPinRank(pin)) pins[name] = pin;

		const dirty = toFiniteNumber(note.dirty);
		if (!(name in previousDirty) && isDirtyCount(dirty)) previousDirty[name] = dirty;

		if (!(name in summaries)) {
			const record = stampFromLegacySummary(note.summary);
			if (record) summaries[name] = record;
		}
	}

	return { version: state.version, pins, previousDirty, summaries, legacySummariesImported: state.legacySummariesImported };
}

/**
 * A legacy summary note's frontmatter as a record, or null when the note is not one.
 *
 * `ai_generated` is the marker the note carries rather than the `-ai` filename: it is what
 * the old writer set on purpose, and a filename test would read a user's own `notes-ai.md`
 * as ours.
 */
export function stampFromLegacySummary(fm: LegacySummaryFrontmatter | null | undefined): SummaryRecord | null {
	if (!fm || fm.ai_generated !== true) return null;
	const generatedAt = typeof fm.generated_at === "string" && isPlausibleDate(fm.generated_at) ? fm.generated_at : null;
	const commit = typeof fm.commit === "string" && fm.commit.length > 0 ? fm.commit : null;
	const dirtyCount = toFiniteNumber(fm.dirty_count);
	return {
		generatedAt,
		commit,
		dirtyCount: isDirtyCount(dirtyCount) ? dirtyCount : 0,
	};
}

/** True when a string is something `new Date` can actually read. */
function isPlausibleDate(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

/**
 * A stored number, or null for anything that is not one.
 *
 * `typeof x === "number" && Number.isFinite(x)` rather than `Number(x)`: `Number(null)`,
 * `Number("")` and `Number(false)` are all 0, and a hand-edited `null` in a data.json would
 * otherwise become a real pin of 0 or a real history of "was clean".
 */
function toFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A rank is a positive whole number: 0 is how every other comparison spells unpinned. */
function isPinRank(value: number | null): value is number {
	return value !== null && Number.isInteger(value) && value > 0 && value <= MAX_PIN_RANK;
}

/** A dirty count is a non-negative whole number no larger than the sanity ceiling. */
function isDirtyCount(value: number | null): value is number {
	return value !== null && Number.isInteger(value) && value >= 0 && value <= MAX_DIRTY_COUNT;
}

/** True for a plain object, and false for null, an array and anything primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A record of project name to number, keeping only the entries `accept` allows.
 *
 * The unsafe-key check is not paranoia about a hostile attacker, it is about `__proto__`:
 * `Object.assign` and a plain assignment both reach the prototype rather than the object,
 * so a project literally named `__proto__` in the JSON would otherwise have changed the
 * shape of every lookup that followed.
 */
function numberRecord(loaded: unknown, accept: (value: number | null) => value is number): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isRecord(loaded)) return out;
	for (const [name, raw] of Object.entries(loaded)) {
		if (name === "" || UNSAFE_KEYS.has(name)) continue;
		const value = toFiniteNumber(raw);
		if (accept(value)) out[name] = value;
	}
	return out;
}

/**
 * A record of summary records, validated field by field.
 *
 * A record with one bad field keeps its good fields and loses only that one, because a
 * summary whose commit is unreadable is still a summary that was generated, and throwing the
 * whole entry away would make the panel claim it has none.
 */
function summaryRecords(loaded: unknown): Record<string, SummaryRecord> {
	const out: Record<string, SummaryRecord> = {};
	if (!isRecord(loaded)) return out;
	for (const [name, raw] of Object.entries(loaded)) {
		if (name === "" || UNSAFE_KEYS.has(name) || !isRecord(raw)) continue;
		const generatedAt = typeof raw.generatedAt === "string" && isPlausibleDate(raw.generatedAt) ? raw.generatedAt : null;
		const dirtyCount = toFiniteNumber(raw.dirtyCount);
		out[name] = {
			generatedAt,
			commit: typeof raw.commit === "string" && raw.commit.length > 0 ? raw.commit : null,
			dirtyCount: isDirtyCount(dirtyCount) ? dirtyCount : 0,
		};
	}
	return out;
}
