# PhotoVault 开发指导清单

> 基于项目代码审查和讨论整理，共 55 项，按模块分组，按优先级排序。

---

## 一、扫描模块（S1-S7）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| S1 | ~~高~~ ✅ | 前端 | 扫描按钮改为下拉式，主操作=增量扫描，下拉=强制重新扫描（需确认提示） | `LibraryPage.tsx` |
| S2 | ~~高~~ ✅ | 后端 | 增量扫描判断加 mtime 检查，fileSize + mtime 双重校验 | `scanner.ts` |
| S3 | ~~高~~ ✅ | 后端 | 哈希计算改流式读取（createReadStream），避免大文件 OOM | `hash.ts` |
| S4 | ~~中~~ ✅ | 后端 | 扫描时计算真正的 pHash（DCT 变换 64 位），存入 DB | `hash.ts`, `scanner.ts` |
| S5 | ~~低~~ ✅ | 后端 | EXIF 提取优化，减少 exifr + sharp 重复 I/O | `exif.ts` |
| S6 | ~~低~~ ✅ | 后端 | 文件收集改流式（AsyncGenerator），避免大库内存压力 | `scanner.ts` |
| S7 | ~~低~~ ✅ | 后端 | 扫描结束计数改 SELECT COUNT(*) | `database.ts`, `scanner.ts` |
| S8 | ~~中~~ ✅ | 后端 | 崩溃恢复：folders 表增加扫描状态字段，启动时自动恢复中断扫描 | `database.ts`, `scanner.ts`, `main.ts` |

### S1 详细说明

当前 `LibraryPage.tsx` 扫描按钮硬编码 `forceRescan=true`，每次都是全量扫描。改为下拉按钮：

```
[▼ 扫描]  ← 点击主区域 = 增量扫描
  ├─ 扫描新增照片      ← 默认
  └─ 强制重新扫描      ← 带确认提示
```

### S2 详细说明

当前增量扫描仅用 `fileSize === stats.size` 判断文件是否修改，文件内容可能变了但大小没变（如元数据编辑）。需加上 mtime 检查：

```typescript
if (!forceRescan && existing
    && existing.fileSize === stats.size
    && existing.modifiedTime === stats.mtime.toISOString()) {
  skipped++;
  continue;
}
```

### S3 详细说明

当前 `calculateFileHash()` 将整个文件读入内存再算 MD5，大文件（50MB RAW）有 OOM 风险。改为流式哈希：

```typescript
async calculateFileHash(filePath: string): Promise<string> {
  const hash = createHash('md5');
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
```

### S4 详细说明

当前 `perceptualHash` 只是 `fileHash.substring(0, 16)`，不是真正的感知哈希。需实现 DCT 变换方案：

```typescript
async calculatePerceptualHash(filePath: string): Promise<string> {
  const { data, info } = await sharp(filePath)
    .grayscale()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // DCT 变换 + 取 8x8 低频 + 生成 64 位哈希
}
```

扫描时一并计算，不额外增加用户等待时间。

### S8 详细说明

当前扫描中断后只能重新扫描。解决方案：在 `folders` 表增加扫描状态字段，应用启动时自动恢复中断扫描。

**新增字段：**

```sql
ALTER TABLE folders ADD COLUMN scan_status TEXT DEFAULT 'idle';
  -- 'idle' | 'scanning' | 'interrupted'
ALTER TABLE folders ADD COLUMN scan_total INTEGER DEFAULT 0;
ALTER TABLE folders ADD COLUMN scan_processed INTEGER DEFAULT 0;
ALTER TABLE folders ADD COLUMN scan_last_path TEXT DEFAULT '';
```

**流程：**

| 阶段 | 操作 |
|------|------|
| 开始扫描 | `scan_status='scanning', scan_total=N, scan_processed=0` |
| 每批写入 | `scan_processed += 50, scan_last_path = 当前文件路径` |
| 扫描完成 | `scan_status='idle', scan_processed=0, last_scanned=NOW` |
| 应用崩溃/关闭 | `scan_status` 保持 `'scanning'`，下次启动检测到即为中断 |
| 启动恢复 | 查 `scan_status='scanning'` 的文件夹 → 自动触发增量扫描（复用现有逻辑，已入库照片自动跳过） |

不需要通知用户，不需要确认弹窗，复用增量扫描逻辑即可。用户最多看到侧边栏进度条显示"正在恢复扫描..."。

---

## 二、文件夹模块（F1-F2）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| F1 | ~~高~~ ✅ | 后端 | 添加文件夹时校验嵌套：子目录直接拒绝，父目录提示替换 | `scanner.ts`, `main.ts` |
| F2 | ~~高~~ ✅ | 前端 | 嵌套校验提示 UI（拒绝提示框 / 替换确认框） | `LibraryPage.tsx` |

### F1 详细说明

添加文件夹时需检查新路径与已有文件夹的嵌套关系：

| 场景 | 检测方式 | 处理 |
|------|---------|------|
| 新路径是已有文件夹的子目录 | `newPath.startsWith(existingPath + '/')` | 直接拒绝，提示"已被包含" |
| 新路径是已有文件夹的父目录 | `existingPath.startsWith(newPath + '/')` | 提示替换，确认后删除子目录记录并重新扫描 |

替换操作步骤：
1. 删除子目录的文件夹记录及关联照片（`deletePhotosByFolder`）
2. 删除子目录下照片的缩略图缓存
3. 添加父目录为新文件夹
4. 扫描父目录

---

## 三、数据库模块（D1-D8）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| D1 | ~~高~~ ✅ | 后端 | INSERT OR REPLACE → INSERT OR IGNORE，防止 folder_id 被静默篡改 | `database.ts` |
| D2 | ~~中~~ ✅ | 后端 | 已删除文件清理改批量事务删除（DELETE WHERE id IN） | `database.ts`, `scanner.ts` |
| D3 | ~~高~~ ✅ | 后端 | Schema Migration 机制：版本号管理 + ALTER TABLE 原地升级 | `database.ts` |
| D4 | ~~中~~ ✅ | 后端 | 返回类型安全：全部 any 改为具体类型 | `database.ts`, `types/index.ts` |
| D5 | ~~中~~ ✅ | 后端 | 事务修复：deletePhotosByFolder 和 clearDuplicateGroups 包裹事务 | `database.ts` |
| D6 | ~~中~~ ✅ | 后端 | deletePhoto 后清理空重复组 | `database.ts` |
| D7 | ~~低~~ ✅ | 后端 | getDuplicateGroups 优化：两步查询替代 json_group_array | `database.ts` |
| D8 | ~~低~~ ✅ | 后端 | getPhotoStats 合并查询：5次 SELECT 合并为1条 | `database.ts` |

