# Gitdeck submission checklist

Working document. Not part of the plugin release.

- **Target:** first public release, `1.0.0`
- **Status:** code complete; packaging and clean-vault QA remaining
- **Last updated:** 2026-11-08
- **Plugin id:** `gitdeck`
- **Display name:** `Gitdeck`
- **Platform:** desktop only
- **Repo:** `https://github.com/J0na555/gitdeck`

## How to use this file

- **P0** items block the release. Do not tag `1.0.0` until they are all checked.
- **P1** items should be fixed before submission if possible. They are likely review findings.
- **P2** items are polish. They can wait until after the first release.
- A checked box means the work is done and verified, not just written.

## Current state

Verified locally on 2026-11-08 unless stated otherwise.

- 747 unit tests pass (`pnpm test`, 139 suites).
- `pnpm typecheck` passes.
- `pnpm lint` reports 0 errors and 8 warnings. The warnings are official Obsidian rules: four sentence-case false positives, three deprecated `display()` calls, and the missing declarative settings API for Obsidian 1.13.
- `pnpm build` reproduces `main.js` byte for byte (`9cc57f09...` across two runs).
- `pnpm install --frozen-lockfile` passes with pnpm 12.4.1.
- `LICENSE` is MIT.
- CI (`.github/workflows/ci.yml`) runs install, typecheck, test, lint, and production build on pushes to `master` and on pull requests. First live run passed on 2026-11-08 (run 42468140632).
- Release workflow (`.github/workflows/release.yml`) triggers on semver tags, reuses the CI workflow, checks the tag against `manifest.json`, attests provenance, and uploads `main.js`, `manifest.json`, and `styles.css` as separate assets. Written but not yet exercised on GitHub.
- No git tags and no GitHub releases.
- `manifest.json` and `package.json` are at `1.0.0`. `versions.json` maps `1.0.0` to `1.7.2`.
- `test_space.ts` and `idea.md` are removed. `FEATURE-PLAN.md` is gitignored.
- Repo renamed to `J0na555/gitdeck` on 2026-11-08. The local remote and README issue link point at the new name.
- Installed-build smoke test: the current build replaced the Oct 19 build in the user's vault. Scan, dashboard note, weekly note, and pin all survived the reload. State migrated from basename keys to absolute-path keys; one stale `previousDirty` key (`api`) remains for a repo no longer under the scan root.
- The submission process changed in May 2026. There is no pull request to `obsidianmd/obsidian-releases` any more. Submit through `https://community.obsidian.md`.

---

# P0: release blockers

## 1. Fix duplicate repo basenames in state

**Risk:** pins, dirty history, and AI summary freshness are keyed by directory basename. Two repos named `api` under different parents silently share state. Pinning one moves both. Generating a summary for one can overwrite the other.

- [x] Decide between path-keyed state and a documented limitation.
- [x] Recommended: key pins, `previousDirty`, and summaries by repo path.
- [x] Add a one-time migration from the old name-keyed `data.json` shape.
- [x] Keep the display name as the basename, but never use it as the identity key.
- [x] Add tests with two repos that share a basename under different parents.
- [x] Verify pinning, unpinning, dirty history, and summary freshness do not cross over.

**Files:** `src/git.ts`, `src/machine-state.ts`, `src/main.ts`, `src/types.ts`, `src/dashboard.ts`, `src/vault.ts`.

**Acceptance:** two repos named `api` keep separate pins, dirty history, summary freshness, and summary text. Note linking and visible disambiguation are tracked as a P1 follow-up.

## 2. Stop probing AI CLIs automatically on first load

**Risk:** when the detection cache is empty or stale, `onload` runs a real capability prompt against gemini, codex, and opencode. That can make three model calls, use quota, and trigger auth prompts before the user opts in.

- [x] Remove the `detectionIsStale()` probe from `onload`.
- [x] Probe only when the user opens the AI settings section or presses Retest.
- [ ] If automatic probing is kept, disclose it in the README and show a notice before the first call. Not applicable: the automatic probe on load was removed, so probing happens only when the settings tab opens or Retest is pressed.
- [x] Make the first-run state clear: "No provider tested yet" instead of silently probing.
- [x] Add a test for the fresh-install path with no cached probes.

