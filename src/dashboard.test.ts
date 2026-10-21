import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertSafeTarget,
	DASHBOARD_FILE,
	dashboardPath,
	renderDashboard,
	renderProjectsSection,
	renderSummaryEntry,
	upsertSummaryEntry,
} from "./dashboard.ts";
import { sectionBody } from "./markers.ts";
import type { SummaryEntry } from "./dashboard.ts";
import type { PluginSettings, Project, RepoFacts, SummaryRecord } from "./types.ts";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");

function settings(notesFolder = "Gitdeck"): PluginSettings {
	return { notesFolder } as PluginSettings;
}

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		name: "api-ai",
		path: "/home/me/projects/api-ai",
		branch: "main",
		lastCommit: "2026-10-01T00:00:00.000Z",
		dirtyCount: 0,
		ahead: 0,
		behind: 0,
		stashed: 0,
		commits: 40,
		gitReadable: true,
		...overrides,
	} as RepoFacts;
}

function project(overrides: Partial<Project> = {}, factOverrides: Partial<RepoFacts> = {}): Project {
	return {
		facts: facts(factOverrides),
		score: { score: 62, status: "active", parts: [] } as Project["score"],
		pin: 0,
		health: [],
		...overrides,
	} as Project;
}

function entry(overrides: Partial<SummaryEntry> = {}): SummaryEntry {
	const record: SummaryRecord = { generatedAt: "2026-10-02T09:00:00.000Z", commit: "de1b882", dirtyCount: 0 };
	const projectName = overrides.projectName ?? "api-ai";
	return {
		projectName,
		// Derived from the name so the existing fixtures keep one entry per project without
		// every call site having to pass a path.
		repoKey: `/home/me/projects/${projectName}`,
		provider: "codex",
		record,
		body: { summary: "A short summary.\n\nA second paragraph.", nextSteps: ["Ship it", "Write the note"] },
		...overrides,
	};
}

/**
 * One row split into cells the way the table parser splits it: on pipes nothing escapes,
 * with the escapes then handed on as the next parser receives them. The row is the line
 * between two outer pipes, which is the shape `renderProjectsSection` writes.
 */
