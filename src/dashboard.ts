/**
 * The dashboard note: where it is, what it says, and the guard that keeps a generated write off
 * anything that is not ours.
 *
 * This file is pure. It reads strings and returns strings, which is what makes the one write
 * path in this plugin testable without Obsidian: every case that could eat a person's writing
 * can be reproduced here with a string, which is the only practical way to check them.
 *
 * The vault side of it is `vault.ts`: read the note, hand it here, write back what comes out.
 *
 * Two owned sections, marked by HTML comments, and nothing outside them is ever touched. See
 * `markers.ts` for why that is decided there and how a broken span is handled.
 */
import { cell, linkCell } from "./format.ts";
import { repoMarkerKey } from "./identity.ts";
import { joinVaultPath, normalizeFolder } from "./normalize.ts";
import type { NormalizePath } from "./normalize.ts";
import { replaceSection, sectionBody } from "./markers.ts";
import { rankProjects } from "./rank.ts";
import type { SummaryBody } from "./summary.ts";
import type { PluginSettings, Project, SummaryRecord } from "./types.ts";

/** The one file the plugin owns. */
export const DASHBOARD_FILE = "Dashboard.md";

/**
 * Where the dashboard note is.
 *
 * An empty folder means the vault root, which is a real choice rather than a fallback to a
 * default: this plugin has no opinion about where anyone's notes live, and a user who clears the
 * field gets the root and not somebody else's folder.
 */
export function dashboardPath(settings: PluginSettings, normalize: NormalizePath): string {
	return joinVaultPath(normalizeFolder(settings.notesFolder, normalize), DASHBOARD_FILE);
}

/**
 * Throw unless `target` is safe to write generated content to.
 *
 * The paranoia is unchanged from when this guarded a per-project summary note; only the shape of
 * the answer moved. It re-derives the path and compares rather than trusting the caller to have
 * picked the right one, because the failure being prevented is a generated write landing on a
 * document somebody wrote.
 *
 * Two refusals, in the order they would matter:
 *
 * - Not the dashboard path. A caller that computed something else has a bug, and the bug should
 *   be loud.
 * - Not outside the notes folder, or not a markdown file. Both mean the folder setting is
 *   something other than what was expected.
 *
 * There is no "and not a project note" clause any more, because nothing writes to a project note.
 * The collision that clause used to cover is real and is handled where it can happen: a
 * repository named `Dashboard` resolves to no note at all, because `readNoteCandidates` leaves
 * the dashboard out of the candidates.
 */
export function assertSafeTarget(
	settings: PluginSettings,
	target: string,
	normalize: NormalizePath,
): void {
	const expected = dashboardPath(settings, normalize);
	if (target !== expected) {
		throw new Error(`refusing to write ${target}: the dashboard is ${expected}`);
	}
	if (!target.endsWith(".md")) {
		throw new Error(`refusing to write ${target}: not a markdown file`);
	}
	const folder = normalizeFolder(settings.notesFolder, normalize);
	if (folder !== "" && !target.startsWith(`${folder}/`)) {
		throw new Error(`refusing to write outside ${folder}: ${target}`);
	}
}

/**
 * The project table, as markdown.
 *
 * Ordered by `rankProjects`, the same function the panel ranks with, so the note and the sidebar
 * cannot disagree about what is on top. Nothing here is generated prose: a table cell is short
 * enough that a sentence would be worse.
 *
 * The Note column is the honest part. A project with no note says so in words rather than
 * rendering a link that goes nowhere, because a dead wikilink in a document a person reads
 * looks like a bug in the document.
 */
export function renderProjectsSection(projects: readonly Project[], now: number): string {
	const ranked = rankProjects([...projects]);
	const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 16);

	const lines: string[] = [];
	lines.push(
		ranked.length === 1
			? `1 project, scanned ${stamp}. Written between the markers below on every scan. Everything outside them is yours.`
			: `${ranked.length} projects, scanned ${stamp}. Written between the markers below on every scan. Everything outside them is yours.`,
	);
	lines.push("");
	if (ranked.length === 0) {
		lines.push("_No projects found under the scan root._");
		return lines.join("\n");
	}

	lines.push("| Project | Pin | Branch | Uncommitted | Last commit | Score | Note | Warnings |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const project of ranked) {
		const facts = project.facts;
		const row = [
			cell(facts.name),
			cell(project.pin > 0 ? `#${project.pin}` : ""),
			cell(facts.branch ?? ""),
			cell(String(facts.dirtyCount)),
			cell(relativeAge(facts.lastCommit, now)),
			cell(String(project.score.score)),
			project.notePath ? linkCell(project.notePath) : "no note",
			cell(project.health.map((signal) => signal.badge).join(", ")),
		];
		// Padded at both ends. The leading pipe is what makes the first column a column, and the
		// trailing one is what makes the last cell empty rather than missing, which is how
		// Obsidian's table editor addresses it.
		lines.push(`| ${row.join(" | ")} |`);
	}
	return lines.join("\n");
}

