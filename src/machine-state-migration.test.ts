import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectKey } from "./identity.ts";
import {
	STATE_VERSION,
	hasLegacyNameKeys,
	migrateStateToPaths,
	readSummaryStates,
} from "./machine-state.ts";
import type { LegacyNoteState } from "./machine-state.ts";
import type { MachineState, PluginSettings, Project, RepoFacts, SummaryRecord } from "./types.ts";

const PATH = "/repos/one/api";
const OTHER_PATH = "/repos/two/api";
const KEY = projectKey(PATH);
const OTHER_KEY = projectKey(OTHER_PATH);

function state(overrides: Partial<MachineState> = {}): MachineState {
	return {
		version: STATE_VERSION,
		pins: {},
		previousDirty: {},
		summaries: {},
		legacySummariesImported: true,
		...overrides,
	};
}

function record(commit: string, dirtyCount = 0): SummaryRecord {
	return { generatedAt: "2026-10-01T00:00:00.000Z", commit, dirtyCount };
}

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		path: PATH,
		name: "api",
		root: "/repos",
		gitReadable: true,
		remote: null,
		github: null,
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: "2026-09-30T00:00:00.000Z",
		dirtyCount: 0,
		stashCount: 0,
		unpushedCount: 0,
		dirMtime: 0,
		...overrides,
	};
}

function project(path: string): Project {
	return {
		facts: facts({ path, name: "api" }),
		score: { score: 0, status: "active", parts: [] },
		pin: 0,
		health: [],
	};
}

describe("hasLegacyNameKeys", () => {
	it("is true while a basename key remains in any of the three maps", () => {
		assert.equal(hasLegacyNameKeys(state({ pins: { api: 1 } })), true);
		assert.equal(hasLegacyNameKeys(state({ previousDirty: { api: 0 } })), true);
		assert.equal(hasLegacyNameKeys(state({ summaries: { api: record("abc1234") } })), true);
	});

	it("is false once every key is an absolute path", () => {
		assert.equal(
			hasLegacyNameKeys(
				state({
					pins: { [KEY]: 1 },
					previousDirty: { [OTHER_KEY]: 0 },
					summaries: { [KEY]: record("abc1234") },
				}),
			),
			false,
		);
	});
});

