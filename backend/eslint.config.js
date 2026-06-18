// Flat ESLint config (ESLint v9). Primary job: catch undefined references
// (no-undef) so a refactor that moves code between files can't silently
// leave a helper unimported. Run: npx eslint src
const globals = require('globals');

module.exports = [
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
    },
  },
];