**Files:** `src/main.ts`, `src/provider.ts`.

**Acceptance:** a fresh install with no user action makes zero AI CLI calls.

## 3. Make dashboard and weekly writes atomic

**Risk:** `syncDashboard`, `syncWeekly`, and `upsertSummary` (which writes the same dashboard) read the file, build new content, then write. A user edit outside the markers between the read and the write can be overwritten. This breaks the plugin's promise that everything outside the markers is untouched.

- [x] Replace read-then-modify with `vault.process` for the dashboard.
- [x] Replace read-then-modify with `vault.process` for the weekly note.
- [x] Keep the marker replacement inside the atomic callback.
- [x] Re-resolve the file immediately before the atomic call; a delete or rename fails safely instead of writing elsewhere.
- [x] Add a test where the file changes between read and write.
- [x] Verify `Vault.process` exists at the declared `minAppVersion`. It is `@since 1.1.0` and `minAppVersion` is `1.5.0`, so no bump.

**Files:** `src/atomic-write.ts`, `src/atomic-write.test.ts`, `src/vault.ts`, `src/main.ts`, `SUBMISSION.md`. No `manifest.json` change.

**Acceptance:** a user editing outside the markers while a scan runs never loses text.

The pure tests cover the interleaving: concurrent edits outside a section, a no-op snapshot, a race where the fresh contents already match, create races, guard refusals, and transform failures. A real Obsidian vault test is still required for open editor buffers, identical-content writes, create races, rename/delete, and two concurrent writers. That verification is not done.

## 4. Add the required README disclosures

**Risk:** the directory rules require clear disclosure of network use, external services, and access to files outside the vault. The current README only mentions `git`.

- [x] Add a section covering network use.
- [x] Name every CLI used for summaries: gemini, codex, opencode.
- [x] State exactly what is sent: project name, absolute repo path, remote URL, branch names, default branch, last commit date, dirty count, dirty file paths, and recent commit subjects.
- [x] State clearly that no vault note contents are sent.
- [x] State that the provider CLI runs with the repo as its working directory and may be able to read files in that repo.
- [x] State that the plugin does not store API keys. The CLI handles its own authentication.
- [x] State that the first run may test provider CLIs if automatic probing is kept. Automatic probing is not kept, so the README says nothing is tested on startup; tests run when the settings tab is opened or Retest is pressed.
- [x] Add an **Access outside the vault** section. Explain that the scan root and repo paths are outside the vault by design.
- [x] Name the local files the plugin writes: `data.json`, `startup.log`, and `errors.log` in the plugin folder, plus the dashboard and weekly notes in the vault.
- [x] Confirm there is no client-side telemetry, no ads, and no self-update.
- [x] Add a **Privacy** section that summarises the above.

**Acceptance:** a reviewer can read the README and know exactly what leaves the machine and what files the plugin touches.

## 5. Add a LICENSE file

- [x] Add `LICENSE` with the MIT license.
- [x] Use `Copyright (c) 2026 J0na555`.
- [ ] Confirm GitHub reports the license as MIT. This needs a push and a GitHub check.
- [x] Keep `package.json` `"license": "MIT"` consistent.

**Acceptance:** repo root contains `README.md`, `LICENSE`, and `manifest.json`.

## 6. Fix the README contradictions

- [x] Change "owns exactly one file" to "owns one dashboard note, plus optional weekly notes."
- [x] Change "does not create notes" to "does not create per-project notes."
- [x] Replace "v0.1" with "earlier development builds" or remove the section if `0.1.0` was never distributed.
- [x] Add an install section for the community directory and a manual install section.
- [x] Add a compatibility section: desktop only, requires git on PATH.
- [x] Add a support section with the GitHub issues URL.
- [ ] Add screenshots or a short GIF to the README. A GUI capture is required, so this is not done.
- [ ] Upload up to 5 screenshots at 1200x800 in the community dashboard. This requires a GUI capture and the web dashboard.

