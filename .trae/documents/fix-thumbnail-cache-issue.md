# 分析浏览页面切换后图片消失的问题

## 问题描述
从浏览界面切换到其他界面（如去重、地图），再切换回浏览界面时，原来显示的图片都看不见了。

## 问题分析

### 当前代码逻辑
1. `thumbnails` 和 `originalImages` 存储在 zustand 全局 store 中（Map 类型）
2. `loadThumbnails` useEffect 的依赖项是 `[photos, thumbnails.size, originalImages.size]`
3. 图片显示使用 `thumbnails.get(photo.id)` 获取缩略图 URL

### 可能的原因

#### 原因1：zustand 对 Map 对象的处理问题
- zustand 默认使用浅比较（shallow comparison）
- Map 对象在 store 中可能存在序列化/反序列化问题
- 当组件重新订阅 store 时，Map 对象可能无法正确读取

#### 原因2：useEffect 依赖问题
- 当组件重新挂载时，`loadingRef` 会重置为 `false`
- 但如果 `photos`、`thumbnails.size`、`originalImages.size` 都没有变化，useEffect 不会重新执行
- 这本身不应该影响图片显示，因为缓存数据应该还在

#### 原因3：Map 对象引用问题
- 在 `loadThumbnails` 中创建新 Map：`const thumbMap = new Map(thumbnails)`
- 如果 `thumbnails` 是空的或 undefined，新 Map 也会是空的
- 设置新 Map 到 store 后，组件可能没有正确响应变化

#### 原因4：组件重新渲染时机问题
- 组件重新挂载时，从 store 读取 `thumbnails` 可能存在时序问题
- Map 对象的 `.get()` 方法在渲染时可能返回 undefined

## 解决方案

### 方案1：使用普通对象替代 Map
将 Map 改为普通对象（Record<string, string>），避免 Map 在 zustand 中的潜在问题。

### 方案2：添加调试日志
先添加调试日志确认问题根源，再针对性修复。

### 方案3：使用 zustand 的 persist 中间件
确保 Map 数据正确持久化和恢复。

## 推荐方案
**方案1：使用普通对象替代 Map**

理由：
1. 普通对象在 zustand 中更稳定
2. 更容易调试和序列化
3. 性能差异可以忽略不计

## 实施步骤

1. 修改 `appStore.ts`：
   - 将 `thumbnails: Map<string, string>` 改为 `thumbnails: Record<string, string>`
   - 将 `originalImages: Map<string, string>` 改为 `originalImages: Record<string, string>`
   - 更新相关的 setter 方法

2. 修改 `BrowsePage.tsx`：
   - 更新读取方式：`thumbnails[photo.id]` 替代 `thumbnails.get(photo.id)`
   - 更新写入方式：直接赋值替代 Map.set()
   - 更新检查方式：`photo.id in thumbnails` 替代 `thumbnails.has(photo.id)`

3. 测试验证：
   - 切换页面后图片是否正常显示
   - 缩略图加载是否正常
