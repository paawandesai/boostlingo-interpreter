import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: { ecmaVersion: 2023, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // docs/GUARDRAILS.md (Data): never log user text or transcripts. No console logging in app code.
      'no-console': 'error',
    },
  },
  {
    // Mode-agnostic UI: components talk to the session store and the Transport
    // interface only, never to a concrete transport's internals.
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Every concrete transport folder (translate, realtime, cascade and any added later);
              // the shared interface and the factory stay importable.
              group: ['**/transports/*', '**/transports/*/**', '!**/transports/types', '!**/transports/index'],
              message:
                'UI components must not import a concrete transport. Use the session store / Transport interface.',
            },
          ],
        },
      ],
    },
  },
)
