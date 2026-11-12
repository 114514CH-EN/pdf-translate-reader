// Only one job: React's rules of hooks. A hook placed after an early return passes the
// type checker and every short test, then blanks the page on a longer document (v1.8.0).
import parser from '@typescript-eslint/parser';
import hooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': hooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
];
