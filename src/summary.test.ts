import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeStamp, detectStale, sanitizeBase, wasDirty } from "./summary.ts";
import type { RepoFacts } from "./types.ts";

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		path: "/projects/api",
		name: "api",
		root: "/projects",
		gitReadable: true,
		remote: null,
		github: null,
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: "2026-10-20T10:00:00+00:00",
		dirtyCount: 0,
		stashCount: 0,
		unpushedCount: 0,
		dirMtime: 0,
		...overrides,
	};
}

describe("sanitizeBase", () => {
	it("replaces characters a path cannot carry", () => {
		assert.equal(sanitizeBase('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
	});

	it("collapses runs of hyphens it created", () => {
		assert.equal(sanitizeBase("a//b"), "a-b");
		assert.equal(sanitizeBase("a--b"), "a-b");
	});

	it("trims hyphens from both ends and whitespace from the outside", () => {
		assert.equal(sanitizeBase("-api-"), "api");
		assert.equal(sanitizeBase("  api  "), "api");
		assert.equal(sanitizeBase("/api/"), "api");
	});

	it("keeps ordinary names and spaces inside the name", () => {
		assert.equal(sanitizeBase("my project"), "my project");
		assert.equal(sanitizeBase("api-v2"), "api-v2");
	});

	it("returns an empty string when there is nothing legal left", () => {
		assert.equal(sanitizeBase("///"), "");
		assert.equal(sanitizeBase(""), "");
	});
});

describe("computeStamp", () => {
	it("records the generation time, HEAD, dirty count and branch", () => {
		const stamp = computeStamp(facts({ dirtyCount: 3, branch: "feature" }), Date.parse("2026-10-21T08:30:00Z"), "abc1234");

		assert.deepEqual(stamp, {
			generatedAt: "2026-10-21T08:30:00.000Z",
			commit: "abc1234",
			dirtyCount: 3,
			branch: "feature",
		});
	});

	it("records a null HEAD for a repo with no commits", () => {
		const stamp = computeStamp(facts({ dirtyCount: 0 }), 0, null);

		assert.equal(stamp.commit, null);
		assert.equal(stamp.generatedAt, "1970-01-01T00:00:00.000Z");
	});
});

describe("wasDirty", () => {
	it("is true only when the stamp recorded uncommitted files", () => {
		assert.equal(wasDirty({ generatedAt: "", commit: "abc", dirtyCount: 1, branch: null }), true);
		assert.equal(wasDirty({ generatedAt: "", commit: "abc", dirtyCount: 0, branch: null }), false);
	});
});

describe("detectStale", () => {
	it("does not call a summary stale when either side has no commit", () => {
		assert.deepEqual(detectStale({ commit: null, dirtyCount: 0 }, facts({ dirtyCount: 5 }), "abc1234"), {
			stale: false,
			reason: "",
		});
		assert.deepEqual(detectStale({ commit: "abc1234", dirtyCount: 0 }, facts({ dirtyCount: 5 }), null), {
			stale: false,
			reason: "",
		});
	});

	it("calls it stale when HEAD moved", () => {
		const result = detectStale({ commit: "abc1234", dirtyCount: 0 }, facts(), "def5678");

		assert.equal(result.stale, true);
		assert.match(result.reason, /abc1234/);
		assert.match(result.reason, /def5678/);
	});

	it("calls it stale when the dirty count changed size", () => {
		const result = detectStale({ commit: "abc1234", dirtyCount: 2 }, facts({ dirtyCount: 12 }), "abc1234");

		assert.equal(result.stale, true);
		assert.match(result.reason, /2/);
		assert.match(result.reason, /12/);
	});

	it("stays fresh when HEAD and the dirty count both match", () => {
		assert.deepEqual(detectStale({ commit: "abc1234", dirtyCount: 2 }, facts({ dirtyCount: 2 }), "abc1234"), {
			stale: false,
			reason: "",
		});
	});

	it("does not judge a branch rename as movement", () => {
		const result = detectStale(
			{ commit: "abc1234", dirtyCount: 0 },
			facts({ branch: "renamed" }),
			"abc1234",
		);

		assert.equal(result.stale, false);
	});
});
