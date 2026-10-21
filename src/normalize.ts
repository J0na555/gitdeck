/**
 * Path helpers shared by the pure modules.
 *
 * `normalizePath` itself is injected rather than imported. Production passes Obsidian's
 * function, which the API requires for anything handed back to the vault. Tests pass the
 * copy in `obsidian-compat.ts`, because `node --test` cannot load the `obsidian` package.
 *
 * The wrappers here are ours, and they exist for two reasons Obsidian's function does not
 * cover: a settings folder may be empty (vault root), and Obsidian's normalizer turns the
 * empty string into `/`, which is not a vault path any of this code should build on.
 */

/** The normalizer both boundaries agree on. */
export type NormalizePath = (input: string) => string;

/**
 * Normalize a user-supplied folder, with the vault root spelled as the empty string.
 *
 * `.` and `/` mean the root too. Obsidian's own normalizer returns `/` for an empty input and
 * leaves `.` alone, so both are folded here rather than leaking a leading slash into every
 * joined path.
 */
export function normalizeFolder(input: string, normalize: NormalizePath): string {
	const trimmed = input.trim();
	if (trimmed === "") return "";
	const value = normalize(trimmed);
	return value === "/" || value === "." ? "" : value;
}

/** Join path segments, dropping the empty ones so a root folder does not add a slash. */
export function joinVaultPath(...parts: readonly string[]): string {
	return parts.filter((part) => part !== "").join("/");
}