**Acceptance:** the README describes what the plugin writes and how to install it without ambiguity.

## 7. Fix settings headings for official lint

**Risk:** raw `createEl("h2")` and `createEl("h3")` inside `PluginSettingTab` trigger `obsidianmd/settings-tab/no-manual-html-headings`.

- [x] Remove the top-level "Gitdeck" heading from the settings tab.
- [x] Replace section headings with `new Setting(containerEl).setName("...").setHeading()`.
- [x] Keep the "Opening a project" and "Score weights" sections.
- [x] Run the official ESLint plugin and confirm no errors remain. Done in item 12: 0 errors, 45 reviewed warnings, all P1 lint work pinned in `eslint.config.mjs`.

**Files:** `src/main.ts`.

**Acceptance:** the settings tab uses Obsidian's settings heading component.

## 8. Rename the command id and command name

**Risk:** the command id contains the plugin id, and the palette shows "Gitdeck: Open Gitdeck."

- [x] Change command id `open-gitdeck` to `open` or `open-panel`.
- [x] Change the command name to "Open panel" or "Open Gitdeck panel."
- [x] Update the README usage line.
- [x] Confirm no other command id contains `gitdeck`.

**Files:** `src/main.ts`, `README.md`.

**Acceptance:** the command palette reads naturally and the id does not duplicate the plugin id.

## 9. Fix the rename parser for `git status -z`

**Risk:** `git status --porcelain -z` emits `RM new.txt\0old.txt\0`. The current parser treats the old path as a separate entry and slices two status characters from it, producing a truncated extra dirty path in the AI prompt.

- [x] Parse the NUL stream with an index loop.
- [x] When the status contains `R` or `C`, consume and skip the following old-path field.
- [x] Add a real `git mv` test for `buildGitContext`.
- [x] Confirm `dirtyFiles` count agrees with `dirtyCount`.

**Files:** `src/context.ts`, `src/context.test.ts`.

**Acceptance:** a renamed file appears once in the prompt, with the new path.

## 10. Remove scratch files and pin dependencies

- [x] Delete `test_space.ts`. Backed up to `/tmp/opencode/test_space.ts.bak` before removal.
- [x] Delete `idea.md` from the tracked repo. Keep a local copy if wanted. Backed up to `/tmp/opencode/idea.md.bak`.
- [x] Keep `FEATURE-PLAN.md` as working notes, but do not ship it. It is already gitignored.
- [x] Pin `obsidian` to the version in `pnpm-lock.yaml` instead of `latest`. Pinned to `1.13.1`.
- [x] Add an `engines` field for the Node version used by tests, or add `.nvmrc`. Added both: `.nvmrc` `26.12.0`, `engines.node` `>=26`, plus `packageManager` `pnpm@12.4.1`.
- [x] Confirm `pnpm-workspace.yaml` is actually required. Remove it if it is not. Required: it allows the esbuild install script under pnpm 10+.
- [ ] Update the GitHub repository description. It currently describes an unfinished tracker.

**Acceptance:** the repo has no scratch scripts and the dependency set is reproducible.

## 11. Rename the GitHub repository before tagging

- [x] Rename `J0na555/Radar` to `J0na555/gitdeck`. Done by the user on 2026-11-08.
- [ ] Confirm the old URL redirects. `curl` could not reach GitHub from here (504), so this is unverified. GitHub normally redirects a renamed repo.
- [x] Update the remote URL locally. `origin` is `git@github.com:J0na555/gitdeck.git`; `git ls-remote origin` returns `master`.
- [x] Update any README, manifest, or issue links that point at the old name. `README.md` issues link updated. `manifest.json` points at the profile, not the repo.
- [ ] Do this before creating the first tag and release. Rename is done; the tag is still pending.

**Acceptance:** the public repo name matches the plugin name before the first release.

## 12. Add CI and run the official lint

