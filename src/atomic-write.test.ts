import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atomicUpdate } from "./atomic-write.ts";
import type { AtomicOptions, AtomicTarget } from "./atomic-write.ts";
import { replaceSection, sectionBody } from "./markers.ts";

const PROJECTS_START = "<!-- pt:projects:start -->";
const PROJECTS_END = "<!-- pt:projects:end -->";
const WEEKLY_START = "<!-- pt:weekly:start -->";
const WEEKLY_END = "<!-- pt:weekly:end -->";

function projectsDoc(body: string, outside = ""): string {
	const lines = ["# Dashboard", "", PROJECTS_START, body, PROJECTS_END];
	if (outside !== "") lines.push("", outside);
	return lines.join("\n");
}

function weeklyDoc(body: string, outside = ""): string {
	const lines = ["# Weekly", "", WEEKLY_START, body, WEEKLY_END];
	if (outside !== "") lines.push("", outside);
	return lines.join("\n");
}

const CREATE: AtomicOptions = { missing: "create" };

/**
 * A vault file on a string, with hooks for the interleavings.
 *
 * `process` deliberately does not treat a thrown callback as an abort: it lets the throw reject
 * and writes nothing. That is one of the two behaviours a real vault might have, and the module
 * must not depend on which one it gets.
 */
class FakeTarget implements AtomicTarget {
	disk: string | null;
	processCalls = 0;
	createCalls = 0;
	readError: Error | null = null;
	processError: Error | null = null;
	createError: Error | null = null;
	beforeProcess: ((target: FakeTarget) => void) | null = null;
	beforeCreate: ((target: FakeTarget) => void) | null = null;

	constructor(disk: string | null) {
		this.disk = disk;
	}

	async read(): Promise<string | null> {
		if (this.readError) throw this.readError;
		return this.disk;
	}

	async process(transform: (fresh: string) => string): Promise<string> {
		if (this.processError) throw this.processError;
		this.beforeProcess?.(this);
		if (this.disk === null) throw new Error("process called with no file");
		const next = transform(this.disk);
		this.disk = next;
		this.processCalls++;
		return next;
	}

	async create(content: string): Promise<void> {
		this.beforeCreate?.(this);
		this.createCalls++;
		if (this.createError) throw this.createError;
		if (this.disk !== null) throw new Error("file already exists");
		this.disk = content;
	}
}

