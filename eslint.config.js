const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/', 'assets/', '.vercel/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  // Desliga as regras de estilo que conflitam com o Prettier — deve ficar por último.
  prettier,
];
