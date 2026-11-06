import js from '@eslint/js'
import globals from 'globals'

// Catches what `node --check` does not: undefined variables and unused imports.
export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['src/**/*.js', 'tests/**/*.js', '*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$|^req$|^res$', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