### D1 详细说明

当前 `insertPhoto()` 使用 `INSERT OR REPLACE`，配合 `photos.path UNIQUE` 约束，当不同文件夹包含相同路径的照片时（如先扫描 A 再扫描 A 的子目录 B），会静默覆盖已有记录的 `folder_id`，导致数据不一致。改为 `INSERT OR IGNORE`，同路径不覆盖。

### D3 详细说明

当前用 `CREATE TABLE IF NOT EXISTS` 只能建新表，无法处理新增字段、修改字段类型等变更。应用升级后数据库结构不兼容，只能删库重建，用户数据全丢。

**实现方案：版本号管理 + ALTER TABLE 原地升级**

```typescript
private runMigrations() {
  // 创建版本表
  this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);

  const current = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any;
  const currentVersion = current?.v || 0;

  const migrations = [
    { version: 1, up: () => { /* 基础表结构（当前已有的） */ } },
    { version: 2, up: () => {
      // S8 崩溃恢复：folders 加扫描状态字段
      this.db.exec(`ALTER TABLE folders ADD COLUMN scan_status TEXT DEFAULT 'idle'`);
      this.db.exec(`ALTER TABLE folders ADD COLUMN scan_total INTEGER DEFAULT 0`);
      this.db.exec(`ALTER TABLE folders ADD COLUMN scan_processed INTEGER DEFAULT 0`);
      this.db.exec(`ALTER TABLE folders ADD COLUMN scan_last_path TEXT DEFAULT ''`);
    }},
    { version: 3, up: () => {
      // R6 pHash 分段索引
      this.db.exec(`ALTER TABLE photos ADD COLUMN phash_segment_1 TEXT`);
      this.db.exec(`ALTER TABLE photos ADD COLUMN phash_segment_2 TEXT`);
      this.db.exec(`ALTER TABLE photos ADD COLUMN phash_segment_3 TEXT`);
      this.db.exec(`ALTER TABLE photos ADD COLUMN phash_segment_4 TEXT`);
    }},
    { version: 4, up: () => {
      // M3 地图设置 + I4 语言设置
      this.db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
    }},
  ];

  const pending = migrations.filter(m => m.version > currentVersion);
  for (const m of pending) {
    this.db.transaction(() => {
      m.up();
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
  }
}
```

**核心要点：**
- 每次启动检查版本号，只执行未执行的 migration
- 每个 migration 包裹在事务中，失败则回滚
- ALTER TABLE 是原地修改，不复制数据，毫秒级完成
- 后续所有需要改表结构的 TODO 项（S8、R6、M3、I4）都依赖此机制

### D4 详细说明

当前 database.ts 所有返回类型都是 `any`，调用方没有类型提示，字段名拼错也不会报错。需改为具体类型：

```typescript
// 当前
getPhotos(filter: any = {}): any[]
getPhotoById(id: string): any | null

// 改为
getPhotos(filter: PhotoFilter): Photo[]
getPhotoById(id: string): Photo | null
```

利用 `src/types/index.ts` 中已有的类型定义，或补充缺失的类型。

### D5 详细说明

当前 `deletePhotosByFolder` 和 `clearDuplicateGroups` 的多条 DELETE 不在事务中，中间崩溃会导致数据不一致：

```typescript
// 当前：3条独立操作
deletePhotoDuplicates.run(folderId);  // 成功
deleteDuplicateGroups.run();          // 如果崩溃...
deletePhotos.run(folderId);           // 不会执行，照片残留

// 改为：包裹在事务中
const transaction = this.db.transaction(() => {
  deletePhotoDuplicates.run(folderId);
  deleteDuplicateGroups.run();
  deletePhotos.run(folderId);
});
transaction();
```

### D6 详细说明

当前 `deletePhoto` 只删 photos 记录，`photo_duplicates` 有 ON DELETE CASCADE 会自动清理，但 `duplicate_groups` 不会。删除照片后可能留下空重复组（组内已无照片但组记录还在）。

需在 `deletePhoto` 中补充清理逻辑：

```typescript
deletePhoto(id: string): void {
  // 1. 找到该照片所在的重复组
  const groups = this.db.prepare(`
    SELECT group_id FROM photo_duplicates WHERE photo_id = ?
  `).all(id);

  // 2. 删除照片（CASCADE 会清理 photo_duplicates）
  this.db.prepare('DELETE FROM photos WHERE id = ?').run(id);

  // 3. 清理空重复组
  for (const g of groups) {
    const remaining = this.db.prepare(
      'SELECT COUNT(*) as count FROM photo_duplicates WHERE group_id = ?'
    ).get(g.group_id) as any;
    if (remaining.count <= 1) {
      this.db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(g.group_id);
      this.db.prepare('DELETE FROM photo_duplicates WHERE group_id = ?').run(g.group_id);
    }
  }
}
```

### D7 详细说明

当前 `getDuplicateGroups` 用 `json_group_array + json_object` 在 SQL 中拼接 JSON，再 JS 中 `JSON.parse`。数据量大时性能差，且字段变更时 SQL 也要改。

改为两步查询：

```typescript
getDuplicateGroups(): DuplicateGroup[] {
  // 1. 查所有重复组
  const groups = this.db.prepare('SELECT * FROM duplicate_groups').all();

  // 2. 查每个组的照片
  return groups.map(g => {
    const photos = this.db.prepare(`
      SELECT p.* FROM photos p
      JOIN photo_duplicates pd ON p.id = pd.photo_id
      WHERE pd.group_id = ?
    `).all(g.id);
    return { ...g, photos };
  });
}
```

### D8 详细说明

当前 `getPhotoStats` 用 5 条独立 SELECT 查询统计信息，可合并为 1 条：

```sql
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) as with_location,
  (SELECT COUNT(*) FROM photo_duplicates) as duplicates,
  (SELECT COUNT(*) FROM folders) as folders
FROM photos
```

cameras 查询（GROUP BY）单独保留。

---

## 四、缩略图模块（T1-T2）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| T1 | ~~高~~ ✅ | 后端 | getThumbnail() 加源文件 mtime 校验，源文件更新时重新生成 | `thumbnail.ts` |
| T2 | ~~高~~ ✅ | 前端 | 重新扫描后清空 Zustand thumbnails 缓存 | `appStore.ts`, `LibraryPage.tsx` |

### T1 详细说明

当前 `getThumbnail()` 只检查缩略图文件是否存在，存在就直接返回。增量扫描时 `photoId` 被复用，如果源文件内容已变更，缩略图不会重新生成。需对比源文件和缩略图的修改时间：