/**
 * One project's AI summary, as a folded callout.
 *
 * Folded because the accepted risk of one file holding every summary is size, and Obsidian's own
 * `-` suffix on a callout is the mechanism for that: no custom syntax, nothing to implement, and
 * it survives the round trip through any markdown tool.
 *
 * Every line is prefixed, blank lines included, or the callout ends at the first one and the rest
 * of the summary leaks into the document below it.
 *
 * The second line is the repo marker. It is what `upsertSummaryEntry` matches on, so two repos
 * with the same basename cannot share or overwrite each other's block. It is a digest rather
 * than the path itself: a path can contain `--` or `>`, either of which would end the HTML
 * comment or the callout. The marker is inside the fold for the same reason the warning is: a
 * collapsed callout should not open with machine plumbing.
 *
 * The machine-written line is inside the fold rather than above the section because a collapsed
 * callout is a collapsed callout: someone who opens this note should not have to read 45
 * identical warnings to find the one thing they came for, and someone who opens one summary
 * should see what it is before reading it.
 */
export function renderSummaryEntry(entry: SummaryEntry): string {
	// A newline in the display name would end the heading line and the marker line would no
	// longer be second, which is the one place the parser looks for it.
	const projectName = entry.projectName.replace(/[\r\n]+/g, " ");
	const lines: string[] = [];
	lines.push(`> [!note]- ${projectName}`);
	lines.push(`> <!-- gitdeck-repo:v1:${repoMarkerKey(entry.repoKey)} -->`);
	lines.push(`> Machine-written by \`${entry.provider}\` from git metadata only. Not reviewed, and it can be wrong.`);
	lines.push(`> ${provenanceLine(entry.record)}`);
	lines.push(QUOTE_BLANK);
	lines.push("> **Summary**");
	lines.push(QUOTE_BLANK);
	for (const line of entry.body.summary.split("\n")) lines.push(quote(escapeCallout(line)));
	if (entry.body.nextSteps.length > 0) {
		lines.push(QUOTE_BLANK);
		lines.push("> **Suggested next steps**");
		lines.push(QUOTE_BLANK);
		lines.push("> Proposed by the model, not a to-do list you agreed to.");
		lines.push(QUOTE_BLANK);
		// One quoted line per source line. A step containing a newline would otherwise start a
		// new line with `> ` and could forge a callout heading, which `splitSummaryEntries`
		// would read as a second project's block.
		for (const step of entry.body.nextSteps) {
			for (const line of step.split(/\r?\n/)) lines.push(quote(`- ${line}`));
		}
	}
	return lines.join("\n");
}

/**
 * Stop a summary line from opening a callout.
 *
 * `splitSummaryEntries` treats any line matching a callout heading as the start of a new
 * block, and model output is untrusted text. Escaping the `[` is enough to keep the line
 * inside this callout while leaving the words visible, and a backslash before a bracket is
 * inert markdown rather than a character the reader sees.
 */
function escapeCallout(line: string): string {
	return /^\s*\[![a-z-]+\]-/i.test(line) ? `\\${line}` : line;
}

/**
 * A blank line inside a callout: the quote and nothing else.
 *
 * `> ` with the trailing space would be equally valid markdown and much less safe. Whitespace at
 * the end of a line is the first thing half the editors in a vault strip on save, and a stripped
 * blank quote is an empty line, and an empty line ends the callout and leaks the rest of the
 * summary into the document as loose paragraphs.
 */
const QUOTE_BLANK = ">";

/** One line inside a callout. */
function quote(line: string): string {
	return line === "" ? QUOTE_BLANK : `> ${line}`;
}

/** One project's summary, ready to render. */
export interface SummaryEntry {
	projectName: string;
	/** The resolved project key this block belongs to. Never the display name. */
	repoKey: string;
	provider: string;
	/** What it was generated from. Null only for a summary with nothing recorded about it. */
	record: SummaryRecord | null;
	body: SummaryBody;
}

/**
 * Put one project's summary into the note, replacing that project's previous one and leaving
 * every other project's exactly as it was.
 *
 * The whole section is not re-rendered, because the plugin does not keep the summaries
 * anywhere else: the note is the only copy. Re-rendering from state would mean storing every
 * summary in data.json and treating the note as a view, which is the arrangement this change
 * moved away from.
 *
 * Entries are found by the repo marker on the second line, not by the heading. A heading is a
 * display name, and two repos named `api` have the same one: matching on it meant generating a
 * summary for one repo replaced the other's text. A block marked for a different key is never
 * replaced, even when the title matches. That case is a moved repo or two directories with one
 * name, and appending leaves the old text intact for a person to sort out.
 *
 * `canAdoptUnmarked` is for blocks written before markers existed. Adoption is allowed only
 * when exactly one unmarked block has this display name, because two unmarked `api` blocks are
 * the ambiguity the marker was added to resolve, and picking one would be a guess.
 */
