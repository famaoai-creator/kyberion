module.exports = [
  {
    ignores: [
      "node_modules/",
      "**/node_modules/",
      "dist/",
      "coverage/",
      "evidence/",
      "work/",
      "**/*.ts",
      "scripts/_archive/",
      ".gemini/",
    ],
  },
  {
    files: ["**/*.cjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        // Node.js globals
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      // Security rules
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-throw-literal": "error",

      // Code quality
      "no-var": "warn",
      "prefer-const": "warn",
      "eqeqeq": ["warn", "always"],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],

      // Async best practices
      "no-return-await": "warn",
      "no-async-promise-executor": "error",
      "prefer-promise-reject-errors": "warn",

      // Additional safety
      "no-shadow": "warn",
      "no-param-reassign": "warn",
      "no-use-before-define": ["warn", { functions: false, classes: true }],
    },
  },
];
