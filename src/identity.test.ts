import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProjectKey, projectKey, repoMarkerKey } from "./identity.ts";

describe("projectKey", () => {
	it("resolves a trailing slash, a dot and a parent segment to one key", () => {
		const expected = projectKey("/home/me/projects/api");
		assert.equal(projectKey("/home/me/projects/api/"), expected);
		assert.equal(projectKey("/home/me/projects/./api"), expected);
		assert.equal(projectKey("/home/me/projects/web/../api"), expected);
	});

	it("trims the whitespace a hand-edited frontmatter value can carry", () => {
		assert.equal(projectKey("  /home/me/projects/api  "), projectKey("/home/me/projects/api"));
	});

	it("keeps two repos with the same basename apart", () => {
		assert.notEqual(projectKey("/home/me/projects/one/api"), projectKey("/home/me/projects/two/api"));
	});
});

describe("repoMarkerKey", () => {
	it("is deterministic for the same key", () => {
		const key = "/home/me/projects/api";
		assert.equal(repoMarkerKey(key), repoMarkerKey(key));
	});

	it("is exactly sixteen lowercase hex characters", () => {
		for (const key of ["/home/me/projects/api", "", "/repos/API", "/repos/ünïcode"]) {
			assert.match(repoMarkerKey(key), /^[0-9a-f]{16}$/);
		}
	});

	it("differs for two repos with the same basename", () => {
		assert.notEqual(repoMarkerKey("/home/me/projects/one/api"), repoMarkerKey("/home/me/projects/two/api"));
	});

	it("never contains the characters that would break a comment or a marker", () => {
		const marker = repoMarkerKey("/home/me/projects/a-->b");
		assert.doesNotMatch(marker, /[-<>]/);
	});
});

describe("isProjectKey", () => {
	it("tells an absolute path from a legacy basename", () => {
		assert.equal(isProjectKey("/home/x/api"), true);
		assert.equal(isProjectKey("api"), false);
		assert.equal(isProjectKey("projects/api"), false);
	});
});
