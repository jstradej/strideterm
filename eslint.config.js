import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsRules = {
  // TypeScript handles undefined references better than ESLint's no-undef.
  "no-undef": "off",
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/no-explicit-any": "error",
};

export default [
  {
    ignores: [
      "dist/",
      "dist-electron/",
      "release/",
      "out/",
      "node_modules/",
      "playwright-report/",
      "test-results/",
      ".private/",
      ".strideterm/",
      "tree/",
    ],
  },

  js.configs.recommended,
  ...vue.configs["flat/recommended"],
  prettier,

  // --- Vue SFCs with TypeScript script blocks ---
  // eslint-plugin-vue handles the .vue file structure; we delegate the
  // <script setup lang="ts"> block to the TS parser via parserOptions.parser.
  {
    files: ["src/**/*.vue"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        project: "./tsconfig.frontend.json",
        extraFileExtensions: [".vue"],
      },
    },
    rules: tsRules,
  },

  // --- Frontend TS source files ---
  {
    files: ["src/**/*.ts", "src/**/*.d.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.frontend.json" },
    },
    rules: tsRules,
  },

  // --- Backend TS files ---
  {
    files: ["electron/**/*.ts", "config/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.backend.json" },
    },
    rules: tsRules,
  },

  // --- Test TS files ---
  {
    files: ["**/*.test.ts", "test/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.tests.json" },
    },
    rules: tsRules,
  },

  // --- Scripts MTS files ---
  {
    files: ["scripts/**/*.mts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.scripts.json" },
    },
    rules: tsRules,
  },

  // --- Shared rules ---
  {
    rules: {
      // Real bugs: these catch actual mistakes
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // Intentional patterns in our codebase
      "no-empty": ["error", { allowEmptyCatch: true }], // We use empty catch for "ignore if fails"
      "no-control-regex": "off", // ANSI escape regex patterns use control chars
      "no-console": "off", // Backend uses console.log/warn intentionally

      // Vue best practices
      "vue/multi-word-component-names": "off", // We have single-word components (App, etc.)
      "vue/no-v-html": "off", // Reviewed: we use v-html only with escapeHtml() sanitization
      "vue/require-default-prop": "off", // We use optional props without defaults
      "vue/require-prop-types": "off", // Consistent with our component style
      "vue/valid-v-on": "off", // We use @keydown.esc.window which is valid Vue 3

      // Vue formatting — handled by Prettier
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
    },
  },

  // --- Frontend (Vue + browser) ---
  {
    files: ["src/**/*.{js,ts,vue}"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // --- Backend (Node.js) ---
  {
    files: ["electron/**/*.{js,ts}", "config/**/*.{js,ts}", "scripts/**/*.{mjs,mts}"],
    languageOptions: { globals: { ...globals.node } },
  },

  // --- Tests ---
  {
    files: ["**/*.test.{js,ts}", "test/**/*.{js,ts}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // --- Config files (Node) ---
  {
    files: ["*.config.{js,ts}", "*.config.{mjs,mts}"],
    languageOptions: { globals: { ...globals.node } },
  },
];
