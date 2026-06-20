# 测试说明

## 运行方式

```bash
# 一键运行测试（自动处理原生模块 ABI 切换，无需手动 rebuild）
npm test

# 监听模式
npm test:watch

# UI 模式
npm test:ui

# 类型检查 + 测试
npm run verify
```

## 原生模块 ABI 自动处理

`better-sqlite3` 和 `sharp` 是原生模块，Electron 和 Node.js 使用不同的 ABI：

- **Electron 运行时**：ABI 130（由 `postinstall` 脚本通过 `electron-builder install-app-deps` 编译）
- **Node.js 运行时**（vitest）：ABI 137

`npm test` 会自动处理这个切换：

1. `scripts/pretest.mjs` 检测原生模块是否能被 Node.js require
2. 如果不能（ABI 不匹配），自动 `npm rebuild better-sqlite3 sharp`
3. 写入 `.test-rebuild-marker` 标记文件
4. vitest 运行测试
5. `scripts/posttest.mjs` 检测标记文件，自动 `npm run postinstall` 恢复 Electron ABI

**无需手动 rebuild**，直接 `npm test` 即可。

## 测试范围

| 文件 | 覆盖内容 |
|------|---------|
| `database.test.ts` | 照片删除、重复组清理、精确去重分组、文件夹删除、schema 初始化 |
| `hash.test.ts` | 文件哈希、pHash 生成、汉明距离、旧版 MD5 识别 |
| `thumbnail.test.ts` | 缩略图生成、并发去重、过期刷新、删除清理、统计 |
| `scanner.test.ts` | 推荐照片评分函数（GPS/文件大小/分辨率/文件名规范性） |

## 环境说明

- 使用 **vitest** + **Node 环境**
- 数据库使用临时目录的 SQLite 文件，测试结束后自动清理
- 文件系统使用 OS 临时目录，测试结束后自动清理
- 原生模块采用 `forks` 进程池运行，避免多线程初始化问题

## 注意事项

- 修改了 `electron/services/` 下的代码后，请先跑 `npm test` 验证。
- 提交前请确保 `npm run verify`（类型检查 + 测试）通过。
- 如果测试因 ABI 问题失败，删除 `.test-rebuild-marker` 文件后重试。
