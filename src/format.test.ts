import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { basename, cell, isoDate, linkCell, relativeAge } from "./format.ts";

describe("cell", () => {
	it("escapes a pipe so it cannot split the table row", () => {
		assert.equal(cell("a|b"), "a\\|b");
		assert.equal(cell("a|b|c"), "a\\|b\\|c");
	});

	it("flattens a newline to a space", () => {
		assert.equal(cell("one\ntwo"), "one two");
		assert.equal(cell("one\r\ntwo"), "one two");
	});

	it("leaves ordinary text alone", () => {
		assert.equal(cell("plain text"), "plain text");
		assert.equal(cell(""), "");
	});
});

describe("basename", () => {
	it("takes the last path segment and drops a markdown suffix", () => {
		assert.equal(basename("folder/note.md"), "note");
		assert.equal(basename("note.md"), "note");
	});

	it("drops the suffix regardless of case", () => {
		assert.equal(basename("folder/note.MD"), "note");
		assert.equal(basename("folder/note.Md"), "note");
	});

	it("does not treat a dot in the middle as a suffix", () => {
		assert.equal(basename("folder/note.md.bak"), "note.md.bak");
	});

	it("handles a path with no slash and no suffix", () => {
		assert.equal(basename("note"), "note");
	});
});

describe("linkCell", () => {
	it("writes the table-safe alias separator and a name without the suffix", () => {
		assert.equal(linkCell("folder/note.md"), "[[folder/note.md\\|note]]");
	});

	it("escapes a pipe on both sides of the separator", () => {
		assert.equal(linkCell("a|b.md"), "[[a\\|b.md\\|a\\|b]]");
	});

	it("keeps the path when the note is not markdown", () => {
		assert.equal(linkCell("folder/note.txt"), "[[folder/note.txt\\|note.txt]]");
	});
});

describe("isoDate", () => {
	it("keeps the date part of a timestamp with an offset", () => {
		assert.equal(isoDate("2026-08-30T18:51:55+03:00"), "2026-08-30");
		assert.equal(isoDate("2026-08-30T15:51:55Z"), "2026-08-30");
	});

	it("accepts a date-only value", () => {
		assert.equal(isoDate("2026-08-30"), "2026-08-30");
	});

	it("returns null for nothing or something that is not a date", () => {
		assert.equal(isoDate(null), null);
		assert.equal(isoDate(""), null);
		assert.equal(isoDate("not-a-date"), null);
		assert.equal(isoDate("30-08-2026"), null);
	});
});

describe("relativeAge", () => {
	const NOW = Date.parse("2026-10-21T12:00:00Z");
	const DAY = 24 * 60 * 60 * 1000;
	const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

	it("says today for the future and the last day", () => {
		assert.equal(relativeAge(ago(-1), NOW), "today");
		assert.equal(relativeAge(ago(0), NOW), "today");
	});

	it("says yesterday for one day", () => {
		assert.equal(relativeAge(ago(1), NOW), "yesterday");
	});

	it("counts days below a month", () => {
		assert.equal(relativeAge(ago(2), NOW), "2d ago");
		assert.equal(relativeAge(ago(29), NOW), "29d ago");
	});

	it("does not call 30-59 days a month", () => {
		assert.equal(relativeAge(ago(30), NOW), "30d ago");
		assert.equal(relativeAge(ago(59), NOW), "59d ago");
	});

	it("counts whole months from 60 days", () => {
		assert.equal(relativeAge(ago(60), NOW), "2mo ago");
		assert.equal(relativeAge(ago(365), NOW), "12mo ago");
	});

	it("says so when there is no date or it cannot be parsed", () => {
		assert.equal(relativeAge(null, NOW), "no commits");
		assert.equal(relativeAge("", NOW), "no commits");
		assert.equal(relativeAge("rubbish", NOW), "unknown");
	});
});
