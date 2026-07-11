# 小呆画册 UI 设计规范

> 本规范用于约束小呆画册前端界面的一致性。新增页面、组件或交互时，请优先使用本规范定义的工具类与模式，避免引入新的颜色、间距或交互方式。

---

## 1. 设计原则

- **一致性**：同样的状态、操作、信息层级在整个应用中使用相同的视觉语言。
- **可读性**：深色背景下保持足够的对比度，避免过小的字号和过低的透明度。
- **反馈明确**：用户的每个操作都应有可感知的反馈（加载、成功、失败、禁用）。
- **克制**：不引入多余装饰，优先使用系统已有颜色和组件。

---

## 2. 颜色系统

### 2.1 背景色

| 用途 | Tailwind 类 | 说明 |
|------|------------|------|
| 应用底色 | `bg-zinc-950` | 整个应用窗口背景 |
| 页面/面板背景 | `bg-zinc-900/80` | 卡片、弹窗面板 |
| 次级背景 | `bg-zinc-800` | 输入框、标签、次级面板 |
| 悬停背景 | `bg-zinc-800` / `hover:bg-zinc-700` | 列表项、按钮悬停 |

### 2.2 文本色

| 用途 | Tailwind 类 | 说明 |
|------|------------|------|
| 主标题 | `text-zinc-100` | 页面标题、卡片标题 |
| 正文/次级 | `text-zinc-200` | 主要内容文字 |
| 辅助说明 | `text-zinc-400` | 副标题、描述、提示 |
| 弱化信息 | `text-zinc-500` | 时间、计数、占位符 |

### 2.3 功能色

| 用途 | Tailwind 类 | 说明 |
|------|------------|------|
| 主色（品牌） | `text-amber-500` / `bg-amber-500` | 主按钮、激活状态、重点标记 |
| 主色悬停 | `hover:bg-amber-400` | 主按钮悬停 |
| 成功 | `text-green-500` / `bg-green-500` | 完成、成功提示 |
| 危险 | `text-red-400` / `bg-red-500` | 删除、危险操作 |
| 信息 | `text-blue-500` / `bg-blue-500` | 普通进度、信息提示 |

---

## 3. 字体与排版

### 3.1 字体栈

全局字体由 `src/index.css` 的 `:root` 定义，优先使用系统字体：

```css
font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
```

### 3.2 字号规范

| 用途 | 类名 | 大小 | 字重 |
|------|------|------|------|
| 页面标题 | `.page-title` | `text-2xl` | `font-semibold` |
| 页面副标题 | `.page-subtitle` | `text-sm` | 默认 |
| 卡片标题 | `text-lg font-medium text-zinc-100` | `text-lg` | `font-medium` |
| 正文 | `text-sm text-zinc-200` | `text-sm` | 默认 |
| 辅助说明 | `text-xs text-zinc-400` | `text-xs` | 默认 |
| 标签/分类 | `.info-label` | `text-xs` | `font-medium uppercase` |

**约束**：不要使用 `text-[10px]` 或更小的字号，不要对正文使用 `text-zinc-500` 以下的透明度。

---

## 4. 布局与间距

### 4.1 页面结构

```tsx
<div className="page-container">
  <div className="page-header">
    <div>
      <h1 className="page-title">页面标题</h1>
      <p className="page-subtitle">页面说明</p>
    </div>
    {/* 操作按钮 */}
  </div>

  {/* 页面内容 */}
</div>
```

### 4.2 卡片

```tsx
<div className="card card-section">
  {/* 卡片内容 */}
</div>
```

卡片用于承载一组相关功能和信息，避免在页面中直接平铺大量无边界内容。

### 4.3 间距约定

- 页面容器内边距：`px-6 py-6`
- 页面头部与内容间距：`mb-8`
- 卡片内部块间距：`space-y-4` / `space-y-6`
- 卡片之间间距：`space-y-6` / `mb-6`
- 按钮/输入框之间间距：`gap-2` / `gap-4`

---

## 5. 组件规范

### 5.1 按钮

| 类型 | 类名 | 用途 |
|------|------|------|
| 主按钮 | `.btn-primary` | 页面主要操作，如"添加文件夹" |
| 次级按钮 | `.btn-secondary` | 辅助操作，如"筛选"、"打开目录" |
| 幽灵按钮 | `.btn-ghost` | 低优先级操作，如"取消" |
| 危险按钮 | `.btn-danger` | 删除、清除等需要谨慎的操作 |
| 实心危险按钮 | `.btn-danger-solid` | 批量删除等强调性危险操作 |
| 图标按钮 | `.icon-btn` | 关闭、展开、工具栏图标 |

**按钮状态**：
- `disabled:opacity-50 disabled:cursor-not-allowed` 必须同时设置
- 加载中应显示 spinner 并禁用点击

### 5.2 输入框

```tsx
<input className="input" placeholder="提示文字" />
```

只读输入框使用 `.input-readonly`。

### 5.3 空状态