```typescript
async getThumbnail(photoId: string, photoPath: string): Promise<string> {
  const thumbnailPath = join(this.thumbnailDir, `${photoId}.webp`);

  if (existsSync(thumbnailPath)) {
    const thumbStat = statSync(thumbnailPath);
    const sourceStat = statSync(photoPath);
    if (sourceStat.mtime <= thumbStat.mtime) {
      return `file:///${thumbnailPath.replace(/\\/g, '/')}`;
    }
    // 源文件更新，删除旧缩略图，重新生成
    unlinkSync(thumbnailPath);
  }
  // 生成新缩略图...
}
```

### T2 详细说明

重新扫描完成后，前端 Zustand store 中的 `thumbnails` 对象仍保留旧数据。需在扫描完成回调中清空：

```typescript
// 扫描完成后
setThumbnails({});
setOriginalImages({});
```

---

## 五、重复检测模块（R1-R7）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| R1 | ~~高~~ ✅ | 后端 | 重复检测从扫描流程解耦，扫描只入库，检测独立运行 | `scanner.ts`, `main.ts` |
| R2 | ~~高~~ ✅ | 后端 | 精确重复改 SQL 聚合查询（GROUP BY file_hash HAVING COUNT>1），支持跨文件夹 | `database.ts` |
| R3 | 高 | 后端 | 重复组增量更新：新增只检查新照片，删除从组中移除，组内仅1张时删组 | `database.ts`, `scanner.ts` |
| R4 | ~~中~~ ✅ | 前端 | 独立"重新检测重复"入口 | `LibraryPage.tsx` 或 `DuplicatesPage.tsx` |
| R5 | 中 | 后端 | 推荐保留改评分制（GPS +100、文件大小对数、分辨率、文件名规范性） | `scanner.ts` |
| R6 | 中 | 后端 | pHash 比较优化：哈希分段索引（4段16位），O(N²) → 接近 O(N) | `database.ts` 新增索引 |
| R7 | 中 | 后端 | 相似检测后台运行：Worker 线程 + 渐进式输出 | 新建 `worker/duplicateDetector.ts` |

### R1 详细说明

当前重复检测绑定在扫描流程中（`startScan` 末尾调用 `detectDuplicates`），导致：
- 只能扫描时触发，无独立入口
- 只检测当前文件夹，不支持跨文件夹
- 每次全局清除所有重复组再重建

解耦方案：
- 扫描流程：文件收集 → EXIF/哈希 → 入库（不检测重复）
- 重复检测：独立操作，从 DB 读取数据 → 分组 → 写入 duplicate_groups

### R2 详细说明

精确重复检测改用 SQL 聚合查询，一条 SQL 找出所有精确重复，天然支持跨文件夹：

```sql
SELECT file_hash, GROUP_CONCAT(id) as photo_ids
FROM photos
WHERE file_hash IS NOT NULL
GROUP BY file_hash
HAVING COUNT(*) > 1
```

替代当前内存中构建 `hashMap` 再逐条查数据库的方式。

### R3 详细说明

不再每次全局清除重建重复组，改为增量更新：

| 操作 | 更新策略 |
|------|---------|
| 扫描新增照片 | 只检查新照片的哈希是否匹配已有组，有则加入，无则跳过 |
| 删除照片 | 从重复组中移除该照片，组内只剩 1 张时删除整个组 |
| 全量重新检测 | 清除所有重复组，基于全量数据重建 |

### R5 详细说明

当前 `selectBestPhoto()` 优先级链有缺陷——有 GPS 就不再比大小：

```typescript
// 当前：有GPS直接胜出，不看其他条件
if (current.latitude && !best.latitude) return current;
if (current.file_size > best.file_size) return current;  // 有GPS时永远不执行
```

改为评分制：

```typescript
function scorePhoto(photo): number {
  let score = 0;
  if (photo.latitude && photo.longitude) score += 100;  // 有GPS +100
  score += Math.log2(photo.file_size) * 10;             // 文件越大分越高
  score += (photo.width * photo.height) / 1000000;      // 分辨越高分越高
  if (photo.filename && !photo.filename.includes('copy')) score += 10;  // 文件名规范 +10
  return score;
}
```

### R6 详细说明

pHash 比较不能简单用 SQL，O(N²) 全量比较不可接受。使用哈希分段索引优化：

将 64 位 pHash 拆成 4 段，每段 16 位，建 4 个索引列。数学原理：两个哈希汉明距离 < 10，意味着 64 位中至少有 54 位相同，4 段中至少有一段完全相同的概率极高。

只需在 4 个段索引中找匹配，再对候选集算汉明距离，比较次数从 O(N²) 降到接近 O(N)。

### R7 详细说明

相似检测用户体验流程：

```
用户点击扫描
    ↓
扫描阶段（前台）
  ├─ 精确重复：扫描完成后立刻用 SQL 查出，秒级出结果
  └─ pHash：扫描时计算并存入 DB
    ↓
扫描完成，用户立刻看到精确重复结果，可以开始操作
    ↓
相似检测（后台静默运行）
  ├─ Worker 线程跑分段索引 + 汉明距离比较
  ├─ 发现相似组 → 渐进式推送到前端
  └─ 前端显示小气泡："发现 3 组相似照片"
    ↓
用户随时可以查看相似重复，也可以不管它继续浏览
```

---

## 六、地图模块（M1-M8）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| M1 | 高 | 前端 | 标记样式：用 L.divIcon + 缩略图圆形标记替代默认蓝色图钉 | `MapPage.tsx` |
| M2 | 高 | 前端 | 同位置多照片：点击标记展开底部抽屉，横向滚动显示该位置所有照片 | `MapPage.tsx` |
| M3 | 高 | 前后端 | 地图瓦片源：默认 Stadia Dark（无需Key），可选高德/腾讯/天地图（需Key） | `MapPage.tsx`, `config.ts`, `main.ts` |
| M8 | 高 | 前端 | 设置页面：地图源切换下拉框 + API Key 输入框 + 申请指引链接 | `SettingsPage.tsx` |
| M4 | 中 | 前后端 | 视口按需加载：拖动/缩放时只加载 bounds 内照片，后端新增 getInBounds 接口 | `MapPage.tsx`, `database.ts`, `main.ts` |
| M5 | 中 | 前端 | 时间轴筛选：地图上方可折叠时间滑块，拖动只显示对应时间范围照片 | `MapPage.tsx` |
| M6 | 中 | 前端 | 无GPS照片管理：右上角按钮，左侧弹出列表，支持拖拽照片到地图标记位置 | `MapPage.tsx` |
| M7 | 低 | 前端 | 改用 react-leaflet 重构，组件化替代当前 DOM 操作 | `MapPage.tsx` |

### M1 详细说明

当前使用 Leaflet 默认蓝色图钉标记，不够直观。改为缩略图圆形标记：

```
普通缩略图标记：     聚合标记：
  ┌────┐           ┌──────┐
  │ 📷 │           │  12  │
  └────┘           └──────┘
  圆形裁切           琥珀色数字气泡
