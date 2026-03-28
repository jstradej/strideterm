import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/",
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
    files: ["src/**/*.{js,vue}"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // --- Backend (Node.js) ---
  {
    files: ["electron/**/*.js", "config/**/*.js", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },

  // --- Tests ---
  {
    files: ["**/*.test.js", "test/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // --- Config files (Node) ---
  {
    files: ["*.config.js", "*.config.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
];
