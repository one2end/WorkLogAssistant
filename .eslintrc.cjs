module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  overrides: [
    {
      files: ['*.vue'],
      parser: 'vue-eslint-parser',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      plugins: ['vue'],
      extends: ['plugin:vue/vue3-essential'],
      rules: { 'vue/multi-word-component-names': ['error', { ignores: ['Icon'] }] }
    }
  ]
};