```

实现方式：用 `L.divIcon` 渲染圆形缩略图，聚合标记保持当前琥珀色样式不变。

### M2 详细说明

同一地点有多张照片时，点击标记展开底部抽屉，横向滚动显示该位置所有照片：

```
┌─────────────────────────────────────┐
│              地图区域                │
│                                     │
├─────────────────────────────────────┤
│ 📷 📷 📷 📷 📷 📷 📷  ← 横向滚动  │
│ 东京 · 2024.1  · 7张照片            │
└─────────────────────────────────────┘
```

替代当前逐个点击标记的体验，与 Google Photos、Apple Photos 交互一致。

### M3 详细说明

地图瓦片源分层策略：

**默认方案（零配置，开箱即用）**

使用 Stadia Dark 或 CartoDB Dark Matter，不需要 API Key，深色主题完美适配：

```
CartoDB Dark Matter 瓦片 URL：
https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png
```

**国内优化方案（用户可选配置）**

设置页面提供地图源切换，选择高德/腾讯/天地图时提示用户填入 API Key：

| 地图源 | 需要 Key | 国内速度 | 深色风格 | 申请地址 |
|--------|---------|---------|---------|---------|
| Stadia Dark | 不需要 | 中等 | 有 | — |
| CartoDB Dark | 不需要 | 中等 | 有 | — |
| OpenStreetMap | 不需要 | 慢/被墙 | 无 | — |
| 高德地图 | 需要 | 快 | 无 | https://lbs.amap.com/api/javascript-api/guide/abc/prepare |
| 腾讯地图 | 需要 | 快 | 无 | https://lbs.qq.com/dev/console/application/mine |
| 天地图 | 需要（免费申请） | 快 | 无 | https://console.tianditu.gov.cn/api/key |

瓦片源配置代码：

```typescript
const TILE_PROVIDERS = {
  stadia_dark: {
    name: 'Stadia Dark（推荐，无需配置）',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    attribution: '&copy; Stadia Maps',
    needKey: false,
  },
  carto_dark: {
    name: 'CartoDB Dark（无需配置）',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; CartoDB',
    needKey: false,
  },
  osm: {
    name: 'OpenStreetMap（无需配置）',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
    needKey: false,
  },
  amap: {
    name: '高德地图（需 API Key，国内推荐）',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}&key={apiKey}',
    attribution: '&copy; 高德地图',
    needKey: true,
    keyApplyUrl: 'https://lbs.amap.com/api/javascript-api/guide/abc/prepare',
  },
  tencent: {
    name: '腾讯地图（需 API Key）',
    url: 'https://wprd0{s}.is.autonavi.com/appmaptile?...',
    attribution: '&copy; 腾讯地图',
    needKey: true,
    keyApplyUrl: 'https://lbs.qq.com/dev/console/application/mine',
  },
  tianditu: {
    name: '天地图（需 API Key，免费申请）',
    url: 'https://t{s}.tianditu.gov.cn/vec_w/wmts?...',
    attribution: '&copy; 天地图',
    needKey: true,
    keyApplyUrl: 'https://console.tianditu.gov.cn/api/key',
  },
};
```

Key 存储在 ConfigService 中，和 dataPath/logPath 一样持久化。

### M8 详细说明

设置页面地图配置 UI：

```
地图源：[Stadia Dark ▼]
  ├─ Stadia Dark（推荐，无需配置）     ← 默认选中
  ├─ CartoDB Dark（无需配置）
  ├─ OpenStreetMap（无需配置）
  ├─ 高德地图（需 API Key）→ 申请地址
  ├─ 腾讯地图（需 API Key）→ 申请地址
  └─ 天地图（需 API Key）→ 申请地址

API Key：[__________]  ← 仅选择需Key的源时显示
         💡 免费申请，个人开发者即可
         🔗 前往申请 →  ← 点击跳转到对应申请页面
```

### M4 详细说明

当前 `getWithLocation()` 一次返回所有有 GPS 的照片，1 万张就卡。改为视口按需加载：

后端新增 `photo:getInBounds` IPC 接口：

```sql
SELECT * FROM photos
WHERE latitude BETWEEN ? AND ?
  AND longitude BETWEEN ? AND ?
```

前端在地图 `moveend` 事件时请求，配合 300ms 防抖，拖动过程中不频繁请求。

### M5 详细说明

地图上方加一个可折叠的时间筛选条：

```
[2022] ─────●───── [2024] ───●── [2025]
           2023.6            2024.9
```

拖动滑块只显示对应时间范围内的照片，直观看到"旅行轨迹"。

### M6 详细说明

地图右上角加一个"无位置照片"按钮，点击后左侧弹出照片列表（无 GPS 的照片），用户拖拽照片到地图上标记位置，标记后调用 `updatePhotoLocation()` 写入 GPS：

```
┌──────────┬──────────────────────────┐
│ 无GPS照片 │                          │
│          │         地图区域          │
│ 📷 拖拽  │                          │
│ 📷 到地图 │                          │
│ 📷 上标记 │                          │
│ 位置     │                          │
└──────────┴──────────────────────────┘
```

### M7 详细说明

当前直接操作 Leaflet DOM，和 React 状态管理脱节。改用 `react-leaflet`（已安装未使用），组件化更清晰：

```tsx
<MapContainer center={[30, 110]} zoom={4}>
  <TileLayer url="..." />
  <MarkerClusterGroup>
    {photos.map(photo => (
      <Marker key={photo.id} position={[photo.latitude, photo.longitude]}>
        <PhotoPopup photo={photo} />
      </Marker>
    ))}
  </MarkerClusterGroup>
