# PhotoVault 代码架构与方案规格

> 本文档记录当前代码中的核心设计方案、关键规格，以及修改时容易踩坑的脆弱点。修改对应模块前请先阅读本节。

---

## 一、项目结构

```
photovault/
├── electron/                  # Electron 主进程
│   ├── main.ts                # 主进程入口：服务初始化、IPC 注册、启动恢复
│   ├── preload.ts             # 预加载脚本：定义前端可调用的 IPC API
│   └── services/
│       ├── database.ts        # SQLite 数据库服务
│       ├── scanner.ts         # 文件夹扫描服务
│       ├── hash.ts            # 哈希计算服务（xxhash64 + pHash）
│       ├── exif.ts            # EXIF 提取服务
│       └── thumbnail.ts       # 缩略图生成与管理服务
├── src/                       # React 渲染进程
│   ├── App.tsx                # 应用根组件、路由、全局订阅
│   ├── pages/                 # 页面组件
│   │   ├── LibraryPage.tsx    # 照片库管理
│   │   ├── BrowsePage.tsx     # 照片浏览
│   │   ├── DuplicatesPage.tsx # 去重管理
│   │   ├── MapPage.tsx        # 地图展示
│   │   └── SettingsPage.tsx   # 设置
│   ├── stores/                # Zustand 全局状态
│   ├── components/            # 复用组件
│   └── types/index.ts         # TypeScript 类型定义
└── docs/                      # 项目文档
```

---

## 二、核心设计方案

### 2.1 服务生命周期

主进程启动顺序（`main.ts -> initializeServices`）：

1. `ConfigService` 初始化（先读取文件配置，后续再注入 DB 读取持久化配置）。
2. `DatabaseService` 初始化（创建/打开 SQLite，执行 migrations）。
3. `ConfigService.setDatabase(db)` 让配置可以从数据库读取。
4. `HashService`、`ExifService`、`ThumbnailService` 初始化。
5. `ScannerService` 初始化并注册去重进度回调。
6. 恢复中断扫描：`scanner.recoverInterruptedScans()`。
7. 恢复中断去重：如果 `duplicate_detection_dirty` 标记为 true，清理相似组。
8. 注册 IPC handlers。

**脆弱点**：
- `ConfigService` 初始化时先读文件，再读 DB，顺序不能颠倒。
- `ThumbnailService` 依赖 `ConfigService.getDataPath()`，必须在 `setDatabase` 之后创建。

---

### 2.2 数据库 Schema

#### 核心表

| 表名 | 说明 | 关键外键 |
|------|------|---------|
| `folders` | 照片文件夹 | — |
| `photos` | 照片元数据 | `folder_id -> folders(id) ON DELETE CASCADE` |
| `duplicate_groups` | 重复组 | `recommended_photo_id -> photos(id)`（**无 CASCADE**） |
| `photo_duplicates` | 照片与组的关联 | `photo_id -> photos(id) CASCADE`，`group_id -> duplicate_groups(id) CASCADE` |
| `app_settings` | 应用设置键值对 | — |
| `schema_version` | 数据库迁移版本 | — |

#### 脆弱点：重复组推荐照片外键

```sql
FOREIGN KEY (recommended_photo_id) REFERENCES photos(id)
```

**没有 `ON DELETE CASCADE`**。批量删除照片时，如果其中某张是某个重复组的 `recommended_photo_id`，删除会触发外键约束失败，整个批次回滚。

**正确做法**：删除前先把这些 `recommended_photo_id` 置为 NULL（见 `database.ts deletePhotosBatch`）。

---

### 2.3 扫描流程

`ScannerService.startScan(folderId, onProgress, forceRescan)`：

1. **收集文件**：`walkImageFiles` 递归遍历文件夹，得到所有图片路径数组。
   - 跳过系统目录：`$RECYCLE.BIN`、`System Volume Information`、`.Trashes`、`.Spotlight-V100`、`.fseventsd`、`@eaDir`、`.` 开头隐藏目录。
2. **空文件夹处理**：如果 `total === 0`，删除该文件夹在 DB 中残留的所有照片。
3. **分批处理**：每批 `PATH_BATCH_SIZE = 500` 个文件。
   - 查询这批路径在 DB 中的已有记录（`file_size`、`file_hash`、`modified_time`）。
   - 使用 2 worker 并发处理（`FILE_WORKER_CONCURRENCY = 2`）。
   - 判断文件是否变化：`fileSize + mtime` 都相同则跳过。
