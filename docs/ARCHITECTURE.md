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

**正确做法**：删除前先把这些 `recommended_photo_id` 置为 NULL（见 `database.ts deletePhotosBatch`），删除完成后由 `scanner.ts deletePhotos` 对受影响且仍存在的组重新选择推荐照片（复用 `selectBestPhoto` 评分制），避免 `recommended_photo_id` 长期为 NULL 导致前端推荐标记丢失。

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

#### 推荐照片选择（selectBestPhoto 评分制）

每个重复组会选一张"推荐保留"照片，采用综合评分（避免单一条件直接胜出导致其他维度被忽略）：

- 有 GPS 坐标：+100（位置信息珍贵）
- 文件大小：`log2(file_size) * 10`（越大分越高，但用对数避免大文件垄断）
- 分辨率：像素数 / 1e6（百万像素）
- 文件名规范：不含 `copy/副本/edited/修改/截图` 等关键词 +10

删除照片后，受影响组会重新调用此评分逻辑选择新推荐，保证 `recommended_photo_id` 始终有效。

#### 崩溃恢复（方案 A）

- 相似去重开始前：`duplicate_detection_dirty.similar = 1`，清空旧相似组。
- 成功完成后：`duplicate_detection_dirty.similar = 0`。
- 异常时（非进程崩溃）：`runSimilarDuplicateDetection` 的 try/catch 会清理本次产生的半成品相似组，finally 块重置 dirty 为 0。
- 进程崩溃后下次启动：`initializeServices` 检测到 dirty，清理所有相似组并复位。
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
| `duplicate` | `getAll/detectExact/detectSimilar/delete/onProgress` | 去重查询与触发 |
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

## 五、关键算法参数与设计决策

以下参数都是根据当前场景（大图库、机械硬盘、照片文件）调优的结果，修改前请理解其取舍。

### 6.1 缩略图尺寸

```typescript
small:  { size: 128, quality: 85 }
medium: { size: 512, quality: 90 }
```

| 参数 | 取值 | 考量 |
|------|------|------|
| `small = 128px` | 浏览网格、去重组、地图抽屉 | 网格单元实际显示尺寸通常 <= 128px，过大浪费磁盘和带宽。 |
| `medium = 512px` | 照片详情弹窗 | 弹窗大图区域最大约 1200px，512px 在 Retina/高分屏上仍清晰，同时避免生成 1MB+ 的缓存。 |
| `quality = 85/90` | WebP 质量 | 照片网格对质量不敏感用 85；详情视图用 90 减少肉眼可见压缩瑕疵。 |
| 格式 WebP | — | 比 JPEG 同质量体积小 20%~30%，sharp 原生支持。 |

**调整建议**：
- 如果屏幕 DPI 很高或详情弹窗变大，可提高 `medium.size` 到 768/1024。
- 如果磁盘紧张，可降低 `small.quality` 到 75。

---

### 6.2 扫描并发与批大小

```typescript
FILE_WORKER_CONCURRENCY = 2
THUMBNAIL_WORKER_CONCURRENCY = 1
PATH_BATCH_SIZE = 500
DELETE_BATCH_SIZE = 1000
DEFER_THUMBNAILS_DURING_SCAN = true
```

| 参数 | 取值 | 考量 |
|------|------|------|
| `FILE_WORKER_CONCURRENCY = 2` | 文件处理并发 | 针对机械硬盘调优。并发过高会导致磁头来回寻道，反而降低吞吐量；SSD 用户可适当提高到 4。 |
| `THUMBNAIL_WORKER_CONCURRENCY = 1` | 缩略图生成并发 | 缩略图生成是 CPU+IO 混合任务，机械硬盘下单线程更稳。 |
| `PATH_BATCH_SIZE = 500` | 每批查询已有记录的文件数 | 平衡内存和 DB 往返。太小则查询次数多，太大则单次 `IN (...)` 占位符过多。 |
| `DELETE_BATCH_SIZE = 1000` | 每批删除照片数 | SQLite 单次 `IN` 建议不超过 1000 个占位符，再大可能触发参数限制。 |
| `DEFER_THUMBNAILS_DURING_SCAN = true` | 扫描期间不生成缩略图 | 避免扫描和缩略图生成抢 IO，扫描结束后统一后台生成。 |

---

### 6.3 去重算法参数

```typescript
PHASH_THRESHOLD = 10
LSH_BANDS = 4
LSH_BAND_SIZE = 16   // 64 / 4
BATCH_SIZE = 5000    // LSH 建桶每批读取照片数
```

