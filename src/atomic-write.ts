/**
 * The read-modify-write a generated note needs, with the modify runs against the freshest
 * contents the vault has.
 *
 * Reading first, transforming, and then writing turns a user edit between the read and the
 * write into a deletion. The dashboard and weekly note sit in somebody's vault, so that edit is
 * not an edge case: it is what happens while a scan runs. The vault's own `process` re-reads
 * under its lock, and this module makes the marker replacement and the guards run in that
 * callback.
 *
 * Pure on purpose. No `obsidian` import, so `node --test` loads this directly. The vault side is
 * `noteTarget` in `vault.ts`.
 */

/** Where an atomic update reads from and writes to. */
export interface AtomicTarget {
	/** Current contents, or null when no regular file is known to the vault. */
	read(): Promise<string | null>;
	/** Re-read the file, call transform on the fresh contents, write and return the result. */
	process(transform: (fresh: string) => string): Promise<string>;
	create(content: string): Promise<void>;
}

/** What to do when nothing is at the path, and what may veto an existing document. */
export interface AtomicOptions {
	missing: "create" | "refuse";
	/** Return a reason to leave an existing document alone. Null means allowed. */
	guard?: (doc: string) => string | null;
}

/** What happened. Every outcome is a value; `atomicUpdate` never throws. */
export type AtomicOutcome =
	| { status: "unchanged"; content: string }
	| { status: "written"; content: string }
	| { status: "refused"; reason: string }
	| { status: "failed" };

/**
 * Update one document, transforming the freshest contents the vault gives us.
 *
 * Two transforms run. The first is on the snapshot, and only exists to answer "would anything
 * change?" without touching the file. It is never reused: the callback always transforms the
 * fresh contents again, because a concurrent edit may have moved the section, and replanting a
 * result computed from the old snapshot would overwrite exactly what this exists to keep.
 *
 * Refusal and no-change travel out of the callback as flags rather than exceptions. A throw in a
 * `process` callback may abort the write or may not, depending on the vault implementation, and
 * the arguments about which are not something this module can settle. Returning the fresh
 * contents unchanged is the one behaviour that means "leave the file alone" under both.
 */
export async function atomicUpdate(
	target: AtomicTarget,
	transform: (doc: string) => string,
	options: AtomicOptions,
): Promise<AtomicOutcome> {
	try {
		let snapshot = await target.read();

		if (snapshot === null) {
			if (options.missing === "refuse") return { status: "refused", reason: "missing" };

			let created: string;
			try {
				created = transform("");
			} catch {
				return { status: "failed" };
			}

			// The guard is deliberately not run here. A file that is not there has no foreign
			// content to protect, and a new weekly note must be allowed to be created. A create
			// that lost a race falls through and runs the guard on whatever appeared.
			try {
				await target.create(created);
				return { status: "written", content: created };
			} catch {
				try {
					snapshot = await target.read();
				} catch {
					return { status: "failed" };
				}
				if (snapshot === null) return { status: "failed" };
			}
		}

		if (snapshot === null) return { status: "failed" };

		if (options.guard) {
			let reason: string | null;
			try {
				reason = options.guard(snapshot);
			} catch {
				return { status: "failed" };
			}
			if (reason !== null) return { status: "refused", reason };
		}

		let planned: string;
		try {
			planned = transform(snapshot);
		} catch {
			return { status: "failed" };
		}
		if (planned === snapshot) return { status: "unchanged", content: snapshot };

		let refusal: string | null = null;
		let failedInside = false;
		let noChange = false;

		let writtenText: string;
		try {
			writtenText = await target.process((fresh) => {
				if (options.guard) {
					let reason: string | null;
					try {
						reason = options.guard(fresh);
					} catch {
						failedInside = true;
						return fresh;
					}
					if (reason !== null) {
						refusal = reason;
						return fresh;
					}
				}

				let next: string;
				try {
					next = transform(fresh);
				} catch {
					failedInside = true;
					return fresh;
				}

				if (next === fresh) {
					noChange = true;
					return fresh;
				}

				return next;
			});
		} catch {
			return { status: "failed" };
		}

		if (refusal !== null) return { status: "refused", reason: refusal };
		if (failedInside) return { status: "failed" };
		if (noChange) return { status: "unchanged", content: writtenText };
		return { status: "written", content: writtenText };
	} catch {
		return { status: "failed" };
	}
}
