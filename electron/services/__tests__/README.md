# 测试说明

## 运行方式

```bash
# 1. 由于 better-sqlite3 / sharp 等原生模块默认按 Electron ABI 编译，
#    运行单元测试前需要先按系统 Node ABI 重建：
npm rebuild better-sqlite3 sharp

# 2. 运行测试
npm test

# 3. 测试完成后，如果还要继续开发 Electron 应用或打包，
#    需要恢复为 Electron ABI：
npm run postinstall
```

## 测试范围

| 文件 | 覆盖内容 |
|------|---------|
| `database.test.ts` | 照片删除、重复组清理、精确去重分组、文件夹删除、schema 初始化 |
| `hash.test.ts` | 文件哈希、pHash 生成、汉明距离、旧版 MD5 识别 |
| `thumbnail.test.ts` | 缩略图生成、并发去重、过期刷新、删除清理、统计 |

## 环境说明

- 使用 **vitest** + **Node 环境**
- 数据库使用 `:memory:` 临时数据库
- 文件系统使用 OS 临时目录，测试结束后自动清理
- 原生模块采用 `forks` 进程池运行，避免多线程初始化问题

## 注意事项

- 修改了 `electron/services/hash.ts`、`database.ts`、`thumbnail.ts` 后，请先跑 `npm test` 验证。
- 提交前请确保 `npm run check` 和 `npm test` 都通过。