| 参数 | 取值 | 考量 |
|------|------|------|
| `PHASH_THRESHOLD = 10` | 汉明距离阈值 | 64 位 pHash 下，距离 < 10 通常对应肉眼可见的相似；阈值越大误报越多。 |
| `LSH_BANDS = 4` | LSH 分桶段数 | 64 位分成 4 段，每段 16 位。桶数量 2^16=65536，平均分散性好。 |
| `LSH_BAND_SIZE = 16` | 每段位数 | 与 `BANDS` 配合覆盖全部 64 位；单段太短会导致桶内照片过多。 |
| `BATCH_SIZE = 5000` | 建桶时每次读取照片数 | 一次性加载全部 pHash 内存压力大，5000 条一批平衡内存和速度。 |

**极端情况**：
- 如果大量照片内容非常相似（如连拍），pHash 前 16 位可能大量重复，导致某个 LSH 桶内照片数暴增，退化为 O(n²)。此时可考虑增加 LSH 桶维度或分段数。

---

### 6.4 pHash 计算并发

```typescript
CONCURRENCY = 2
```

- 为没有 pHash 的照片计算真正的感知哈希需要 `sharp` 读取、缩放、DCT 变换。
- 2 并发是机械硬盘的甜点：过低则 CPU 空闲，过高则磁盘 IO 成为瓶颈。

---

### 6.5 浏览页网格

```typescript
grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8
overscan={200}
```

| 参数 | 取值 | 考量 |
|------|------|------|
| 响应式列数 3~8 | 根据视口宽度 | 小屏显示 3 列保证可点击；大屏 8 列充分利用空间。 |
| `overscan = 200` | 虚拟滚动预渲染像素 | 在用户快速滚动时提前渲染 200px 外的项目，减少白屏，同时不会一次加载过多。 |

---

### 6.6 去重结果分页

```typescript
getDuplicateGroupsPaged(limit = 50, offset = 0)
```

- 去重组可能很多，单次加载 50 组避免前端内存和渲染压力。
- 用户滚动到底部时继续加载下一页。

---

### 6.7 地图聚合精度

```typescript
clusterPrecision(zoom: number): number {
  return Math.max(90 / Math.pow(2, zoom), 0.0001);
}
MIN_CLUSTER_ZOOM = 16
```

| 参数 | 取值 | 考量 |
|------|------|------|
| `90 / 2^zoom` | 网格边长（度） | 地球经度跨度约 360°，按 2 的 zoom 次幂划分，zoom 越大网格越细。 |
| `min = 0.0001` | 最小网格约 11 米 | 避免 zoom 极大时网格过小导致每个照片都成一簇。 |
| `MIN_CLUSTER_ZOOM = 16` | 最大展开 zoom | zoom >= 16 时不再聚合，直接显示单张照片标记。 |

**脆弱点**：该公式在前后端必须完全一致，否则前端点击簇请求的范围和后端聚合范围错位。

---

### 6.8 地图抽屉缩略图分块

```typescript
VISIBLE_CHUNK = 10
BACKGROUND_CHUNK = 20
```

| 参数 | 取值 | 考量 |
|------|------|------|
| `VISIBLE_CHUNK = 10` | 抽屉一屏可见数量 | 抽屉横向排列，一屏大约显示 8~12 张，先加载这 10 张让用户立刻看到。 |
| `BACKGROUND_CHUNK = 20` | 后台每批加载数量 | 可见区域加载完后，每批 20 张后台逐步加载，避免 IPC 消息过大。 |

---

### 6.9 数据库性能调优

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;    -- 64MB page cache
PRAGMA temp_store = MEMORY;
PRAGMA busy_timeout = 5000;
```

| 参数 | 取值 | 考量 |
|------|------|------|
| `WAL` | 写前日志 | 扫描、去重都是写多读少，WAL 提升并发写性能。 |
| `synchronous = NORMAL` | 同步模式 | WAL 下 NORMAL 已足够安全，FULL 会显著降低写入速度。 |
| `cache_size = 64MB` | 页缓存 | 大图库查询索引时命中缓存，减少磁盘读取。 |
| `busy_timeout = 5000ms` | 锁等待 | 后台去重和前台查询冲突时等待，而不是立刻报错。 |

---

### 6.10 去重触发策略

| 类型 | 触发时机 | 原因 |
|------|---------|------|
| 精确去重 | 扫描完成后自动后台执行 | 基于文件哈希，速度快，适合自动化。 |
| 相似去重 | 用户手动点击 | 需要计算 pHash，大图库可能耗时数小时，不适合自动跑。 |

---

### 6.11 进度与状态上报间隔

```typescript
PROGRESS_INTERVAL = 200
SCAN_STATUS_INTERVAL = 200
```

- 每处理 200 张照片上报一次进度给前端。
- 频率过高会占用主进程事件循环和 IPC 带宽；频率过低则进度条卡顿。
- 200 张在机械硬盘上大约 1~3 秒，UI 既流畅又不浪费资源。

## 六、开发约定

- 类型检查：`npm run check`
- 完整构建：`npm run build`
- 日志目录：`%APPDATA%/photovault/logs/`
- 数据库文件：`<dataPath>/photovault.db`
- 缩略图目录：`<dataPath>/thumbnails/`
