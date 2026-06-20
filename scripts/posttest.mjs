/**
 * 测试后置脚本：如果 pretest 做了 rebuild，恢复原生模块为 Electron ABI。
 *
 * 检测 .test-rebuild-marker 文件是否存在：
 * - 存在：说明 pretest rebuild 过，需要恢复 Electron ABI，然后删除标记。
 * - 不存在：说明没 rebuild 过，什么都不做。
 */
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MARKER_FILE = join(process.cwd(), '.test-rebuild-marker');

function main() {
  if (!existsSync(MARKER_FILE)) {
    return;
  }

  console.log('[posttest] 检测到测试前做过 rebuild，正在恢复 Electron ABI...');
  execSync('npm run postinstall', { stdio: 'inherit' });
  unlinkSync(MARKER_FILE);
  console.log('[posttest] Electron ABI 已恢复');
}

main();