function cells(row: string): string[] {
	const inner = row.startsWith("|") && row.endsWith("|") ? row.slice(1, -1) : row;
	return inner
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

describe("dashboardPath", () => {
	it("puts the one owned file in the notes folder", () => {
		assert.equal(dashboardPath(settings("Gitdeck")), `Gitdeck/${DASHBOARD_FILE}`);
	});

	it("uses the vault root for an empty folder", () => {
		// An empty setting is a choice, not a fallback. There is no hardcoded folder to fall back
		// to, which is the bug this replaced.
		assert.equal(dashboardPath(settings("")), DASHBOARD_FILE);
	});

	it("normalises the join", () => {
		assert.equal(dashboardPath(settings("/Gitdeck/")), `Gitdeck/${DASHBOARD_FILE}`);
	});
});

describe("assertSafeTarget", () => {
	it("accepts the dashboard", () => {
		assert.doesNotThrow(() => assertSafeTarget(settings(), `Gitdeck/${DASHBOARD_FILE}`));
	});

	it("refuses any other path", () => {
		// The failure being prevented is a generated write landing on a document somebody wrote.
		assert.throws(() => assertSafeTarget(settings(), "Notes/my-project.md"), /the dashboard is/);
		assert.throws(() => assertSafeTarget(settings(), "api-ai.md"), /the dashboard is/);
	});

	it("refuses a path outside the folder", () => {
		assert.throws(() => assertSafeTarget(settings("Notes"), "../elsewhere/Dashboard.md"), /the dashboard is/);
	});

	it("refuses something that is not markdown", () => {
		assert.throws(() => assertSafeTarget(settings(), "Gitdeck/Dashboard.txt"), /the dashboard is/);
	});

	it("has no folder to escape when the root is chosen", () => {
		assert.doesNotThrow(() => assertSafeTarget(settings(""), DASHBOARD_FILE));
	});
});

describe("renderProjectsSection", () => {
	it("says so plainly when there are no projects", () => {
		assert.match(renderProjectsSection([], NOW), /No projects found/);
	});

	it("counts projects and stamps the scan", () => {
		const text = renderProjectsSection([project(), project({}, { name: "web-ai" })], NOW);
		assert.match(text, /^2 projects, scanned 2026-10-03 12:00/);
	});

	it("uses the singular for one project", () => {
		assert.match(renderProjectsSection([project()], NOW), /^1 project,/);
	});

	it("links a note by path so a shared basename cannot resolve the wrong one", () => {
		const text = renderProjectsSection([project({ notePath: "Archive/2023/api-ai.md" })], NOW);
		assert.match(text, /\[\[Archive\/2023\/api-ai\.md\\\|api-ai\]\]/);
	});

	it("holds an aliased link to a path with a space inside one cell of an eight-cell row", () => {
		// The table parser sees the line before the wikilink parser sees the link, so the row
		// has to be eight cells first and a link second. Both come out of the same string.
		const text = renderProjectsSection([project({ notePath: "private/Gitdeck/web.md" })], NOW);
		const lines = text.split("\n").filter((line) => line.startsWith("|"));
		const header = cells(lines[0]);
		const row = cells(lines[2]);

		assert.equal(header.length, 8, "the header is eight columns");
		assert.equal(header[6], "Note");
		assert.equal(row.length, 8, "the row is eight cells");
		assert.equal(row[6], "[[private/Gitdeck/web.md|web]]");
	});

	it("says no note rather than rendering a dead link", () => {
		assert.match(renderProjectsSection([project()], NOW), /\| no note \|/);
	});

	it("orders by the same ranking the panel uses, pins first", () => {
		const text = renderProjectsSection(
			[project({}, { name: "aaa-high" }), project({ pin: 1 }, { name: "zzz-pinned" })],
			NOW,
		);
		assert.ok(text.indexOf("zzz-pinned") < text.indexOf("aaa-high"), "the pinned row comes first");
	});

	it("shows pin ranks, branch, dirty count, score and warnings", () => {
		const text = renderProjectsSection(
			[project({ pin: 2, health: [{ id: "stashed", badge: "stashed", detail: "x" }] as Project["health"] }, { dirtyCount: 7 })],
			NOW,
		);
		assert.match(text, /\| #2 \| main \| 7 \| 2d ago \| 62 \| no note \| stashed \|/);
	});

	it("escapes a pipe in a project name", () => {
		// An unescaped pipe splits the row into two columns and the table stops parsing.
		const text = renderProjectsSection([project({}, { name: "a|b" })], NOW);
		assert.match(text, /\| a\\\|b \|/);
		const rows = text.split("\n").filter((line) => line.startsWith("|"));
		assert.equal(cells(rows[2]).length, 8, "the escaped name still leaves the row at eight cells");
	});

	it("does not break the row on a newline in a name", () => {
		const text = renderProjectsSection([project({}, { name: "a\nb" })], NOW);
		assert.equal(text.split("\n").length, 5, "a preamble, a blank, a header, a rule and one row");
	});

	it("leaves the pin cell empty for an unpinned project", () => {
		assert.match(renderProjectsSection([project()], NOW), /\| api-ai \| {2}\| main \|/);
	});

	it("says no commits for a repo with no history", () => {
		assert.match(renderProjectsSection([project({}, { lastCommit: null })], NOW), /\| no commits \|/);
	});
});

describe("renderDashboard", () => {
	it("adds the project section to a note the user already wrote", () => {
		const doc = renderDashboard("# My vault\n\nMy own content.", [project()], NOW);
		assert.ok(doc.startsWith("# My vault\n\nMy own content."));
		assert.equal(sectionBody(doc, "projects")?.includes("api-ai"), true);
	});

	it("leaves the summaries section completely alone", () => {
		// The dangerous case: a scan that re-renders this section deletes 44 summaries it never
		// read. So `renderDashboard` is not given the ability to touch it at all.
		const withSummary = upsertSummaryEntry("", entry());
		const after = renderDashboard(withSummary, [project()], NOW);
		assert.equal(sectionBody(after, "summaries"), sectionBody(withSummary, "summaries"));
	});

	it("does not create a summaries section when there is none", () => {
		const doc = renderDashboard("", [project()], NOW);
		assert.equal(sectionBody(doc, "summaries"), null);
	});

	it("is stable when nothing about the projects changed", () => {
		const once = renderDashboard("", [project()], NOW);
		assert.equal(renderDashboard(once, [project()], NOW), once);
	});

	it("keeps a user's text outside the markers through several scans", () => {
		let doc = "Preamble.\n\nMine.\n";
		for (let round = 0; round < 3; round++) doc = renderDashboard(doc, [project()], NOW);
		assert.ok(doc.startsWith("Preamble.\n\nMine.\n"));
	});
});

describe("renderSummaryEntry", () => {
	it("folds the callout shut", () => {
		// The accepted cost of one file holding every summary is size, and `-` is Obsidian's own
		// mechanism for that rather than a syntax of ours.
		assert.match(renderSummaryEntry(entry()), /^> \[!note\]- api-ai$/m);
	});

	it("says it is machine written, unedited and possibly wrong", () => {
		const text = renderSummaryEntry(entry());
		assert.match(text, /Machine-written by `codex` from git metadata only\. Not reviewed, and it can be wrong\./);
	});

	it("states the provenance rather than leaving it in a property", () => {
		assert.match(
			renderSummaryEntry(entry()),
			/> Generated 2026-10-02T09:00:00.000Z from commit `de1b882`\. The working tree was clean at that point\./,
		);
	});

	it("counts the uncommitted files a summary could not describe", () => {
		const text = renderSummaryEntry(
			entry({ record: { generatedAt: "2026-10-02T09:00:00.000Z", commit: "de1b882", dirtyCount: 12 } }),
		);
		assert.match(text, /12 uncommitted file\(s\) at that point, which are in no commit\./);
	});

	it("handles a repo with no commits and an unrecorded generation", () => {
		assert.match(
			renderSummaryEntry(entry({ record: { generatedAt: null, commit: null, dirtyCount: 0 } })),
			/from a repo with no commits/,
		);
		assert.match(renderSummaryEntry(entry({ record: null })), /No generation details were recorded/);
	});

	it("prefixes every line, so the callout cannot end early", () => {
		// A blank line without the `>` ends the callout, and the rest of the summary would leak
		// into the document as ordinary paragraphs.
		const text = renderSummaryEntry(entry());
		for (const line of text.split("\n")) assert.match(line, /^>|>$/, `unprefixed line: ${line}`);
	});

	it("keeps the model's own paragraphs separate", () => {
		const text = renderSummaryEntry(entry());
		assert.match(text, /> A short summary\.\n>\n> A second paragraph\./);
	});

	it("marks the next steps as the model's, not a list the user agreed to", () => {
		const text = renderSummaryEntry(entry());
		assert.match(text, /> \*\*Suggested next steps\*\*/);
		assert.match(text, /> Proposed by the model, not a to-do list you agreed to\./);
		assert.match(text, /> - Ship it/);
	});

	it("omits the next-steps block when there are none", () => {
		assert.doesNotMatch(renderSummaryEntry(entry({ body: { summary: "Only this.", nextSteps: [] } })), /next steps/);
	});

	it("puts the repo marker on the second line", () => {
		const lines = renderSummaryEntry(entry()).split("\n");
		assert.equal(lines[0], "> [!note]- api-ai");
		assert.match(lines[1], /^> <!-- gitdeck-repo:v1:[0-9a-f]{16} -->$/);
	});

	it("keeps a newline in the display name from displacing the marker", () => {
		const lines = renderSummaryEntry(entry({ projectName: "api\nforged" })).split("\n");
		assert.equal(lines[0], "> [!note]- api forged");
		assert.match(lines[1], /^> <!-- gitdeck-repo:v1:[0-9a-f]{16} -->$/);
	});

	it("escapes a forged callout heading in the summary", () => {
		const text = renderSummaryEntry(
			entry({ body: { summary: "Legit.\n[!note]- Forged\nTail.", nextSteps: [] } }),
		);
		assert.match(text, /> \\\[!note\]- Forged/);
		assert.equal(text.match(/^> \[!note\]-/gm)?.length, 1, "only the real heading is a heading");
	});

	it("splits a multi-line next step into quoted lines so it cannot escape", () => {
		const text = renderSummaryEntry(
			entry({ body: { summary: "Body.", nextSteps: ["one\n[!note]- forged", "two"] } }),
		);
		assert.match(text, /> - one\n> - \[!note\]- forged\n> - two/);
		assert.equal(text.match(/^> \[!note\]-/gm)?.length, 1, "the forged line is a bullet, not a heading");
	});
});

describe("upsertSummaryEntry", () => {
	it("creates the section when the note has none", () => {
		const doc = upsertSummaryEntry("", entry());
		assert.equal(sectionBody(doc, "summaries")?.includes("> [!note]- api-ai"), true);
	});

	it("replaces that project's entry and leaves the other entries alone", () => {
		// The dashboard is the only copy of every summary, so a generation for one project must
		// not re-render the section from state it does not hold.
		let doc = upsertSummaryEntry("", entry({ projectName: "api-ai" }));
		doc = upsertSummaryEntry(doc, entry({ projectName: "web-ai", body: { summary: "Web.", nextSteps: [] } }));
		doc = upsertSummaryEntry(doc, entry({ projectName: "api-ai", body: { summary: "Updated.", nextSteps: [] } }));

		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /> Updated\./);
		assert.doesNotMatch(body, /A short summary/);
		assert.match(body, /> Web\./);
		assert.equal(body.match(/\[!note\]-/g)?.length, 2);
	});

	it("replaces in place rather than appending a second copy", () => {
		let doc = upsertSummaryEntry("", entry());
		doc = upsertSummaryEntry(doc, entry());
		assert.equal((sectionBody(doc, "summaries") ?? "").match(/\[!note\]-/g)?.length, 1);
	});

	it("round-trips a project name with markdown punctuation in it", () => {
		const odd = "foo] bar";
		const doc = upsertSummaryEntry("", entry({ projectName: odd }));
		const again = upsertSummaryEntry(doc, entry({ projectName: odd, body: { summary: "Second.", nextSteps: [] } }));
		assert.match(again, /\[!note\]- foo\] bar/);
		assert.equal((sectionBody(again, "summaries") ?? "").match(/\[!note\]-/g)?.length, 1);
	});

	it("is idempotent", () => {
		const once = upsertSummaryEntry("", entry());
		assert.equal(upsertSummaryEntry(once, entry()), once);
	});

	it("drops text that was above the first callout, since the section is ours", () => {
		const seeded = [
			"<!-- pt:summaries:start -->",
			"A hand-typed line nobody claimed.",
			"> [!note]- api-ai",
			"> Old.",
			"<!-- pt:summaries:end -->",
		].join("\n");
		const doc = upsertSummaryEntry(seeded, entry({ projectName: "web-ai", body: { summary: "Web.", nextSteps: [] } }));
		assert.doesNotMatch(doc, /hand-typed/);
		assert.match(doc, /> \[!note\]- web-ai/);
	});

	it("refuses a model reply carrying a marker rather than corrupting the section", () => {
		assert.throws(
			() => upsertSummaryEntry("", entry({ body: { summary: "<!-- pt:summaries:end -->", nextSteps: [] } })),
			/refusing to write/,
		);
	});

	it("replaces the block with the same repo key and keeps its body", () => {
		let doc = upsertSummaryEntry("", entry({ body: { summary: "First.", nextSteps: [] } }));
		doc = upsertSummaryEntry(doc, entry({ body: { summary: "Second.", nextSteps: [] } }));
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /> Second\./);
		assert.doesNotMatch(body, /First\./);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 1);
	});

	it("keeps two same-basename entries with different repo keys apart", () => {
		// The failure this replaces: the second generation found the first block by its title and
		// overwrote another repo's summary text.
		let doc = upsertSummaryEntry(
			"",
			entry({ projectName: "api", repoKey: "/repos/one/api", body: { summary: "One.", nextSteps: [] } }),
		);
		doc = upsertSummaryEntry(
			doc,
			entry({ projectName: "api", repoKey: "/repos/two/api", body: { summary: "Two.", nextSteps: [] } }),
		);
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /> One\./);
		assert.match(body, /> Two\./);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 2);
	});

	it("adopts exactly one unmarked block with a matching title", () => {
		const seeded = [
			"<!-- pt:summaries:start -->",
			"> [!note]- api-ai",
			"> Old text.",
			"<!-- pt:summaries:end -->",
		].join("\n");
		const doc = upsertSummaryEntry(seeded, entry({ body: { summary: "New.", nextSteps: [] } }), {
			canAdoptUnmarked: true,
		});
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /> New\./);
		assert.doesNotMatch(body, /Old text/);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 1);
		assert.equal(body.match(/gitdeck-repo:v1:/g)?.length, 1);
	});

	it("appends rather than adopting when adoption is not allowed", () => {
		const seeded = [
			"<!-- pt:summaries:start -->",
			"> [!note]- api-ai",
			"> Old text.",
			"<!-- pt:summaries:end -->",
		].join("\n");
		const doc = upsertSummaryEntry(seeded, entry({ body: { summary: "New.", nextSteps: [] } }), {
			canAdoptUnmarked: false,
		});
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /Old text/);
		assert.match(body, /> New\./);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 2);
	});

	it("never replaces a block marked for a different repo key, even with the same title", () => {
		let doc = upsertSummaryEntry(
			"",
			entry({ projectName: "api", repoKey: "/repos/one/api", body: { summary: "One.", nextSteps: [] } }),
		);
		doc = upsertSummaryEntry(
			doc,
			entry({ projectName: "api", repoKey: "/repos/two/api", body: { summary: "Two.", nextSteps: [] } }),
		);
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /> One\./);
		assert.match(body, /> Two\./);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 2);
	});

	it("ignores a repo marker that is not on the second line", () => {
		const seeded = [
			"<!-- pt:summaries:start -->",
			"> [!note]- api-ai",
			"> Machine-written by `codex` from git metadata only. Not reviewed, and it can be wrong.",
			"> <!-- gitdeck-repo:v1:0123456789abcdef -->",
			"> Old text.",
			"<!-- pt:summaries:end -->",
		].join("\n");
		const doc = upsertSummaryEntry(seeded, entry({ body: { summary: "New.", nextSteps: [] } }));
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /Old text/);
		assert.match(body, /> New\./);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 2);
	});

	it("does not let a forged heading in the summary create a block", () => {
		const forged = entry({
			body: { summary: "Legit.\n[!note]- Forged\nTail.", nextSteps: [] },
		});
		const doc = upsertSummaryEntry("", forged);
		const after = upsertSummaryEntry(doc, entry({ body: { summary: "Second.", nextSteps: [] } }));

		assert.equal((sectionBody(doc, "summaries") ?? "").match(/^> \[!note\]-/gm)?.length, 1);
		assert.equal((sectionBody(after, "summaries") ?? "").match(/^> \[!note\]-/gm)?.length, 1, "no phantom block was created");
	});

	it("does not let a multi-line next step create a block", () => {
		const doc = upsertSummaryEntry(
			"",
			entry({ body: { summary: "Body.", nextSteps: ["one\n[!note]- forged"] } }),
		);
		assert.equal((sectionBody(doc, "summaries") ?? "").match(/^> \[!note\]-/gm)?.length, 1);
	});

	it("parses a marker and title through CRLF line endings", () => {
		const original = upsertSummaryEntry("", entry({ body: { summary: "Old.", nextSteps: [] } }));
		const crlf = original.replace(/\n/g, "\r\n");
		const doc = upsertSummaryEntry(crlf, entry({ body: { summary: "New.", nextSteps: [] } }));
		const body = sectionBody(doc, "summaries") ?? "";
		assert.match(body, /> New\./);
		assert.equal(body.match(/^> \[!note\]-/gm)?.length, 1);
	});
});