</MapContainer>
```

---

## 七、元数据编辑模块（E1-E2）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| E1 | ~~高~~ ✅ | 前后端 | 日期编辑双写：更新数据库 + 写回图片 EXIF | `BrowsePage.tsx`, `database.ts`, `main.ts`, `preload.ts` |
| E2 | ~~高~~ ✅ | 前后端 | 位置编辑双写：当前只改数据库，需补上写回图片 EXIF GPS 字段 | `database.ts`, `main.ts` |

### E1 详细说明

当前日期编辑是**假保存**——`handleSaveDate` 只更新了前端状态，没调后端 API：

```typescript
// 当前代码：只改了前端状态
const updatedPhoto = { ...selectedPhoto, taken_at: newDate };
setSelectedPhoto(updatedPhoto);  // 没有调 window.api
```

正确实现需要双写：

1. **更新数据库** `photos.taken_at`
2. **写回图片文件 EXIF**（DateTimeOriginal、CreateDate）

当前项目只装了 `exifr`（只读），不能写 EXIF。需引入 **exiftool-vendored**：

```typescript
import exiftool from 'exiftool-vendored';

// 1. 数据库更新
await window.api.photo.updateDate(photoId, newDate);

// 2. EXIF 写回
await exiftool.write(photoPath, {
  DateTimeOriginal: newDate,
  CreateDate: newDate,
});
```

注意事项：
- **文件权限**：文件可能只读，写入前需检查
- **RAW 格式**：有些 RAW 文件 EXIF 写入是破坏性的，需备份或提示用户
- **写入失败回滚**：EXIF 写入失败时数据库也不应更新
- **操作确认**：修改原始文件是不可逆操作，需明确告知用户

### E2 详细说明

当前 `updatePhotoLocation` 只更新了数据库，没写回图片文件：

```typescript
// 当前代码：只改了数据库
await window.api.photo.updateLocation(selectedPhoto.id, lat, lng);
// 缺少：写回图片 EXIF GPSLatitude/GPSLongitude
```

需补上 EXIF GPS 字段写回：

```typescript
await exiftool.write(photoPath, {
  GPSLatitude: lat,
  GPSLatitudeRef: lat >= 0 ? 'N' : 'S',
  GPSLongitude: lng,
  GPSLongitudeRef: lng >= 0 ? 'E' : 'W',
});
```

与 E1 共用 exiftool-vendored，注意事项相同（文件权限、失败回滚、操作确认）。

---

## 八、浏览模块（B1-B3）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| B1 | ~~高~~ ✅ | 后端 | 照片列表分批加载，新增 photo:getPage 接口（LIMIT + OFFSET） | `database.ts`, `main.ts`, `preload.ts` |
| B2 | ~~高~~ ✅ | 前端 | 无限滚动，滚到底部自动加载下一批（100张/批） | `BrowsePage.tsx`, `appStore.ts` |
| B3 | ~~高~~ ✅ | 前端 | 虚拟滚动，只渲染可见区域 DOM，引入 react-virtuoso | `BrowsePage.tsx` |

### B1 详细说明

当前 `getPhotos()` 一次返回所有照片，1 万张就卡。需新增分页接口：

```sql
-- 后端新增 photo:getPage IPC
SELECT * FROM photos
WHERE 1=1 [筛选条件]
ORDER BY taken_at DESC NULLS LAST
LIMIT ? OFFSET ?
```

返回格式：

```typescript
interface PagedResult {
  photos: Photo[];
  total: number;      // 总数，用于判断是否还有更多
  hasMore: boolean;    // 是否还有下一页
}
```

### B2 详细说明

当前 `loadPhotos({})` 一次加载全部，改为无限滚动：

```
用户打开浏览页
    ↓
加载第1批（1-100张）
    ↓
用户向下滚动，接近底部
    ↓
自动加载第2批（101-200张）
    ↓
继续滚动，继续加载...
```

实现要点：
- 监听滚动位置，距离底部 200px 时触发加载
- 加载中显示骨架屏占位
- 支持筛选条件变化时重置分页

### B3 详细说明

即使分批加载，累积渲染的 DOM 节点仍然会越来越多。虚拟滚动保证 DOM 数量恒定：

```
实际 DOM：
┌─────────────┐
│  照片 1-20   │ ← 可见区域，真实渲染
│  照片 21-40  │
├─────────────┤
│             │ ← 不可见，1个空白div撑高度
│  (占位)      │    代替数千个 DOM 节点
│             │
├─────────────┤
│  照片 N-20   │ ← 滚到底部才渲染
│  到 N        │
└─────────────┘
```

推荐使用 `react-virtuoso`，支持网格布局和无限滚动组合：

```tsx
<Virtuoso
  useWindowScroll={false}
  data={photos}
  endReached={loadMore}
  itemContent={(index, photo) => (
    <PhotoCard photo={photo} />
  )}