- [x] Add the official `obsidianmd/eslint-plugin` and a lint script. `eslint-plugin-obsidianmd` is a dev dependency and `pnpm lint` runs `eslint .`.
- [x] Run it on the repo. Fix every error. Review every warning. 0 errors after the fixes in this pass. Remaining warnings map to P1 #15 (bare timers), #16 (native DOM), and four sentence-case false positives (git, CLI, Dashboard.md). Re-run on 2026-11-08: 0 errors, 8 warnings.
- [x] Add a CI workflow on push and pull request. `.github/workflows/ci.yml`, on `master` and pull requests. First live run passed on 2026-11-08.
- [x] CI must run typecheck, tests, lint, and production build. All four steps are in the workflow.
- [x] Pin the Node version used by CI. The TypeScript tests need a recent Node with type stripping. `.nvmrc` `26.12.0`, used by both workflows.
- [x] Run `pnpm install --frozen-lockfile`. Verified locally on 2026-11-08 with pnpm 12.4.1; both workflows use it.
- [x] Add a release workflow that depends on the CI gate. `.github/workflows/release.yml` calls the CI workflow as a reusable job. First tag run is pending.
- [x] The release workflow must build and upload `main.js`, `manifest.json`, and `styles.css` as separate assets. `gh release create` lists all three.
- [x] Enable artifact attestation if available. `actions/attest-build-provenance@v2` covers all three assets. Not yet exercised.

**Acceptance:** a tag cannot produce a release unless tests, typecheck, lint, and build pass.

## 13. Version and release metadata

- [x] Bump `manifest.json` to `1.0.0`.
- [x] Bump `package.json` to `1.0.0`.
- [x] Add `"1.0.0": "1.5.0"` to `versions.json`. Do not overwrite existing entries. Added `"1.0.0": "1.7.2"`; the 0.1.0 entry stays at 1.7.2.
- [ ] Confirm the tag is exactly `1.0.0`, with no `v` prefix.
- [ ] Confirm the tag matches `manifest.json` exactly.
- [x] Confirm `minAppVersion` covers every API used, including `Vault.process`. Bumped `1.5.0` to `1.7.2`: `Workspace.revealLeaf` needs 1.7.2 and `View.scope` needs 1.5.7.
- [x] Keep `isDesktopOnly: true`. Confirmed.
- [x] Confirm the description is under 250 characters, ends with a period, and has no emoji. 81 characters, ends with a period.
- [x] Confirm the plugin id is `gitdeck`, lowercase, no `obsidian`, no trailing `plugin`. Confirmed.
- [ ] Confirm the display name `Gitdeck` is unique in the directory before submitting.
- [ ] Remember: the id cannot be changed after publication.

**Acceptance:** `manifest.json`, `package.json`, `versions.json`, and the git tag all agree on `1.0.0`.

---

# P1: likely review warnings

## 14. Replace the copied `normalizePath`

- [x] Import `normalizePath` from `obsidian` in production code. `vault.ts` already did; `main.ts` now imports it too, and every pure path function takes the normalizer as an argument instead of importing a copy.
- [x] Keep a test-only copy or inject the function for tests. `src/normalize.ts` owns the injection contract. `src/obsidian-compat.ts` is the test copy and is imported only by `*.test.ts` files.
- [x] Add cases for `..`, backslashes, repeated slashes, non-breaking spaces, and NFC. `src/obsidian-compat.test.ts`. It also pins the two details the old copy got wrong: `..` stays unresolved (as Obsidian does) and U+202F is replaced while U+2009 is not.
- [x] Add tests for `src/obsidian-compat.ts`. 8 cases in `src/obsidian-compat.test.ts`.

**Files:** `src/obsidian-compat.ts`, `src/normalize.ts`, `src/vault.ts`, `src/main.ts`.

## 15. Replace bare timers

- [x] Use `window.setTimeout` and `window.clearTimeout` in `src/provider.ts`. Not possible: this module runs under `node --test`, where `window` is undefined. Suppressed for `src/provider.ts` in `eslint.config.mjs` with the reason instead.
- [x] Keep the timer type correct. Types stay `NodeJS.Timeout`, unchanged.
- [x] If a bare timer is required for a Node child-process context, add a narrow disable comment with the reason. Done as a config override for `src/provider.ts`; a file comment was rejected by `eslint-comments/no-restricted-disable`.

