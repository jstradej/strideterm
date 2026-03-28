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
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-self-assign": "warn",
      "no-useless-assignment": "warn",
      "vue/preserve-caught-error": "off",
      "preserve-caught-error": "off",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],

      // Vue adjustments — our codebase uses these patterns intentionally
      "vue/multi-word-component-names": "off",
      "vue/no-v-html": "off",
      "vue/no-mutating-props": "warn",
      "vue/valid-v-on": "off",
      "vue/require-default-prop": "off",
      "vue/require-prop-types": "off",
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
