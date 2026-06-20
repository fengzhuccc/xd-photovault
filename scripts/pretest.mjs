/**
 * 测试前置脚本：自动检测原生模块 ABI 并按需 rebuild。
 *
 * 痛点：better-sqlite3 / sharp 按 Electron ABI 编译，但 vitest 用 Node.js 运行，
 * ABI 不匹配会导致 require 失败。手动 rebuild + postinstall 来回切换很繁琐。
 *
 * 本脚本：
 * 1. 尝试 require better-sqlite3，如果失败（ABI 不匹配）则自动 rebuild。
 * 2. rebuild 后设置标记，posttest 脚本会据此恢复 Electron ABI。
 */
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const MARKER_FILE = join(process.cwd(), '.test-rebuild-marker');
const MODULES = ['better-sqlite3', 'sharp'];

function tryRequire(moduleName) {
  try {
    require(moduleName);
    return true;
  } catch (e) {
    // ABI 不匹配或其他加载错误
    return false;
  }
}

function needsRebuild() {
  for (const mod of MODULES) {
    if (!tryRequire(mod)) {
      return true;
    }
  }
  return false;
}

function main() {
  if (!needsRebuild()) {
    console.log('[pretest] 原生模块 ABI 匹配 Node.js，无需 rebuild');
    return;
  }

  console.log('[pretest] 原生模块 ABI 不匹配，正在为 Node.js rebuild...');
  for (const mod of MODULES) {
    console.log(`[pretest] rebuilding ${mod}...`);
    execSync(`npm rebuild ${mod}`, { stdio: 'inherit' });
  }

  // 写标记文件，posttest 据此恢复 Electron ABI
  writeFileSync(MARKER_FILE, String(Date.now()));
  console.log('[pretest] rebuild 完成，测试后将自动恢复 Electron ABI');
}

main();
