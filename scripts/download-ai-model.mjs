import { mkdirSync, existsSync, createWriteStream } from 'fs';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');
const TARGET_BASE_DIR = join(process.cwd(), 'resources', 'ai-models');
const DOWNLOAD_ALL = process.env.AI_DOWNLOAD_ALL === '1' || process.env.AI_DOWNLOAD_ALL === 'true';
const REVISION = 'main';

// 需要下载的模型列表
const MODELS = [
  {
    id: 'Xenova/clip-vit-base-patch16',
    comment: 'CLIP 视觉-文本嵌入模型（语义搜索主模型）',
    // 白名单方式：只保留 *_quantized.onnx，跳过所有其他精度变体（fp16/int8/bnb4/q4/uint8 等）
    skipByDefault: [
      /^onnx\/(?!.*_quantized\.onnx$).*\.onnx$/,
    ],
  },
  {
    id: 'Xenova/opus-mt-zh-en',
    comment: '中英翻译模型（中文查询翻译为英文以提升搜索效果）',
    // 只保留 encoder + decoder_merged（merged 已包含 decoder + decoder_with_past 两种模式）
    skipByDefault: [
      // 跳过所有非 quantized 的 onnx 变体
      /^onnx\/(?!.*_quantized\.onnx$).*\.onnx$/,
      // merged 已覆盖，跳过单独的 decoder 和 decoder_with_past
      /^onnx\/decoder_model_quantized\.onnx$/,
      /^onnx\/decoder_with_past_model_quantized\.onnx$/,
    ],
  },
];

function shouldSkip(filePath, skipPatterns) {
  if (DOWNLOAD_ALL) return false;
  return skipPatterns.some((pattern) => pattern.test(filePath));
}

async function fetchFileList(modelId, revision = 'main') {
  const url = `${HF_ENDPOINT}/api/models/${modelId}/tree/${revision}?recursive=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`获取文件列表失败: ${res.status} ${res.statusText}\n${url}`);
  }
  return res.json();
}

async function downloadFile(url, targetPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败: ${res.status} ${res.statusText}\n${url}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const fileStream = createWriteStream(targetPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return 'unknown';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

async function downloadModel(modelConfig) {
  const { id: modelId, skipByDefault, comment } = modelConfig;
  const targetDir = join(TARGET_BASE_DIR, modelId);

  console.log(`\n[download-ai-model] ========== ${modelId} ==========`);
  console.log(`[download-ai-model] ${comment}`);
  console.log(`[download-ai-model] 目标目录: ${targetDir}`);
  console.log('[download-ai-model] 正在获取文件列表...');

  const files = await fetchFileList(modelId, REVISION);
  const fileEntries = files.filter((f) => f.type === 'file');

  const filesToDownload = fileEntries.filter((f) => !shouldSkip(f.path, skipByDefault));
  const skippedFiles = fileEntries.filter((f) => shouldSkip(f.path, skipByDefault));
  const downloadTotalBytes = filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0);
  const skippedTotalBytes = skippedFiles.reduce((sum, f) => sum + (f.size || 0), 0);

  console.log(`[download-ai-model] 将下载 ${filesToDownload.length} 个文件，总计约 ${formatBytes(downloadTotalBytes)}`);
  if (skippedFiles.length > 0) {
    console.log(`[download-ai-model] 跳过 ${skippedFiles.length} 个非量化文件，总计约 ${formatBytes(skippedTotalBytes)}`);
  }
  console.log('[download-ai-model] 开始下载...');

  let downloadedBytes = 0;
  for (let i = 0; i < filesToDownload.length; i++) {
    const { path: filePath, size } = filesToDownload[i];
    const url = `${HF_ENDPOINT}/${modelId}/resolve/${REVISION}/${filePath}`;
    const targetPath = join(targetDir, filePath);

    if (existsSync(targetPath)) {
      console.log(`[${i + 1}/${filesToDownload.length}] 已存在，跳过: ${filePath}`);
      downloadedBytes += size || 0;
      continue;
    }

    console.log(
      `[${i + 1}/${filesToDownload.length}] 下载中 (${formatBytes(size)}) ${formatBytes(downloadedBytes)}/${formatBytes(downloadTotalBytes)}: ${filePath}`
    );
    await downloadFile(url, targetPath);
    downloadedBytes += size || 0;
  }

  console.log(`[download-ai-model] ${modelId} 下载完成`);
}

async function main() {
  console.log(`[download-ai-model] 下载源: ${HF_ENDPOINT}`);
  console.log(`[download-ai-model] 模型列表:`);
  for (const m of MODELS) {
    console.log(`  - ${m.id} (${m.comment})`);
  }
  console.log(`[download-ai-model] 如需下载全部精度版本，设置 AI_DOWNLOAD_ALL=1\n`);

  for (const modelConfig of MODELS) {
    await downloadModel(modelConfig);
  }

  console.log('\n[download-ai-model] 所有模型下载完成');
  console.log(`[download-ai-model] 本地路径: ${TARGET_BASE_DIR}`);
  console.log('[download-ai-model] 打包时该目录会被自动包含进应用');
}

main().catch((err) => {
  console.error('\n[download-ai-model] 下载出错:', err.message);
  console.error('[download-ai-model] 如果网络不稳定，可以设置镜像后重试，例如：');
  console.error('  Windows PowerShell: $env:HF_ENDPOINT="https://hf-mirror.com"; npm run download:ai-model');
  console.error('  Windows cmd:        set HF_ENDPOINT=https://hf-mirror.com && npm run download:ai-model');
  console.error('[download-ai-model] 也可以手动从 Hugging Face 下载所有文件放到上述目标目录。');
  process.exit(1);
});