## 16. Reduce native DOM creation warnings

- [x] Prefer `doc.win.createDiv`, `doc.win.createSpan`, and `doc.win.createEl` where practical. Not practical here: the three DOM modules are driven by a fake `Document` under `node --test`, and Obsidian helpers only exist after Obsidian patches the DOM.
- [x] Update the test doubles if the DOM surface changes. No DOM surface change, so no test-double change.
- [x] Do not add a heavy test dependency just to satisfy this warning. No dependency added.
- [x] If the `Document` parameter is deliberate for testability, document the choice and suppress narrowly. Documented at the top of `panel-header.ts` and in `eslint.config.mjs`; suppressed for `panel-header.ts`, `row-controls.ts`, and `panel-body.ts`.

**Files:** `src/panel-header.ts`, `src/row-controls.ts`, `src/panel-body.ts`.

## 17. Reduce console logging

- [x] Keep error logging only where it helps diagnose a failed startup or provider call. The only remaining `console.error` is `StartupLog.fail`, which records a step that threw during `onload`.
- [x] Remove or guard non-error logging. No `console.log`, `console.warn`, `console.info`, or `console.debug` in `src/` or the build config.
- [x] Confirm `test_space.ts` is gone, since it logs to the console. No such file in the repository.

## 18. Bound the settings tab freeze

**Risk:** `probeProvider` uses `spawnSync` with a 10 second timeout and is called three times while the settings tab renders. A hanging CLI can freeze the settings tab for up to 30 seconds.

- [x] Make the settings probe asynchronous, or run it only on the Retest button. The three `--version` checks now use `probeProviderAsync`; the capability pass already used `probeCapabilityAsync`.
- [x] Show a progress state while probing. Version rows read `Installed: checking…`, and the detection note reads `Testing the providers now…` while the open-tab pass runs.
- [x] Keep the 10 second per-provider timeout. `VERSION_TIMEOUT_MS = 10_000`, unchanged.
- [x] Test with a fake CLI that hangs. `probeProviderAsync` test stubs `gemini` as `sleep 30` and asserts the 1s test limit returns a timeout verdict, not a rejection or a blocked process.

**Files:** `src/main.ts`, `src/provider.ts`, `src/weight-settings.ts`.

## 19. Bound the scan freeze

**Risk:** 46 repos took about 3.1 seconds in a real measurement, with roughly nine `spawnSync` git calls per repo on the main thread. `onOpen` awaits the scan, so a restored Gitdeck pane blocks Obsidian at startup. The spinner does not paint before the block.

- [x] Yield one macrotask before `scanProjects` so the panel paints. `scanProjects` awaits a macrotask before walking the root; the view's pre-scan render now reaches the screen.
- [ ] Re-measure on a clean machine with a fixed repo count. On this machine, 46 repos: the old synchronous scan took 1.95-2.03s with zero timer ticks; the async scan takes 1.49-1.74s with about 98 ticks. A clean-machine run is still pending.
- [x] Resolve the contradiction with `FEATURE-PLAN.md`, which claims 0.17 seconds for a 45-repo scan. Corrected: the 0.17s figure was stale. A 46-repo scan is about 2s synchronously on this machine.
- [x] Decide whether the async scan ships in `1.0.0` or is disclosed as a known limitation. It ships in `1.0.0`.
- [x] If deferred, add a known-limitations section to the README and release notes. Not deferred.
- [x] Recommended: make the scan async before `1.0.0`. It removes the startup freeze instead of documenting it. `git`, weekly counts, and summary head reads now use `execFile`.

**Files:** `src/git.ts`, `src/main.ts`, `src/vault.ts`, `src/machine-state.ts`.

## 20. Add tests for untested modules

Ordered by risk.

