import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';

const sourceFiles = ['src/**/*.ts'];

// Keep both recommended presets intact. The TypeScript preset replaces core
// rules that cannot understand types, while tsc checks names and declarations.
export default [
    { ...js.configs.recommended, files: sourceFiles },
    ...typescript.configs['flat/recommended'].map(config => ({
        ...config,
        files: sourceFiles,
    })),
];