/>
```

B1 + B2 + B3 组合方案：无限滚动分批加载数据 + 虚拟滚动只渲染可见区域，10 万张照片也能流畅浏览。

---

## 九、交互优化模块（U1-U3）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| U1 | ~~中~~ ✅ | 前端 | Toast 通知组件：替代 18 处 alert() 操作结果反馈 | 新建 `components/Toast.tsx`，涉及 `SettingsPage.tsx`, `BrowsePage.tsx`, `DuplicatesPage.tsx` |
| U2 | ~~中~~ ✅ | 前端 | 自定义确认弹窗组件：替代 9 处 confirm() 危险操作确认 | 新建 `components/ConfirmDialog.tsx`，涉及 `SettingsPage.tsx`, `BrowsePage.tsx`, `LibraryPage.tsx`, `DuplicatesPage.tsx` |
| U3 | 低 | 前端 | 表单校验行内提示：经纬度输入校验从 alert 改为输入框下方红色提示 | `BrowsePage.tsx` |

### U1 详细说明

当前项目有 18 处 `alert()` 用于操作结果反馈，体验差：阻塞界面、样式不统一、无法自动消失。需新建 Toast 通知组件替代。

**需替换的 alert() 列表：**

| 页面 | 当前 | Toast 类型 |
|------|------|-----------|
| SettingsPage | `alert('缩略图缓存已清除')` | 成功 |
| SettingsPage | `alert('清除失败：' + error)` ×5 | 错误 |
| SettingsPage | `alert('数据库已清除...')` | 成功 |
| SettingsPage | `alert('设置已保存，请重启应用')` | 成功（带"重启"按钮） |
| SettingsPage | `alert('已恢复默认设置，请重启应用')` | 成功 |
| SettingsPage | `alert('日志路径已更新')` | 成功 |
| SettingsPage | `alert('已恢复默认日志路径')` | 成功 |
| SettingsPage | `alert('日志已清除')` | 成功 |
| BrowsePage | `alert('删除失败：' + error)` ×2 | 错误 |
| DuplicatesPage | `alert('请先选择要处理的重复组')` | 警告 |

**Toast 组件设计：**

```tsx
// 使用方式
toast.success('缩略图缓存已清除');
toast.error('清除失败：' + error);
toast.warning('请先选择要处理的重复组');
toast.info('设置已保存，请重启应用', { action: { label: '重启', onClick: restartApp } });
```

- 成功：绿色，3 秒自动消失
- 错误：红色，需手动关闭
- 警告：琥珀色，5 秒自动消失
- 信息：蓝色，3 秒自动消失
- 支持可选操作按钮

### U2 详细说明

当前项目有 9 处 `confirm()` 用于危险操作确认，系统原生弹窗样式与深色主题不搭，且无法自定义按钮文案。需新建确认弹窗组件替代。

**需替换的 confirm() 列表：**

| 页面 | 当前 | 弹窗类型 |
|------|------|---------|
| SettingsPage | `confirm('确定要清除所有缩略图缓存吗？')` | 普通确认 |
| SettingsPage | `confirm('确定要清除所有数据吗？')` + 二次确认 | 高危确认（保留二次确认） |
| SettingsPage | `confirm('更改数据存储位置后需要重启...')` | 普通确认 |
| SettingsPage | `confirm('确定要恢复默认存储位置吗？')` | 普通确认 |
| SettingsPage | `confirm('确定要清除所有日志吗？')` | 普通确认 |
| BrowsePage | `confirm('确定要删除这张照片吗？')` | 删除确认 |
| BrowsePage | `confirm('确定要删除选中的 N 张照片吗？')` | 删除确认 |
| LibraryPage | `confirm('确定要移除此文件夹吗？')` | 删除确认 |
| DuplicatesPage | `confirm('确定要删除 N 张重复照片吗？')` | 删除确认 |

**确认弹窗组件设计：**

```tsx
// 使用方式
const confirmed = await confirmDialog({
  title: '删除照片',
  message: `确定要删除 ${count} 张照片吗？`,
  description: '照片将移到系统回收站，可从回收站恢复。',
  confirmText: '删除',
  variant: 'danger',  // danger / warning / default
});
```

- 深色主题风格，与整体 UI 一致
- 支持自定义标题、描述、按钮文案
- danger 变体：确认按钮红色
- 高危操作保留二次确认机制

### U3 详细说明

[BrowsePage.tsx:177](file:///workspace/photovault/src/pages/BrowsePage.tsx#L177) 经纬度输入校验使用 `alert('请输入有效的经纬度坐标')`，应改为输入框下方行内红色提示文字，不打断用户操作流程。

---

## 十、i18n 国际化模块（I1-I4）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| I1 | 中 | 前端 | 搭建 i18n 框架：安装 react-i18next，建目录结构，配置初始化 | 新建 `src/i18n.ts`, `src/locales/` |
| I2 | 中 | 前端 | 公共文本迁移：common.json（按钮、状态、时间格式等约30个文本） | `src/locales/zh-CN/common.json`, `src/locales/en/common.json` |
| I3 | 低 | 前端 | 逐页面迁移：library/browse/duplicates/map/settings 各页面文本 | 各页面组件 + 对应 locale JSON |
| I4 | 低 | 前端 | 设置页面语言切换：下拉框 + 持久化到 ConfigService | `SettingsPage.tsx`, `config.ts` |

### I1 详细说明

安装 react-i18next，搭建国际化框架：

```bash
npm install react-i18next i18next
```

**目录结构：**

```
src/
├── locales/
│   ├── zh-CN/
│   │   ├── common.json      # 通用：按钮、状态、时间
│   │   ├── library.json     # 照片库页面
│   │   ├── browse.json      # 浏览页面
│   │   ├── duplicates.json  # 去重页面
│   │   ├── map.json         # 地图页面
│   │   └── settings.json    # 设置页面
│   └── en/
│       ├── common.json
│       ├── library.json
│       └── ...
├── i18n.ts                  # 初始化配置
```

**初始化配置：**

```typescript
// src/i18n.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCommon from './locales/zh-CN/common.json';
import enCommon from './locales/en/common.json';

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { common: zhCommon },
    en: { common: enCommon },
  },
  lng: detectLanguage(),   // 用户设置 > 系统语言 > 默认 zh-CN
  fallbackLng: 'zh-CN',
  ns: ['common'],
  interpolation: { escapeValue: false },
});

function detectLanguage(): string {
  // 1. 从 ConfigService 读取用户设置
  // 2. 系统语言 app.getLocale()
  // 3. 默认 zh-CN
}
```

按页面拆分命名空间，避免单个文件过大，也支持按需加载。

### I2 详细说明

优先迁移公共文本，收益最大（所有页面都能用）：

```json
// locales/zh-CN/common.json
{
  "button": {
    "add": "添加",
    "delete": "删除",
    "cancel": "取消",
    "save": "保存",
    "scan": "扫描",
    "confirm": "确认",
    "close": "关闭",
    "browse": "浏览...",
    "reset": "恢复默认"
  },
  "status": {
    "loading": "加载中...",
    "scanning": "正在扫描...",
    "complete": "完成",
    "saving": "保存中...",
    "clearing": "清除中..."
  },
  "time": {
    "never": "从未",
    "unknown": "未知时间"
  },
  "unit": {
    "photos": "{{count}} 张照片",
    "folders": "{{count}} 个文件夹"
  }
}
```

```json
// locales/en/common.json
{
  "button": {
    "add": "Add",
    "delete": "Delete",
    "cancel": "Cancel",
    "save": "Save",
    "scan": "Scan",
    "confirm": "Confirm",
    "close": "Close",
    "browse": "Browse...",
    "reset": "Reset"
  },
  "status": {
    "loading": "Loading...",
    "scanning": "Scanning...",
    "complete": "Complete",
    "saving": "Saving...",
    "clearing": "Clearing..."
  },
  "time": {
    "never": "Never",
    "unknown": "Unknown date"
  },
  "unit": {
    "photos": "{{count}} photo(s)",
    "folders": "{{count}} folder(s)"
  }
}
```

### I3 详细说明

逐页面迁移各页面文本到对应命名空间，约 85 个文本：

| 页面 | 命名空间 | 预估文本数 |
|------|---------|-----------|
| 照片库 | library | ~15 |
| 浏览 | browse | ~25 |
| 去重 | duplicates | ~15 |
| 地图 | map | ~10 |
| 设置 | settings | ~20 |

建议每改一个页面就迁移该页面的文本，避免大爆炸式改动。

### I4 详细说明

设置页面增加语言切换下拉框：

```
语言：[简体中文 ▼]
  ├─ 简体中文
  └─ English