export function upsertSummaryEntry(
	doc: string,
	entry: SummaryEntry,
	options: { canAdoptUnmarked?: boolean } = {},
): string {
	const existing = sectionBody(doc, "summaries");
	const blocks = existing === null ? [] : splitSummaryEntries(existing);
	const rendered = renderSummaryEntry(entry);
	const marker = repoMarkerKey(entry.repoKey);

	let index = blocks.findIndex((block) => block.key === marker);
	if (index === -1 && options.canAdoptUnmarked) {
		const unmarked = blocks.filter((block) => block.key === null && block.title === entry.projectName);
		if (unmarked.length === 1) index = blocks.indexOf(unmarked[0]);
	}

	if (index === -1) {
		blocks.push({ key: marker, title: entry.projectName, lines: rendered.split("\n") });
	} else {
		blocks[index] = { key: marker, title: entry.projectName, lines: rendered.split("\n") };
	}

	return replaceSection(doc, "summaries", blocks.map((block) => block.lines.join("\n")).join("\n\n"));
}

/** One parsed callout: the marker and title in its first two lines, and the lines under them. */
interface SummaryBlock {
	/** The repo marker digest, or null for a block written before markers existed. */
	key: string | null;
	title: string;
	lines: string[];
}

/**
 * Split a section body into its callouts.
 *
 * Anything before the first heading is dropped on the next write, because it is neither a callout
 * nor a marker: it is whatever was in a section the plugin owns. Everything from the first
 * heading onward is kept verbatim, which is the requirement -- a scan never reaches this section,
 * so the only writer is a generation, and it must not take the other 44 projects with it.
 */
function splitSummaryEntries(body: string): SummaryBlock[] {
	const blocks: SummaryBlock[] = [];
	for (const line of body.split("\n")) {
		const title = calloutTitle(line);
		if (title !== null) {
			blocks.push({ key: null, title, lines: [line] });
			continue;
		}
		if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
	}
	return blocks.map((block) => ({ ...block, key: repoKeyFromLines(block.lines) }));
}

/**
 * The repo marker on a block's second line, or null when it is absent or malformed.
 *
 * Only the second line, deliberately. The summary body is model output, and a line that looked
 * like a marker further down must not be able to claim the block.
 */
function repoKeyFromLines(lines: readonly string[]): string | null {
	const second = lines[1]?.trim();
	if (second === undefined) return null;
	const match = /^> <!-- gitdeck-repo:v1:([0-9a-f]{16}) -->$/.exec(second);
	return match ? match[1] : null;
}

/** The project name in a callout heading line, or null when this line is not one. */
function calloutTitle(line: string): string | null {
	const match = /^> \[![a-z-]+\]- ?(.*)$/.exec(line.trim());
	return match ? match[1] : null;
}

/**
 * Write the project table into the dashboard, and nothing else.
 *
 * Deliberately has no way to touch the summaries section. The two are written by two different
 * events, a scan and a generation, and the only copy of every summary is the note itself. A scan
 * that re-rendered that section would delete 44 summaries it never read, so the function that
 * runs every 30 seconds is not given the ability.
 */
export function renderDashboard(existing: string, projects: readonly Project[], now: number): string {
	return replaceSection(existing, "projects", renderProjectsSection(projects, now));
}

/**
 * One line saying what a summary was written from.
 *
 * Says "no generation details" rather than leaving the line out when there is no record, because
 * a summary with no provenance is a thing that happens after an upgrade and a reader needs to be
 * able to tell it apart from one the plugin made itself.
 */
function provenanceLine(record: SummaryRecord | null): string {
	if (!record) return "No generation details were recorded for this one.";
	const when = record.generatedAt ?? "an unknown time";
	const commit = record.commit ? `commit \`${record.commit}\`` : "a repo with no commits";
	const dirty =
		record.dirtyCount > 0
			? ` ${record.dirtyCount} uncommitted file(s) at that point, which are in no commit.`
			: " The working tree was clean at that point.";
	return `Generated ${when} from ${commit}.${dirty}`;
}

/** Days since an ISO date, in the words the panel uses. */
function relativeAge(iso: string | null, now: number): string {
	if (!iso) return "no commits";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "unknown";
	const days = Math.floor((now - time) / (24 * 60 * 60 * 1000));
	if (days <= 0) return "today";
	return `${days}d ago`;
}