4. **删除不存在文件**：
   - 一次性查询该文件夹所有 DB 路径（`getAllPhotoPathsByFolder`）。
   - 对比 `seenPaths`，删除不在磁盘上的记录。
5. **更新统计**：`SELECT COUNT(*)` 获取文件夹照片数，更新 `last_scanned`。
6. **后台任务**：
   - 如果有新增/删除，触发精确去重。
   - 如果有新增照片，批量生成缩略图。

#### 脆弱点

| 点 | 说明 |
|---|------|
| 删除分页 | 不能用 `LIMIT/OFFSET` 边删边查，删除后行会前移导致跳过。必须一次性查出所有路径。 |
| 空文件夹 | `total === 0` 时必须显式清理 DB 残留照片，不能直接返回。 |
| 扫描状态 | `folders.scan_status` 等字段用于崩溃恢复，不要随意移除。 |
| 路径匹配 | `seenPaths` 和 DB 中 `path` 必须严格一致（大小写、分隔符）。Windows 路径不区分大小写但字符串比较区分。 |
| worker 并发 | `FILE_WORKER_CONCURRENCY` 是针对机械硬盘调优的，调高可能导致 I/O 争抢。 |

---

### 2.4 缩略图方案

#### 存储结构

```
<dataPath>/thumbnails/
  ab/
    abcd1234_small.webp
    abcd1234_medium.webp
  cd/
    cd567890_small.webp
  ef/
    ef123456.webp          # 旧版无分片格式，兼容保留
```

- 按 `photoId` 前两位分片。
- 文件名：`{photoId}_{size}.webp`。
- 旧版格式：`{photoId}.webp`（视为 medium）。

#### 生成策略

| 尺寸 | 用途 | 配置 |
|------|------|------|
| `small` (128px) | 浏览网格、去重组、地图抽屉 | quality 85 |
| `medium` (512px) | 照片详情大图 | quality 90 |

- 扫描期间**不实时生成缩略图**（`DEFER_THUMBNAILS_DURING_SCAN = true`），扫描结束后统一后台生成，避免 I/O 争抢。
- `getThumbnail` 使用 `inFlight` Map 对同一个 `photoId:size` 的并发请求去重，避免重复生成。
- `isThumbnailFresh` 通过比较缩略图和原文件 `mtime` 判断是否过期。

#### 脆弱点

| 点 | 说明 |
|---|------|
| 文件名解析 | 孤儿清理、路径计算都依赖 `{photoId}_{size}.webp` 格式。修改命名规则必须同步改 `cleanOrphanThumbnails`、`deleteThumbnailsByPhotoIds`、`getThumbnailPath`。 |
| shard 前缀 | 必须和 `photoId.slice(0, 2)` 保持一致。 |
| `inFlight` 复用 | 同一 `photoId:size` 的并发请求会共享一个 Promise，错误处理要考虑 `finally` 清理。 |
| 旧版兼容 | `medium` 会优先查找旧版路径 `{photoId}.webp`，过期后删除。改动需谨慎。 |

---

### 2.5 去重方案

#### 精确去重

- 使用 `file_hash`（xxhash64）分组。
- 同一个 `file_hash` 且数量 >= 2 的照片组成一个 `exact` 组。
- 扫描完成后自动后台触发（仅针对新增/删除的照片）。

#### 相似去重

- 使用 64 位 pHash，汉明距离 < 10 视为相似。
- 使用 LSH（局部敏感哈希）加速：取 pHash 前 16 位作为桶，只在桶内两两比较。
- 汉明距离计算使用 `BigInt XOR + popcount`，避免字符串逐字符比较。
- 手动触发，界面显示进度。

#### 崩溃恢复（方案 A）

- 相似去重开始前：`duplicate_detection_dirty.similar = 1`，清空旧相似组。
- 成功完成后：`duplicate_detection_dirty.similar = 0`。
- 中断后下次启动：`initializeServices` 检测到 dirty，清理所有相似组并复位。
- 精确去重采用**原子替换**：不清空-逐插，而是收集完所有新组后，一个事务内「清空旧 exact 组 + 写入新 exact 组」。

#### 脆弱点