describe("migrateStateToPaths", () => {
	it("moves uniquely evidenced pins, dirty history and summaries onto the path key", () => {
		const notes: LegacyNoteState[] = [{ project: "api", repoPath: PATH }];
		const result = migrateStateToPaths(
			state({
				pins: { api: 2 },
				previousDirty: { api: 3 },
				summaries: { api: record("abc1234", 3) },
			}),
			notes,
		);

		assert.deepEqual(result.state.pins, { [KEY]: 2 });
		assert.deepEqual(result.state.previousDirty, { [KEY]: 3 });
		assert.deepEqual(result.state.summaries, { [KEY]: record("abc1234", 3) });
		assert.deepEqual(result.migrated, ["api"]);
		assert.deepEqual(result.ambiguous, []);
		assert.deepEqual(result.unmapped, []);
		assert.equal(result.changed, true);
	});

	it("lets an existing path key win and deletes the name key", () => {
		const result = migrateStateToPaths(
			state({
				pins: { api: 1, [KEY]: 5 },
				previousDirty: { api: 1, [KEY]: 7 },
				summaries: { api: record("old"), [KEY]: record("new") },
			}),
			[{ project: "api", repoPath: PATH }],
		);

		assert.deepEqual(result.state.pins, { [KEY]: 5 });
		assert.deepEqual(result.state.previousDirty, { [KEY]: 7 });
		assert.equal(result.state.summaries[KEY].commit, "new");
		assert.equal("api" in result.state.pins, false);
		assert.equal("api" in result.state.previousDirty, false);
		assert.equal("api" in result.state.summaries, false);
	});

	it("leaves a name alone when the notes point at two different paths", () => {
		const result = migrateStateToPaths(state({ pins: { api: 1 }, previousDirty: { api: 2 } }), [
			{ project: "api", repoPath: PATH },
			{ project: "api", repoPath: OTHER_PATH },
		]);

		assert.deepEqual(result.state.pins, { api: 1 });
		assert.deepEqual(result.state.previousDirty, { api: 2 });
		assert.deepEqual(result.migrated, []);
		assert.deepEqual(result.ambiguous, ["api"]);
		assert.equal(result.changed, false);
	});

	it("leaves both names alone when two names claim one path", () => {
		const result = migrateStateToPaths(state({ pins: { api: 1, other: 2 } }), [
			{ project: "api", repoPath: PATH },
			{ project: "other", repoPath: PATH },
		]);

		assert.deepEqual(result.state.pins, { api: 1, other: 2 });
		assert.deepEqual(result.migrated, []);
		assert.deepEqual(result.ambiguous, ["api", "other"]);
		assert.equal(result.changed, false);
	});

	it("leaves a name with no note at all and reports it", () => {
		const result = migrateStateToPaths(state({ pins: { api: 1 } }), []);

		assert.deepEqual(result.state.pins, { api: 1 });
		assert.deepEqual(result.migrated, []);
		assert.deepEqual(result.unmapped, ["api"]);
		assert.equal(result.changed, false);
	});

	it("ignores a relative repo_path rather than resolving it against the process cwd", () => {
		const result = migrateStateToPaths(state({ pins: { api: 1 } }), [
			{ project: "api", repoPath: "projects/api" },
		]);

		assert.deepEqual(result.state.pins, { api: 1 });
		assert.deepEqual(result.unmapped, ["api"]);
		assert.equal(result.changed, false);
	});

	it("is idempotent on a second pass", () => {
		const notes: LegacyNoteState[] = [{ project: "api", repoPath: PATH }];
		const once = migrateStateToPaths(
			state({ pins: { api: 1 }, previousDirty: { api: 0 }, summaries: { api: record("abc1234") } }),
			notes,
		);
		const twice = migrateStateToPaths(once.state, notes);

		assert.deepEqual(twice.state, once.state);
		assert.equal(twice.changed, false);
		assert.deepEqual(twice.migrated, []);
	});

	it("preserves the version and the legacy import flag", () => {
		const result = migrateStateToPaths(
			state({ version: 1, legacySummariesImported: false, pins: { api: 1 } }),
			[{ project: "api", repoPath: PATH }],
		);

		assert.equal(result.state.version, 1);
		assert.equal(result.state.legacySummariesImported, false);
	});

	it("migrates a name that appears in all three maps", () => {
		const result = migrateStateToPaths(
			state({
				pins: { api: 4 },
				previousDirty: { api: 2 },
				summaries: { api: record("abc1234") },
			}),
			[{ project: "api", repoPath: PATH }],
		);

		assert.deepEqual(result.state.pins, { [KEY]: 4 });
		assert.deepEqual(result.state.previousDirty, { [KEY]: 2 });
		assert.deepEqual(Object.keys(result.state.summaries), [KEY]);
		assert.deepEqual(result.migrated, ["api"]);
	});
});

describe("readSummaryStates", () => {
	function settingsWith(summaries: Record<string, SummaryRecord>): PluginSettings {
		return { state: state({ summaries }) } as PluginSettings;
	}

	it("keys two same-named repos by path and keeps their records apart", async () => {
		const settings = settingsWith({ [KEY]: record("one"), [OTHER_KEY]: record("two") });
		const states = await readSummaryStates(settings, [project(PATH), project(OTHER_PATH)], async () => null);

		assert.equal(states.size, 2);
		assert.equal(states.get(KEY)?.commit, "one");
		assert.equal(states.get(OTHER_KEY)?.commit, "two");
	});

	it("does not attach one repo's record to the other repo with the same name", async () => {
		const settings = settingsWith({ [KEY]: record("one") });
		const states = await readSummaryStates(settings, [project(PATH), project(OTHER_PATH)], async () => null);

		assert.equal(states.size, 1);
		assert.equal(states.has(KEY), true);
		assert.equal(states.has(OTHER_KEY), false);
	});

	it("hands each project's own facts to the head lookup", async () => {
		const settings = settingsWith({ [KEY]: record("abc1234"), [OTHER_KEY]: record("def5678") });
		const seen: string[] = [];
		await readSummaryStates(settings, [project(PATH), project(OTHER_PATH)], async (entry) => {
			seen.push(entry.path);
			return null;
		});

		assert.deepEqual(seen, [PATH, OTHER_PATH]);
	});
});
