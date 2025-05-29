import { validateTestEnvironment } from './config.js';

/**
 * Global setup for E2E tests
 */
beforeAll(async () => {
  // Validate test environment before running tests
  validateTestEnvironment();
});

/**
 * Global teardown for E2E tests
 */
afterAll(async () => {
  // Any global cleanup if needed
});
