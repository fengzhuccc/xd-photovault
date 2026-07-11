# 小呆相册（PhotoVault）v1.0.0

一款专注于本地照片管理的桌面应用，支持时间线浏览、AI 语义搜索、智能去重、地图可视化与元数据编辑。所有照片数据均存储在本地，保护隐私安全。

## 功能特性

### 📁 照片库管理
- 添加多个本地照片文件夹，自动扫描并建立索引
- 自动提取 EXIF 元数据（拍摄时间、相机、GPS、光圈、快门、ISO 等）
- 支持图片与视频文件
- 自定义数据存储目录与日志目录

### 🔍 浏览与搜索
- 时间线视图：按年月分组，快速导航到指定时间段
- AI 语义搜索：使用 CLIP 模型通过自然语言描述查找照片
- 搜索结果展示相似度分数
- 虚拟滚动优化，流畅浏览大量照片

### 🧠 智能去重
- 精确去重：基于 MD5 哈希检测完全相同的照片
- 相似去重：基于感知哈希检测视觉相似照片
- 智能推荐保留版本（优先保留有 GPS 信息、分辨率更高的照片）

### 🗺️ 地图视图
- 在地图上聚合展示有 GPS 信息的照片
- 支持高德地图、高德暗色、天地图等多种瓦片源
- 点击聚合点查看该位置的所有照片
- 支持单张或批量修改照片 GPS 坐标
- 地图抽屉支持鼠标滚轮横向浏览缩略图

### ✏️ 元数据编辑
- 编辑照片拍摄日期
- 添加或修改 GPS 位置信息
- 批量修改多张照片的坐标

### ⚙️ 设置与维护
- 设置页查看应用版本与介绍
- 自定义数据存储位置
- 查看、刷新与清除应用日志
- 清除缩略图缓存以释放磁盘空间
- 危险操作：清除数据库（需二次确认）

## 技术栈

| 类别 | 技术 |
|------|------|
| 桌面框架 | Electron 33 |
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite 6 |
| 状态管理 | Zustand |
| 样式 | TailwindCSS |
| 数据库 | SQLite（better-sqlite3）|
| 地图 | Leaflet + react-leaflet |
| 图片处理 | Sharp |
| EXIF 解析 | exifr / exiftool-vendored |
| AI 语义搜索 | CLIP（@xenova/transformers + onnxruntime-node）|
| 测试 | Vitest |

## 快速开始

### 安装依赖

```bash
npm install
```

> 安装过程中会触发 `electron-builder install-app-deps`，用于编译 native 依赖（如 better-sqlite3、sharp）。

### 下载 AI 模型（可选但推荐）

如果需要在打包后的应用中使用 AI 语义搜索，请先下载模型：

```bash
npm run download:ai-model
```

国内网络不稳定时，可使用镜像：

```bash
# Windows PowerShell
$env:HF_ENDPOINT="https://hf-mirror.com"; npm run download:ai-model

# Windows cmd
set HF_ENDPOINT=https://hf-mirror.com && npm run download:ai-model
```

### 开发模式

仅启动前端开发服务器：

```bash
npm run dev
```

启动 Electron 开发环境（同时运行 Vite 与 Electron）：

```bash
npm run dev:electron
```

### 构建

构建前端与 Electron 主进程：

```bash
npm run build
```

仅构建 Electron 主进程：

```bash
npm run build:electron
```

### 打包发布

打包为 Windows 安装程序（NSIS）与便携版：

```bash
npm run dist
```

仅打包便携版：

```bash
npm run dist:portable
```

打包产物位于 `release/` 目录。

### 验证

运行类型检查：

```bash
npm run check
```

运行测试：

```bash
npm run test
```

完整验证（类型检查 + 测试 + 便携版打包）：

```bash
npm run verify:portable
```

## 项目结构

```
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 主进程入口
│   ├── preload.ts               # 预加载脚本（IPC 接口暴露）
│   └── services/                # 后端服务
│       ├── database.ts          # SQLite 数据库服务
│       ├── scanner.ts           # 文件扫描与索引
│       ├── hash.ts              # MD5 / 感知哈希
│       ├── exif.ts              # EXIF 元数据解析
│       ├── thumbnail.ts         # 缩略图生成
│       ├── aiConfig.ts          # AI 模型配置
│       ├── aiEmbedding.ts       # CLIP 向量编码
│       ├── aiIndexService.ts    # AI 索引后台任务
│       └── aiSearchService.ts   # AI 语义搜索
├── src/                         # 前端源码
│   ├── components/              # React 组件
│   ├── pages/                   # 页面组件
│   ├── stores/                  # Zustand 状态管理
│   ├── types/                   # TypeScript 类型定义
│   └── lib/                     # 工具函数
├── scripts/                     # 构建与测试脚本
├── resources/ai-models/         # AI 模型本地缓存目录
├── dist/                        # Vite 构建输出
├── dist-electron/               # Electron 主进程构建输出
└── release/                     # 打包输出目录
```

## 许可证

MIT
