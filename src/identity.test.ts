import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { duplicateNameQualifiers, isProjectKey, projectKey, repoMarkerKey } from "./identity.ts";

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

describe("duplicateNameQualifiers", () => {
	it("qualifies only the names that are shared", () => {
		const qualifiers = duplicateNameQualifiers([
			{ name: "api", path: "/home/me/projects/client-a/api", root: "/home/me/projects" },
			{ name: "api", path: "/home/me/projects/client-b/api", root: "/home/me/projects" },
			{ name: "web", path: "/home/me/projects/web", root: "/home/me/projects" },
		]);

		assert.equal(qualifiers.size, 2);
		assert.equal(qualifiers.get(projectKey("/home/me/projects/client-a/api")), "client-a");
		assert.equal(qualifiers.get(projectKey("/home/me/projects/client-b/api")), "client-b");
		assert.equal(qualifiers.has(projectKey("/home/me/projects/web")), false);
	});

	it("falls back to the parent basename when the repo is not under the scan root", () => {
		// A hand-edited scan root can leave a project outside it. The row still needs words that
		// differ from the other same-named row.
		const qualifiers = duplicateNameQualifiers([
			{ name: "api", path: "/elsewhere/client-a/api", root: "/home/me/projects" },
			{ name: "api", path: "/elsewhere/client-b/api", root: "/home/me/projects" },
		]);

		assert.equal(qualifiers.get(projectKey("/elsewhere/client-a/api")), "client-a");
		assert.equal(qualifiers.get(projectKey("/elsewhere/client-b/api")), "client-b");
	});
});
