/** @type {import('jest').Config} */
module.exports = {
  // Shared configuration options
  verbose: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageReporters: ['text', 'lcov', 'html'],
  transformIgnorePatterns: ['node_modules/(?!(@azure|azure-|markdown-table))'],
  maxWorkers: '100%', // Enable parallel project execution
  testTimeout: 30000, // 30 second timeout for all tests

  // Multi-project configuration
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest/presets/default-esm',
      extensionsToTreatAsEsm: ['.ts'],
      testEnvironment: 'node',
      injectGlobals: true,
      roots: ['<rootDir>/tests/unit'],
      testMatch: ['**/tests/unit/**/*.test.ts'],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'ESNext',
              target: 'ES2022',
              moduleResolution: 'node',
            },
          },
        ],
      },
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
      setupFilesAfterEnv: ['<rootDir>/tests/unit/setup.ts'],
      maxWorkers: '100%', // Parallel execution for unit tests
    },
    {
      displayName: 'e2e',
      preset: 'ts-jest/presets/default-esm',
      extensionsToTreatAsEsm: ['.ts'],
      testEnvironment: 'node',
      injectGlobals: true,
      roots: ['<rootDir>/tests/e2e'],
      testMatch: ['**/tests/e2e/**/*.test.ts'],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'ESNext',
              target: 'ES2022',
              moduleResolution: 'node',
            },
          },
        ],
      },
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
      setupFilesAfterEnv: ['<rootDir>/tests/e2e/setup.ts'],
      maxWorkers: 1, // Run e2e tests sequentially to avoid conflicts
    },
  ],
};
