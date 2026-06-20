import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseService } from '../database';

export interface TestDatabase {
  db: DatabaseService;
  cleanup: () => void;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'photovault-test-'));
  const config = { getDataPath: () => tmpDir };
  const db = new DatabaseService(config);
  await db.initialize();

  return {
    db,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
    },
  };
}