```

语言偏好持久化到 ConfigService，和 dataPath/logPath 一样。切换后即时生效，无需重启。

---

## 十一、配置模块（G1-G3）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| G1 | ~~中~~ ✅ | 后端 | 新建 app_settings 表，除 dataPath 外的配置统一存入数据库 | `database.ts`, `config.ts`, `main.ts` |
| G2 | 中 | 前端 | 删除主题功能相关代码 | `useTheme.ts`, `appStore.ts`, `Sidebar.tsx` |
| G3 | 低 | 后端 | DatabaseService 改用 ConfigService.getDataPath() | `database.ts`, `main.ts` |

### G1 详细说明

当前配置分散在三处：`config.json`（dataPath/logPath）、`localStorage`（theme）、数据库（业务数据）。应统一为：

- **config.json**：只保留 `dataPath`（因为数据库本身在 dataPath 下，启动时需要先读它才能打开数据库）
- **app_settings 表**：其余所有配置

```sql
-- 通过 Schema Migration 创建
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

**需迁移到 app_settings 的配置项：**

| 配置项 | key | 默认值 | 来源 |
|--------|-----|--------|------|
| 日志路径 | logPath | null | config.json 迁移 |
| 语言 | language | 'zh-CN' | 新增（I4） |
| 地图瓦片源 | mapProvider | 'stadia_dark' | 新增（M3） |
| 地图 API Key | mapApiKey | '' | 新增（M3） |
| AI 搜索开关 | clipEnabled | 'false' | 新增（A1） |

**ConfigService 改造：**

```typescript
class ConfigService {
  // 启动时：从 config.json 读 dataPath，打开数据库
  // 之后：所有配置读写走 app_settings 表

  getSetting(key: string): string | null {
    return this.db.getSetting(key);
  }

  setSetting(key: string, value: string): void {
    this.db.setSetting(key, value);
  }
}
```

### G2 详细说明

主题功能不再规划，需删除以下代码：

| 文件 | 删除内容 |
|------|---------|
| `src/hooks/useTheme.ts` | 整个文件删除 |
| `src/stores/appStore.ts` | 删除 `theme` 状态和 `setTheme` 方法 |
| `src/components/layout/Sidebar.tsx` | 删除主题切换按钮 |
| `src/main.tsx` | 删除 useTheme 相关 import |
| localStorage | 清除 `theme` 键 |

应用统一使用深色主题，不需要切换功能。

### G3 详细说明

当前 `DatabaseService` 构造函数接收 `userDataPath`，内部自己拼接 `join(userDataPath, 'data')`。但 `ConfigService.getDataPath()` 已经处理了自定义路径、开发环境等逻辑。DatabaseService 应直接使用 ConfigService 返回的 dataPath：

```typescript
// 当前
const dataPath = configService.getDataPath();
const databaseService = new DatabaseService(dataPath);
// DatabaseService 内部又拼了一次 join(userDataPath, 'data')

// 改为
const dataPath = configService.getDataPath();
const databaseService = new DatabaseService(dataPath);
// DatabaseService 直接用传入的 dataPath，不再拼接
```

---

## 十二、清理（C1）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| C1 | 低 | 前端 | mockApi 死代码：删除或改造为 Web 模式 fallback | `mockApi.ts`, `main.tsx` |

---

## 十三、应用打包（P1）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| P1 | 低 | 全栈 | 应用图标：设计原图 + 生成多格式 + 配置打包 | `main.ts`, `package.json`, `build/` |

### P1 详细说明

当前应用使用 Electron 默认图标，需要替换为自定义图标。

**步骤：**

1. 设计 1024x1024 PNG 原图
2. 用 `electron-icon-builder` 生成各平台格式：

```bash
npm install --save-dev electron-icon-builder
npx electron-icon-builder --input=./assets/icon.png --output=./build
```

生成目录结构：

```
build/
├── icon.ico        # Windows
├── icon.icns       # macOS
└── icons/
    ├── 16x16.png
    ├── 32x32.png
    ├── 48x48.png
    ├── 128x128.png
    ├── 256x256.png
    └── 512x512.png  # Linux
```

3. `main.ts` BrowserWindow 加 icon 属性：

```typescript
const windowOptions = {
  // ...现有配置
  icon: join(__dirname, '../build/icons/512x512.png'),
};
```

4. `package.json` 加 electron-builder 配置：

```json
{
  "build": {
    "appId": "com.photovault.app",
    "productName": "PhotoVault",
    "directories": {
      "buildResources": "build"
    },
    "mac": {
      "icon": "build/icon.icns"
    },
    "win": {
      "icon": "build/icon.ico",
      "target": ["nsis"]
    },
    "linux": {
      "icon": "build/icons",
      "target": ["AppImage"]
    }
  }
}
```

---

## 十二、AI 搜索模块（A1-A3）

| 编号 | 优先级 | 前后端 | 事项 | 涉及文件 |
|------|--------|--------|------|----------|
| A1 | 低 | 后端 | CLIP 模型集成：ONNX Runtime + MobileCLIP，扫描时后台生成 embedding | 新建 `services/clipService.ts`, `database.ts` |
| A2 | 低 | 后端 | sqlite-vec 向量索引：替代 JS 层全量比较，SIMD 加速 | `database.ts`, 安装 sqlite-vec |
| A3 | 低 | 后后端 | 中文搜索支持：中文 CLIP 模型或翻译层 | `clipService.ts` |

### A1 详细说明

引入 CLIP（Contrastive Language-Image Pre-training）模型实现图片内容语义搜索，用户可输入"鸟"、"证件照"、"红色衣服"等自然语言搜索照片。

**技术栈：**
- ONNX Runtime Node（本地推理，不需要联网）
- MobileCLIP S2（~20MB，CPU 单张 ~15ms）

**架构：**

```
扫描阶段：
  照片 → CLIP 图像编码器 → 512维向量 → 存入数据库 BLOB

搜索阶段：
  用户输入"红色的鸟" → CLIP 文本编码器 → 512维向量
      ↓
  和数据库中图片向量算余弦相似度
      ↓
  返回 Top-K 结果
```

**实现要点：**

```typescript
// services/clipService.ts
import { session } from 'onnxruntime-node';

class ClipService {
  async initialize() {
    this.imageSession = await session.create('clip-vit-b32-image.onnx');
    this.textSession = await session.create('clip-vit-b32-text.onnx');
  }

  // 扫描时：图片 → 向量
  async getImageEmbedding(imagePath: string): Float32Array { ... }

  // 搜索时：文本 → 向量
  async getTextEmbedding(query: string): Float32Array { ... }
}
```

**数据库扩展：**