describe("atomicUpdate", () => {
	it("keeps a concurrent edit outside the section", async () => {
		const userLine = "A line typed while the scan ran.";
		const target = new FakeTarget(projectsDoc("A"));
		target.beforeProcess = (fake) => {
			fake.disk = `${fake.disk ?? ""}\n${userLine}`;
		};

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "projects", "B"),
			CREATE,
		);

		assert.equal(outcome.status, "written");
		assert.equal(sectionBody(target.disk ?? "", "projects"), "B");
		assert.ok(target.disk?.includes(userLine), "the user's line survives");
	});

	it("skips the write when the snapshot is already what transform wants", async () => {
		const before = projectsDoc("A");
		const target = new FakeTarget(before);

		const outcome = await atomicUpdate(target, (doc) => doc, CREATE);

		assert.deepEqual(outcome, { status: "unchanged", content: before });
		assert.equal(target.processCalls, 0);
		assert.equal(target.disk, before);
	});

	it("reports unchanged when the fresh contents already match the plan", async () => {
		const snapshot = projectsDoc("A");
		const planned = replaceSection(snapshot, "projects", "B");
		const target = new FakeTarget(snapshot);
		target.beforeProcess = (fake) => {
			fake.disk = planned;
		};

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "projects", "B"),
			CREATE,
		);

		assert.deepEqual(outcome, { status: "unchanged", content: planned });
		assert.equal(target.processCalls, 1);
		assert.equal(target.disk, planned);
	});

	it("writes through process when the content changes", async () => {
		const target = new FakeTarget(projectsDoc("A"));

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "projects", "B"),
			CREATE,
		);

		assert.equal(outcome.status, "written");
		assert.equal(target.processCalls, 1);
		assert.equal(target.disk, projectsDoc("B"));
	});

	it("creates a missing file from transform on empty contents", async () => {
		const target = new FakeTarget(null);

		const outcome = await atomicUpdate(target, () => "new", CREATE);

		assert.deepEqual(outcome, { status: "written", content: "new" });
		assert.equal(target.createCalls, 1);
		assert.equal(target.processCalls, 0);
		assert.equal(target.disk, "new");
	});

	it("refuses a missing file when asked to", async () => {
		const target = new FakeTarget(null);

		const outcome = await atomicUpdate(target, () => "new", { missing: "refuse" });

		assert.deepEqual(outcome, { status: "refused", reason: "missing" });
		assert.equal(target.createCalls, 0);
		assert.equal(target.processCalls, 0);
	});

	it("guards a file that appears before create lands", async () => {
		const foreign = "# Someone else's weekly note\n\nNo section here.";
		const target = new FakeTarget(null);
		target.beforeCreate = (fake) => {
			fake.disk = foreign;
		};

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "weekly", "tables"),
			{
				missing: "create",
				guard: (doc) => (sectionBody(doc, "weekly") === null ? "foreign" : null),
			},
		);

		assert.deepEqual(outcome, { status: "refused", reason: "foreign" });
		assert.equal(target.disk, foreign);
	});

	it("fails when create fails and the file stays missing", async () => {
		const target = new FakeTarget(null);
		target.createError = new Error("disk full");

		const outcome = await atomicUpdate(target, () => "new", CREATE);

		assert.deepEqual(outcome, { status: "failed" });
		assert.equal(target.createCalls, 1);
		assert.equal(target.disk, null);
	});

	it("refuses a foreign weekly file before processing", async () => {
		const target = new FakeTarget("# A journal\n\nNo weekly section.");

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "weekly", "tables"),
			{
				missing: "create",
				guard: (doc) => (sectionBody(doc, "weekly") === null ? "foreign" : null),
			},
		);

		assert.deepEqual(outcome, { status: "refused", reason: "foreign" });
		assert.equal(target.processCalls, 0);
	});

	it("refuses when the weekly section disappears inside the callback", async () => {
		const foreign = "# Converted to a journal\n\nNo section any more.";
		const target = new FakeTarget(weeklyDoc("old"));
		target.beforeProcess = (fake) => {
			fake.disk = foreign;
		};

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "weekly", "tables"),
			{
				missing: "create",
				guard: (doc) => (sectionBody(doc, "weekly") === null ? "foreign" : null),
			},
		);

		assert.deepEqual(outcome, { status: "refused", reason: "foreign" });
		assert.equal(target.disk, foreign);
	});

	it("does not run the guard when creating a missing weekly file", async () => {
		let guardCalls = 0;
		const target = new FakeTarget(null);

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "weekly", "tables"),
			{
				missing: "create",
				guard: () => {
					guardCalls++;
					return "foreign";
				},
			},
		);

		assert.equal(outcome.status, "written");
		assert.equal(target.createCalls, 1);
		assert.equal(guardCalls, 0);
		assert.equal(sectionBody(target.disk ?? "", "weekly"), "tables");
	});

	it("fails when transform throws on the snapshot", async () => {
		const target = new FakeTarget(projectsDoc("A"));

		const outcome = await atomicUpdate(
			target,
			() => {
				throw new Error("a marker in the body");
			},
			CREATE,
		);

		assert.deepEqual(outcome, { status: "failed" });
		assert.equal(target.processCalls, 0);
		assert.equal(target.disk, projectsDoc("A"));
	});

	it("fails when transform throws on the fresh contents", async () => {
		const edited = projectsDoc("A", "A line typed while the scan ran.");
		const target = new FakeTarget(projectsDoc("A"));
		target.beforeProcess = (fake) => {
			fake.disk = edited;
		};
		let calls = 0;

		const outcome = await atomicUpdate(
			target,
			(doc) => {
				calls++;
				if (calls === 1) {
					// The snapshot transforms fine, which is what makes the write look worth doing.
					return replaceSection(doc, "projects", "B");
				}
				throw new Error("a marker in the fresh body");
			},
			CREATE,
		);

		assert.deepEqual(outcome, { status: "failed" });
		assert.equal(target.disk, edited);
	});

	it("fails when process rejects for an I/O error", async () => {
		const target = new FakeTarget(projectsDoc("A"));
		target.processError = new Error("write denied");

		const outcome = await atomicUpdate(
			target,
			(doc) => replaceSection(doc, "projects", "B"),
			CREATE,
		);

		assert.deepEqual(outcome, { status: "failed" });
	});

	it("fails when the initial read rejects", async () => {
		const target = new FakeTarget(projectsDoc("A"));
		target.readError = new Error("unreadable");

		const outcome = await atomicUpdate(target, (doc) => doc, CREATE);

		assert.deepEqual(outcome, { status: "failed" });
	});

	it("fails when the guard throws on the snapshot", async () => {
		const target = new FakeTarget(projectsDoc("A"));

		const outcome = await atomicUpdate(target, (doc) => doc, {
			missing: "create",
			guard: () => {
				throw new Error("guard bug");
			},
		});

		assert.deepEqual(outcome, { status: "failed" });
		assert.equal(target.processCalls, 0);
	});

	it("fails when create rejects and the re-read also rejects", async () => {
		const target = new FakeTarget(null);
		target.createError = new Error("create failed");
		target.beforeCreate = (fake) => {
			fake.readError = new Error("read failed");
		};

		const outcome = await atomicUpdate(target, () => "new", CREATE);

		assert.deepEqual(outcome, { status: "failed" });
		assert.equal(target.createCalls, 1);
	});

	it("preserves the refusal reason", async () => {
		const target = new FakeTarget(projectsDoc("A"));

		const outcome = await atomicUpdate(target, (doc) => doc, {
			missing: "create",
			guard: () => "not ours",
		});

		assert.deepEqual(outcome, { status: "refused", reason: "not ours" });
	});
});
