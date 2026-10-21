import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePath } from "./obsidian-compat.ts";

/**
 * The test copy has to answer the way Obsidian does, or every pure-module test is checking a
 * path the plugin will never build in production.
 */
describe("normalizePath (test copy)", () => {
	it("turns an empty path into the vault root marker", () => {
		// Obsidian returns "/" for an empty input. `normalizeFolder` is what folds that back to
		// the empty root the plugin uses internally.
		assert.equal(normalizePath(""), "/");
	});

	it("collapses backslashes to forward slashes", () => {
		assert.equal(normalizePath("Notes\\daily\\2026-10-21.md"), "Notes/daily/2026-10-21.md");
		assert.equal(normalizePath("Notes\\\\mixed//path"), "Notes/mixed/path");
	});

	it("collapses repeated slashes", () => {
		assert.equal(normalizePath("a//b///c"), "a/b/c");
	});

	it("strips leading and trailing slashes", () => {
		assert.equal(normalizePath("/Notes/"), "Notes");
		assert.equal(normalizePath("///Notes///"), "Notes");
	});

	it("leaves parent segments alone, as Obsidian does", () => {
		// Resolving `..` here would be safer in a filesystem sense and wrong as a test double:
		// the real API does not resolve it either.
		assert.equal(normalizePath(".."), "..");
		assert.equal(normalizePath("../api"), "../api");
		assert.equal(normalizePath("a/../b"), "a/../b");
	});

	it("replaces the non-breaking spaces Obsidian replaces", () => {
		assert.equal(normalizePath("Notes\u00a0and\u202fstuff"), "Notes and stuff");
	});

	it("does not touch a thin space, which Obsidian does not replace", () => {
		// U+2009 was in the old copy and is not in Obsidian's implementation. Keeping it is the
		// point: the test copy must not be more forgiving than production.
		assert.equal(normalizePath("a\u2009b"), "a\u2009b");
	});

	it("normalises to NFC", () => {
		// The same folder typed on macOS can arrive decomposed and must compare equal to the
		// precomposed spelling the vault returns.
		assert.equal(normalizePath("cafe\u0301"), "caf\u00e9");
	});
});