- [ ] `src/vault.ts`: dashboard writes, weekly writes, folder creation, marker preservation, legacy note reads, summary state. Highest risk because this writes user files.
- [ ] `src/main.ts`: extract and test settings load, migration, and pure scan orchestration.
- [x] `src/format.ts`: pipe escaping, newlines, CRLF, missing dates, invalid dates, wikilink escaping. Covered by `src/format.test.ts`.
- [x] `src/summary.ts`: null HEAD, dirty-count changes, special characters, stale detection. Covered by `src/summary.test.ts`.
- [x] `src/context.ts`: the `git mv` rename case. Covered by `src/context.test.ts`.
- [x] `src/obsidian-compat.ts`: path normalisation. Covered by `src/obsidian-compat.test.ts`.
- [ ] `src/note-open.ts`: missing file, null project, missing summary target, mock `Notice` and workspace.

Do not add a GUI test dependency unless a real failure proves it is needed.

## 21. Add a notice for a foreign weekly file

**Risk:** if a file already exists at the weekly path without the plugin's markers, `syncWeekly` returns `null` with no message. A user who already uses core weekly notes turns the setting on and sees nothing happen.

- [x] Detect the foreign-file case. `weeklySectionState` returns `foreign` for a file with no weekly section and `broken` for an unpaired start marker.
- [x] Show one notice explaining that the file was left alone and why. `GitdeckPlugin.reportWeeklyOutcome` shows one persistent notice per path per session; the two reasons get different wording.
- [x] Do not overwrite the file. `syncWeekly` keeps `missing: "create"` and refuses with the guard reason; `atomicUpdate` never writes a refused document.
- [x] Add a test. `src/week.test.ts` covers `ours`, `foreign`, and `broken`.

**Files:** `src/vault.ts`, `src/main.ts`, `src/week.ts`.

## 21a. Disambiguate duplicate basenames in the panel and note links

**Risk:** pins, dirty history and summary state are keyed by path now, but the panel still shows two rows with the same name and note linking resolves by basename. A user with two `api` repos cannot tell the rows apart and can open the wrong note.

- [x] Match notes by `repo_path` before falling back to the basename. `NoteCandidate.repoPath` is read from frontmatter and compared with `projectKey`; relative paths are ignored because they name no machine.
- [x] Show a parent-folder qualifier when two visible projects share a basename. `duplicateNameQualifiers` runs over visible rows only; the row renders the qualifier in a muted span.
- [x] Add tests for both. `src/note-link.test.ts` covers repo-path binding and precedence; `src/identity.test.ts` covers the qualifier map.

**Files:** `src/note-link.ts`, `src/row-controls.ts`, `src/panel-body.ts`, `src/view.ts`, `src/identity.ts`.

---

# P2: polish after the first release

- [ ] Move more repeated UI strings into constants.
- [ ] Review sentence case in buttons and menu items.
- [ ] Review `onunload`. It currently does nothing. Confirm no listeners or resources leak.
- [ ] Confirm no default hotkeys are registered.
- [ ] Confirm no `workspace.activeLeaf` usage.
- [ ] Confirm no `innerHTML`, `outerHTML`, `eval`, or `new Function`.
- [ ] Confirm no dynamic ads, no static ads, no telemetry, no self-update.
- [ ] Confirm all child processes use argv arrays, never a shell string.
- [ ] Confirm `cwd` is always an explicit repo path for generation.
- [ ] Review the AI output path for marker injection. The writer should refuse a body containing markers.
- [ ] Add a changelog for future releases.
- [ ] Add a release notes template.

---

# Testing plan

Do not test features one by one in UI order. Test by risk, in layers.

## Layer 0: automated gate

- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] official Obsidian ESLint plugin, no errors (8 warnings)
- [x] confirm the build output is byte-for-byte reproducible
- [ ] confirm the release workflow is gated on all of the above. Configured: `release.yml` calls `ci.yml` and depends on it. A live tag run is still pending.
- [x] confirm CI uses a pinned Node version that discovers `*.test.ts` (`node-version-file: .nvmrc`, Node 26.12.0)

## Layer 1: clean-vault smoke test

Use the actual release assets, not a dev build.

