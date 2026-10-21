import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "main.js.map", "node_modules/", "test_space.ts"],
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
]);
