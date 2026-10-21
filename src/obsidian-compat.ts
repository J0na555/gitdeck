/**
 * Test-only copy of Obsidian's `normalizePath`.
 *
 * Production code imports the real function from `obsidian` and injects it into the pure
 * modules (`dashboardPath`, `weeklyPath`, `folderChoices`). `node --test` cannot load the
 * `obsidian` package, so the tests inject this copy instead.
 *
 * The semantics are Obsidian's, matched against its shipped bundle: collapse backslashes and
 * repeated slashes, strip leading and trailing slashes, turn an empty result into `/`, replace
 * the two non-breaking spaces with a normal space, then NFC-normalize. Parent segments (`..`)
 * are deliberately left alone because Obsidian leaves them alone; resolving them here would
 * make the test copy disagree with the API it stands in for.
 *
 * Not a production helper. Nothing outside `*.test.ts` imports this file.
 */

export function normalizePath(input: string): string {
	const collapsed = input
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "");
	const rooted = collapsed === "" ? "/" : collapsed;
	return rooted.replace(/\u00a0|\u202f/g, " ").normalize("NFC");
}