- [ ] Create a fresh vault.
- [ ] Create `.obsidian/plugins/gitdeck/`.
- [ ] Copy `main.js`, `manifest.json`, and `styles.css` from the release.
- [ ] Enable the plugin.
- [ ] Confirm the ribbon icon and command appear.
- [ ] Open the panel.
- [ ] Confirm the scan runs and the panel renders.
- [ ] Confirm `Dashboard.md` is created in the configured folder.
- [ ] Pin one project.
- [ ] Reorder one pinned project.
- [ ] Generate one summary with a working provider.
- [ ] Confirm the summary appears in the dashboard.
- [ ] Generate one summary with a broken provider.
- [ ] Confirm the failure notice and `errors.log`.
- [ ] Toggle the weekly note on.
- [ ] Confirm the weekly file is created.
- [ ] Reload Obsidian.
- [ ] Confirm pins, summaries, and settings survive.

## Layer 2: data safety

- [ ] Write custom text above and below the dashboard markers. Run a scan. Confirm the text is preserved.
- [ ] Write custom text above and below the weekly markers. Run a scan. Confirm the text is preserved.
- [ ] Add an unpaired start marker. Confirm the plugin appends a safe new section instead of deleting text.
- [ ] Make the vault read-only. Confirm the plugin fails with a clear notice and does not corrupt the file.
- [ ] Run a scan and a summary generation at the same time. Confirm both writes survive.
- [ ] Create two repos with the same basename under different parents. Confirm pins and summaries stay separate.
- [ ] Put a foreign `2026-W43.md` at the weekly path. Confirm it is not overwritten and a notice is shown.
- [ ] Test a week that crosses a year boundary.
- [ ] Test a 53-week ISO year.
- [ ] Turn weekly notes off. Confirm existing weekly files are not deleted.
- [ ] Corrupt `data.json` and reload. Confirm the plugin falls back to defaults without crashing.
- [ ] Delete the dashboard and reload. Confirm the plugin recreates it or reports the failure clearly.

## Layer 3: environment edge cases

- [ ] No git installed.
- [ ] Scan root missing.
- [ ] Scan root not readable.
- [ ] Repo path with spaces.
- [ ] Repo path with non-ASCII characters.
- [ ] Repo with no commits.
- [ ] Detached HEAD.
- [ ] Worktree.
- [ ] Submodule.
- [ ] Symlinked repo.
- [ ] Very large repo.
- [ ] Repo with a huge dirty file count.
- [ ] Missing AI provider.
- [ ] Provider that hangs past the timeout.
- [ ] Commit subject with quotes, newlines, and leading dashes.
- [ ] A commit subject that looks like a prompt injection.

## Layer 4: platform and UI

- [ ] Linux install and full smoke test.
- [ ] Windows install and full smoke test.
- [ ] macOS install and smoke test, or state that it is untested.
- [ ] Light theme.
- [ ] Dark theme.
- [ ] High contrast theme.
- [ ] Narrow right sidebar, around 300px.
- [ ] Keyboard shortcuts: j, k, arrows, Enter, s, p, r, /, Escape.
- [ ] Context menu actions.
- [ ] Confirm mobile install is blocked by `isDesktopOnly`.

## Manual QA record

Copy this table into the release PR or a pinned issue and fill it in.

| Area | Test | Platform | Result | Notes |
| --- | --- | --- | --- | --- |
| Install | Fresh vault, release assets | Linux |  |  |
| Install | Fresh vault, release assets | Windows |  |  |
| Install | Upgrade from old `project-tracker` folder | Linux |  |  |
| Install | Upgrade existing vault to current build | Linux | pass | 2026-11-08. Panel, dashboard note, weekly note, and pin survived reload. State migrated to path keys. |
| Scan | Empty scan root | Linux |  |  |
| Scan | 46 real repos | Linux |  |  |
| Scan | Port with spaces and non-ASCII | Linux |  |  |
| Dashboard | Create and preserve user text | Linux |  |  |
| Dashboard | Unpaired marker | Linux |  |  |
| Weekly | Off by default | Linux |  |  |
| Weekly | Enable and write | Linux |  |  |
| Weekly | Foreign file at path | Linux |  |  |
| AI | Successful real generation | Linux |  |  |
| AI | Broken provider | Linux |  |  |
| AI | Timeout | Linux |  |  |
| State | Duplicate basename | Linux |  |  |
| UI | Keyboard shortcuts | Linux |  |  |
| UI | Dark theme and narrow sidebar | Linux |  |  |
| Load | Reload with pane open | Linux |  |  |
| Load | Startup time with pane open | Linux |  |  |