| 点 | 说明 |
|---|------|
| pHash 并发 | `ensurePerceptualHashes` 当前是 2 并发，适合机械硬盘。调高可能 I/O 卡死。 |
| LSH 桶大小 | 如果大量照片 pHash 前缀相同，桶内比较会退化为 O(n²)。极端情况需考虑。 |
| 原子替换 | `rebuildDuplicateGroups` 会先清空再写入，如果写入失败会导致该 reason 的组全部为空。必须确保收集阶段不会抛异常。 |
| dirty 标记 | `duplicate_detection_dirty` 是键值对，key 目前只有 `similar`。新增 reason 需要同步改启动恢复逻辑。 |
| 组内排序 | 展示层依赖 `taken_at DESC`。修改排序要同步改前端 `DuplicatesPage` 和 `database.ts` 查询。 |

---

### 2.6 地图方案

#### 数据聚合

- 后端 `getClustersInBounds` 按地图边界和缩放级别网格化聚合照片。
- `clusterPrecision(zoom) = Math.max(90 / Math.pow(2, zoom), 0.0001)`。
- 返回每个簇的中心点、照片数量、代表照片。

#### 坐标转换

- DB 中存储 WGS84。
- 高德/天地图瓦片需要 GCJ02，前端 `MapPage` 里 `wgs84ToGcj02` 转换。
- 后端聚合计算使用原始 WGS84，只在渲染标记时转换。

#### 抽屉缩略图加载

- 点击簇后，优先加载代表照片 + 前 10 张可见照片。
- 返回一批就渲染一批，不用等全部加载完成。
- 剩余照片后台分块加载。

#### 脆弱点

| 点 | 说明 |
|---|------|
| 精度函数 | `clusterPrecision` 必须前后端一致，否则点击簇和请求范围对不上。 |
| 坐标转换 | 后端不要对经纬度做 GCJ02 转换，否则和前端重复/不一致。 |
| 抽屉加载 | `drawerThumbnails` 是分块更新的，不要改成一次性 set。 |

---

### 2.7 状态管理

使用 Zustand，主要 store：

- `appStore`：照片列表、时间线、统计、去重组果、去重进度、扫描状态。
- `confirmStore`：确认弹窗。
- `toastStore`：轻提示。

#### 脆弱点

- `duplicateProgress` 现在存在 `appStore`，用于跨页面保持去重进度。不要改回页面级 state。
- 扫描完成事件（`scan:progress` status=complete）负责刷新 `appStore` 中的列表/时间线/统计。

---

## 三、IPC 接口清单

| 命名空间 | 方法 | 说明 |
|---------|------|------|
| `dialog` | `openFolder` | 打开文件夹选择对话框 |
| `config` | `get/setDataPath/getDataPath` | 数据目录配置 |
| `folder` | `add/remove/getAll/replaceWithParent` | 文件夹管理 |
| `scan` | `start/isScanning/onProgress` | 扫描控制与进度 |
| `photo` | `getAll/getPage/getTimeline/getOffsetByMonth/getById/getStats/updateLocation/updateDate/delete/getWithLocation/getInBounds/getClustersInBounds` | 照片查询与编辑 |
| `mapSetting` | `get/set` | 地图瓦片源配置 |
| `duplicate` | `getAll/detect/detectExact/detectSimilar/delete/onProgress` | 去重查询与触发 |
| `thumbnail` | `get/getBatch/stats/clear` | 缩略图服务 |
| `database` | `clear` | 清空数据库 |
| `log` | `getPath/read/clear/openFolder` | 日志管理 |

**脆弱点**：新增 IPC 必须同时在 `preload.ts` 暴露、`main.ts` 注册 handler，否则前端无法调用。

---

## 四、修改高风险区

以下区域改动时需要特别小心，建议先写测试或充分手动验证：

1. **`scanner.ts` 删除逻辑**：分页、事务、空文件夹处理。
2. **`database.ts deletePhotosBatch/deletePhoto/removeFolder`**：外键约束、重复组清理、事务边界。
3. **`database.ts` migrations**：新增 migration 版本号必须递增，且要兼容已安装用户的数据库。
4. **`thumbnail.ts` 路径/命名**：影响孤儿清理、批量删除、缩略图查找。
5. **`hash.ts` pHash/汉明距离算法**：影响相似去重结果。
6. **`scanner.ts` 扫描并发数**：影响机械硬盘性能。
7. **`MapPage.tsx` 坐标转换和 `clusterPrecision`**：必须与后端一致。
8. **`DuplicatesPage.tsx` 进度读取**：依赖全局 `appStore.duplicateProgress`。

---

## 五、开发约定

- 类型检查：`npm run check`
- 完整构建：`npm run build`
- 日志目录：`%APPDATA%/photovault/logs/`
- 数据库文件：`<dataPath>/photovault.db`
- 缩略图目录：`<dataPath>/thumbnails/`
