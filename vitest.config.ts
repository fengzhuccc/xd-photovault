import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    include: ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    // better-sqlite3 等原生模块在多线程 worker 中可能初始化异常，使用 forks 隔离进程
    pool: 'forks',
    singleFork: true,
  },
});
