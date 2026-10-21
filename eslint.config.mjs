import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "main.js.map", "node_modules/"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      // node:test tracks the promises returned by test()/describe(); the
      // callbacks are intentionally not awaited.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Test fixtures use literal vault paths and bare timers; production uses configDir and window timers.
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  {
    // provider.ts runs under `node --test` and in Node child-process contexts,
    // where `window` is undefined. Its timers bound CLI subprocesses, not UI,
    // so popout compatibility does not apply.
    files: ["src/provider.ts"],
    rules: {
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  {
    // These modules build DOM with plain createElement on purpose so a fake
    // Document can drive them under `node --test`; Obsidian's createEl helpers
    // only exist after Obsidian patches the DOM, and a header that throws while
    // drawing leaves an empty panel. See the comment at the top of panel-header.ts.
    files: ["src/panel-header.ts", "src/row-controls.ts", "src/panel-body.ts"],
    rules: {
      "obsidianmd/prefer-create-el": "off",
    },
  },
]);