---

# Release sequence

Run this in order. Do not skip steps.

1. Rename the GitHub repo `Radar` to `gitdeck`. Done 2026-11-08.
2. Update the local remote URL. Done 2026-11-08.
3. Finish every P0 item above.
4. Run the full automated gate.
5. Run the Layer 1 and Layer 2 manual tests and record the results.
6. Bump `manifest.json` to `1.0.0`.
7. Bump `package.json` to `1.0.0`.
8. Add `"1.0.0": "1.5.0"` to `versions.json`.
9. Run `pnpm build` one final time on the exact commit that will be tagged.
10. Commit all source changes.
11. Create the tag: `git tag -a 1.0.0 -m "1.0.0"`.
12. Push the commit and the tag.
13. Create a GitHub release for `1.0.0`.
14. Attach `main.js`, `manifest.json`, and `styles.css` as separate assets.
15. Do not attach a zip as the install artifact.
16. Enable artifact attestation if the workflow supports it.
17. Verify the release assets download individually and match the built files.
18. Verify the tag and `manifest.json` version match exactly.
19. Verify `main.js` is not committed to the repository.
20. Verify a fresh install from the release assets works one more time.

# Submission sequence

1. Sign in at `https://community.obsidian.md` with an Obsidian account.
2. Connect the GitHub account and verify repository ownership.
3. Add the plugin through the submission form.
4. Submit `https://github.com/J0na555/gitdeck`.
5. Wait for the automated review. It checks manifest, releases, source, and build verification.
6. Fix every error. Warnings do not block, but fix the ones that matter.
7. After a fix, create a new version, a new tag, and a new release. The review runs again for each version.
8. Once it passes, confirm the listing details, description, and screenshots.
9. Publish.
10. Confirm the plugin appears in Obsidian search within 24 hours.

# Official references

- Submit your plugin: `https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin`
- Submission requirements: `https://docs.obsidian.md/community-directory/submission-requirements-for-plugins`
- Developer policies: `https://docs.obsidian.md/community-directory/developer-policies`
- Manifest reference: `https://docs.obsidian.md/Reference/Manifest`
- Plugin guidelines: `https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines`
- GitHub Actions release workflow: `https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions`
- Official ESLint plugin: `https://github.com/obsidianmd/eslint-plugin`
- Community directory: `https://community.obsidian.md`

# Open decisions

- [ ] Did `0.1.0` ever leave this machine? If yes, keep it in `versions.json` and test the upgrade path. If no, treat `1.0.0` as the first release.
- [x] Key state by path, or document the duplicate-basename limitation? Path-keyed. Pins, `previousDirty`, and summaries use absolute paths, with a one-time migration from basename keys. Shipped and verified against the installed vault on 2026-11-08.
- [x] Ship the async scan in `1.0.0`, or ship the one-frame yield plus a known-limitations note? Async scan shipped. `src/git.ts` uses `execFile`, and the installed vault reload completed with the panel working.
- [ ] Do you have a Windows or macOS machine for a real install test?
- [x] Keep the repo name `Radar`, or rename it to `gitdeck`? Renamed to `J0na555/gitdeck` on 2026-11-08, before the first tag.
- [x] Keep automatic provider probing, or make it user-triggered? User-triggered. Probing runs only when the settings tab opens or Retest is pressed.

# Definition of done

- [ ] Every P0 item is checked.
- [ ] Official ESLint reports no errors.
- [ ] CI passes on the tagged commit.
- [ ] Clean-vault install from release assets passes on Linux.
- [ ] Data safety tests pass.
- [ ] One real AI generation succeeds and is inspected in the dashboard.
- [ ] README disclosures are complete.
- [ ] Tag, manifest, package, and versions agree.
- [ ] Release has the three separate assets.
- [ ] Manual QA record is filled in.
- [ ] Submission is complete and the automated review passes.
