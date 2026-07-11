# 小呆相册 - 照片管理应用

一个用于管理本地照片库的桌面应用，支持浏览、去重、地图展示等功能。

## 功能特性

### 📁 照片库管理
- 添加多个照片文件夹
- 扫描并索引照片
- 自动提取 EXIF 元数据

### 🔍 智能去重
- 基于 MD5 哈希检测完全相同的照片
- 支持感知哈希检测视觉相似照片
- 智能推荐保留版本（有 GPS 或更高分辨率）

### 🗺️ 地图展示
- 在地图上显示有 GPS 信息的照片
- 按位置聚合照片
- 点击标记查看该位置的照片

### 👁️ 照片浏览
- 时间线视图，按年月分组
- 快速导航到指定时间段
- 点击照片查看详细信息

### ✏️ 元数据编辑
- 编辑照片拍摄日期
- 添加/修改 GPS 位置信息

## 技术栈

| 类别 | 技术 |
|------|------|
| 桌面框架 | Electron |
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite |
| 状态管理 | Zustand |
| 样式 | TailwindCSS |
| 数据库 | SQLite |
| 地图 | Leaflet |
| 图片处理 | Sharp |
| EXIF 解析 | exifr |

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式（Web）

```bash
npm run dev
```

### 开发模式（Electron）

```bash
npm install better-sqlite3 sharp exifr trash electron --save
npm run electron:dev
```

### 构建 Electron 应用

```bash
npm run electron:build
```

## 项目结构

```
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 主进程入口
│   ├── preload.ts               # 预加载脚本
│   └── services/               # 后端服务
│       ├── database.ts          # 数据库服务
│       ├── scanner.ts           # 文件扫描
│       ├── hash.ts              # 哈希计算
│       ├── exif.ts              # EXIF 解析
│       └── thumbnail.ts         # 缩略图生成
├── src/
│   ├── components/             # React 组件
│   ├── pages/                  # 页面组件
│   ├── stores/                 # Zustand 状态
│   ├── types/                  # TypeScript 类型
│   └── lib/                    # 工具函数
└── public/                     # 静态资源
```

## 演示模式

当前版本使用模拟数据，可以直接在浏览器中体验应用界面。

## 许可证

MIT