```tsx
<Empty
  icon={FolderOpen}
  title="还没有添加任何文件夹"
  description="添加照片文件夹后，小呆画册会扫描并建立索引。"
  action={<button className="btn-primary">添加文件夹</button>}
/>
```

所有空数据、缺省状态都必须使用 `Empty` 组件，避免每个页面自己写占位提示。

---

## 6. 状态反馈规范

### 6.1 加载状态

#### 6.1.1 页面/区块加载

使用带文字说明的加载占位：

```tsx
<div className="loading-container">
  <Loader2 size={24} className="text-amber-500 animate-spin" />
  <span>正在加载照片...</span>
</div>
```

- 位置：居中显示
- 图标：`Loader2`，颜色 `text-amber-500`
- 文字：`text-sm text-zinc-400`

#### 6.1.2 进度加载

用于扫描、索引、去重检测等可感知进度的长任务：

```tsx
<div className="card card-section">
  <div className="flex items-center gap-3 mb-3">
    <RefreshCw size={18} className="text-amber-500 animate-spin" />
    <span className="text-sm text-zinc-300">正在扫描...</span>
  </div>
  <div className="progress-bar">
    <div className="progress-bar-fill" style={{ width: '60%' }} />
  </div>
  <div className="flex justify-between text-xs text-zinc-400 mt-2">
    <span>当前文件.jpg</span>
    <span>60 / 100</span>
  </div>
</div>
```

- 进度条背景：`bg-zinc-800 rounded-full h-2`
- 进度条填充：`bg-amber-500 h-2 rounded-full transition-all duration-300`
- 长任务进度使用 amber，普通信息进度使用 blue

#### 6.1.3 按钮内加载

按钮执行操作时，显示 spinner 替代原图标：

```tsx
<button disabled={isLoading} className="btn-primary">
  {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
  {isLoading ? '保存中...' : '保存'}
</button>
```

### 6.2 成功状态

#### 6.2.1 操作成功提示

优先使用全局 Toast：

```ts
toast('success', '操作成功');
```

#### 6.2.2 任务完成卡片

对于页面内长任务完成，可在页面内显示完成卡片：

```tsx
<div className="card card-section mb-6">
  <div className="flex items-center gap-3">
    <CheckCircle2 size={18} className="text-green-500" />
    <span className="text-sm text-zinc-300">扫描完成</span>
  </div>
</div>
```

### 6.3 错误状态

#### 6.3.1 操作失败提示

优先使用全局 Toast：

```ts
toast('error', '操作失败：' + error);
```

#### 6.3.2 页面/区块加载失败

对于页面级加载失败，使用错误占位并允许重试：

```tsx
<Empty
  icon={AlertCircle}
  title="加载失败"
  description="无法获取数据，请检查网络或稍后重试。"
  action={<button onClick={reload} className="btn-secondary">重试</button>}
/>
```

### 6.4 处理中状态

按钮操作需要一定时间但无明确进度时，按钮应：
- 显示 spinner
- 文字变为"...中"
- 禁用点击

```tsx
<button disabled={isProcessing} className="btn-primary">
  <Loader2 size={16} className={isProcessing ? 'animate-spin' : ''} />
  {isProcessing ? '处理中...' : '开始处理'}
</button>
```

### 6.5 禁用状态

所有禁用按钮/输入框必须同时设置：

```tsx
disabled:opacity-50 disabled:cursor-not-allowed
```

---

## 7. 交互规范

### 7.1 悬停（Hover）

- 按钮：`hover:bg-*` 颜色变化
- 列表项：`hover:bg-zinc-800`
- 卡片：`hover:border-zinc-700`
- 过渡：`transition-colors`，时长默认 150ms

### 7.2 焦点（Focus）

- 输入框聚焦：`focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/30`
- 按钮聚焦：`focus:ring-2 focus:ring-amber-500/40 focus:ring-offset-2 focus:ring-offset-zinc-950`

### 7.3 Toast 通知

使用全局 Toast，四种类型：

```ts
toast('success', '保存成功');
toast('error', '保存失败');
toast('info', '提示信息');
toast('warning', '警告信息');
```

---

## 8. 禁止项

为了保持设计一致性，新增代码时请勿：

1. 引入新的十六进制颜色值，除非补充到设计 token
2. 使用 `text-[10px]` 或更小的字号
3. 对正文使用 `text-zinc-600` 及以下颜色
4. 为同一状态创建新的加载/空状态样式，优先使用现有组件和工具类
5. 在页面中直接写 `bg-zinc-900 rounded-xl border border-zinc-800 p-6`，应使用 `.card .card-section`
6. 为按钮写冗长的 `className` 组合，应使用 `.btn-*` 工具类

---

## 9. 新增组件流程

如果现有组件和工具类无法满足需求：

1. 先检查本规范是否有可复用的模式
2. 在 `src/index.css` 的 `@layer components` 中补充新的工具类
3. 如果逻辑较复杂，创建新组件并放在 `src/components/` 下
4. 更新本规范文档，说明新组件/工具类的用法
