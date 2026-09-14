import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    // Playwright specs in e2e/ run in a real browser, not here.
    include: ['src/**/*.test.{js,jsx}'],
  },
}));