```sql
ALTER TABLE photos ADD COLUMN clip_embedding BLOB;
```

**搜索接口：**

```typescript
async searchByContent(query: string, topK = 50): Promise<Photo[]> {
  const textEmbedding = await this.clipService.getTextEmbedding(query);
  // 从数据库加载向量，计算余弦相似度，返回 Top-K
}
```

**能搜什么：**

| 搜索词 | 效果 |
|--------|------|
| "鸟" | 找出各种鸟的照片 |
| "证件照" | 找出正面人像照 |
| "红色衣服" | 找出穿红色衣服的人 |
| "海边日落" | 找出海边日落场景 |
| "文档" | 找出扫描文档/截图 |

**局限性：**
- 不能识别人脸（搜"张三"找不到特定人）
- 细粒度差（能搜"鸟"，分不清"麻雀"和"燕子"）
- 原始 CLIP 英文训练，中文需额外处理（见 A3）

### A2 详细说明

SQLite 存向量的性能瓶颈在于全量比较：10 万张 ~500ms，50 万张 ~2.5s。sqlite-vec 是 SQLite 官方生态的向量搜索扩展，直接在 SQLite 内做向量运算：

```sql
-- 创建虚拟表
CREATE VIRTUAL TABLE photo_embeddings USING vec0(
  photo_id TEXT PRIMARY KEY,
  embedding float[512]
);

-- 搜索 Top-K
SELECT photo_id, distance
FROM photo_embeddings
WHERE embedding MATCH ?
ORDER BY distance
LIMIT 50;
```

**优势：**
- 底层 SIMD 指令加速，比 JS 层计算快 5-10 倍
- 10 万张搜索约 50-100ms
- 不换数据库，SQLite 生态内解决
- Electron 中以 native addon 形式加载

**性能对比：**

| 照片数量 | JS 层全量比较 | sqlite-vec |
|---------|-------------|-----------|
| 1 万 | ~50ms | ~10ms |
| 10 万 | ~500ms | ~50-100ms |
| 50 万 | ~2.5s | ~300ms |

### A3 详细说明

原始 CLIP 模型以英文训练为主，中文搜索效果差。解决方案：

**方案一：中文 CLIP 模型**
- 使用 `chinese-clip-vit-base-patch16`（阿里达摩院开源）
- 直接支持中文输入，效果最好
- 模型稍大（~400MB）

**方案二：翻译层**
- 用户输入中文 → 翻译为英文 → 英文 CLIP 搜索
- 额外依赖翻译模型，增加延迟
- 效果不如原生中文 CLIP

建议选方案一，首次启动时下载中文 CLIP 模型。

### C1 详细说明

`main.tsx` 中 `import './lib/mockApi'` 是副作用导入，但 mockApi 模块没有任何顶层副作用代码，不会自动挂载到 `window.api`。所有页面都直接调用 `window.api.xxx`（来自 Electron preload），mockApi 从未被使用。

方案一：删除 mockApi 及相关 import。

方案二：改造为非 Electron 环境的 fallback，在 mockApi 底部添加：

```typescript
if (!window.api) {
  window.api = mockApi as any;
}
```

---

## 建议实施顺序

### 第一批（高优先级，核心功能修复）

1. ~~**S1** 扫描按钮改为增量/强制双模式~~ ✅
2. ~~**S2** 增量扫描加 mtime 检查~~ ✅
3. ~~**S3** 哈希计算改流式~~ ✅
4. ~~**F1+F2** 文件夹嵌套校验 + 前端提示~~ ✅
5. ~~**D1** INSERT OR IGNORE~~ ✅
6. ~~**D3** Schema Migration 机制~~ ✅
7. ~~**T1+T2** 缩略图 mtime 校验 + 前端缓存清理~~ ✅
8. ~~**R1** 重复检测解耦~~ ✅
9. ~~**R2** SQL 聚合查询~~ ✅
10. ~~**R3** 重复组增量更新~~ ✅
11. **M1** 缩略图圆形标记
12. **M2** 同位置多照片底部抽屉
13. **M3+M8** 地图瓦片源 + 设置页面
14. ~~**E1** 日期编辑双写（数据库 + EXIF）~~ ✅
15. ~~**E2** 位置编辑双写（数据库 + EXIF GPS）~~ ✅
16. ~~**B1** 照片列表分批加载接口~~ ✅
17. ~~**B2** 无限滚动~~ ✅
18. ~~**B3** 虚拟滚动~~ ✅

### 第二批（中优先级，体验增强）

1. ~~**S4** 真正的 pHash 计算~~ ✅
2. ~~**S8** 崩溃恢复（folders 表加扫描状态字段）~~ ✅
3. ~~**R4** 独立重新检测入口~~ ✅
4. **R5** 评分制推荐保留
5. **R6** pHash 分段索引
6. **R7** Worker 后台运行
7. ~~**D2** 批量事务删除~~ ✅
8. ~~**D4** 返回类型安全（any → 具体类型）~~ ✅
9. ~~**D5** 事务修复（deletePhotosByFolder/clearDuplicateGroups）~~ ✅
10. ~~**D6** deletePhoto 后清理空重复组~~ ✅
11. **M4** 地图视口按需加载
12. **M5** 时间轴筛选
13. **M6** 无GPS照片管理
14. ~~**U1** Toast 通知组件（替代 18 处 alert）~~ ✅
15. ~~**U2** 自定义确认弹窗组件（替代 9 处 confirm）~~ ✅
16. **I1** i18n 框架搭建（react-i18next + 目录结构 + 初始化配置）
17. **I2** 公共文本迁移（common.json 约30个文本）
18. ~~**G1** app_settings 表统一配置存储~~ ✅
19. **G2** 删除主题功能相关代码

### 第三批（低优先级，性能优化）

1. ~~**S5** EXIF I/O 优化~~ ✅
2. ~~**S6** 流式文件收集~~ ✅
3. ~~**S7** COUNT 优化~~ ✅
4. **M7** react-leaflet 重构
5. **D7** getDuplicateGroups 两步查询优化
6. **D8** getPhotoStats 合并查询
7. **U3** 表单校验行内提示
8. **I3** 逐页面 i18n 迁移（约85个文本）
9. **I4** 设置页面语言切换
10. **C1** mockApi 清理
11. **G3** DatabaseService 改用 ConfigService.getDataPath()
12. **P1** 应用图标（设计 + 生成多格式 + 配置打包）
13. **A1** CLIP 模型集成（ONNX Runtime + MobileCLIP）
14. **A2** sqlite-vec 向量索引
15. **A3** 中文 CLIP 搜索支持
