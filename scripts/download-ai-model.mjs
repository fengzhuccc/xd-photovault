import { mkdirSync, existsSync, createWriteStream } from 'fs';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const MODEL_ID = 'Xenova/clip-vit-base-patch16';
const REVISION = 'main';
const TARGET_DIR = join(process.cwd(), 'resources', 'ai-models', MODEL_ID);
const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');
const DOWNLOAD_ALL = process.env.AI_DOWNLOAD_ALL === '1' || process.env.AI_DOWNLOAD_ALL === 'true';

// 默认只保留量化版 ONNX 模型，删除其他精度变体以减小打包体积
const SKIP_BY_DEFAULT = [
  /^onnx\/model\.onnx$/,
  /^onnx\/model_fp16\.onnx$/,
  /^onnx\/model_quantized\.onnx$/,
  /^onnx\/text_model\.onnx$/,
  /^onnx\/text_model_fp16\.onnx$/,
  /^onnx\/vision_model\.onnx$/,
  /^onnx\/vision_model_fp16\.onnx$/,
];

function shouldSkip(filePath) {
  if (DOWNLOAD_ALL) return false;
  return SKIP_BY_DEFAULT.some((pattern) => pattern.test(filePath));
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

async function main() {
  console.log(`[download-ai-model] 模型: ${MODEL_ID}`);
  console.log(`[download-ai-model] 下载源: ${HF_ENDPOINT}`);
  console.log(`[download-ai-model] 目标目录: ${TARGET_DIR}`);
  console.log('[download-ai-model] 正在获取文件列表...');

  const files = await fetchFileList(MODEL_ID, REVISION);
  const fileEntries = files.filter((f) => f.type === 'file');
  const totalBytes = fileEntries.reduce((sum, f) => sum + (f.size || 0), 0);

  const filesToDownload = fileEntries.filter((f) => !shouldSkip(f.path));
  const skippedFiles = fileEntries.filter((f) => shouldSkip(f.path));
  const downloadTotalBytes = filesToDownload.reduce((sum, f) => sum + (f.size || 0), 0);
  const skippedTotalBytes = skippedFiles.reduce((sum, f) => sum + (f.size || 0), 0);

  console.log(`[download-ai-model] 将下载 ${filesToDownload.length} 个文件，总计约 ${formatBytes(downloadTotalBytes)}`);
  if (skippedFiles.length > 0) {
    console.log(`[download-ai-model] 跳过 ${skippedFiles.length} 个非量化文件，总计约 ${formatBytes(skippedTotalBytes)}`);
    console.log('[download-ai-model] 如需下载全部版本，请设置 AI_DOWNLOAD_ALL=1');
  }
  console.log('[download-ai-model] 开始下载，请耐心等待（模型较大，可能需要几分钟）...\n');

  let downloadedBytes = 0;
  for (let i = 0; i < filesToDownload.length; i++) {
    const { path: filePath, size } = filesToDownload[i];
    const url = `${HF_ENDPOINT}/${MODEL_ID}/resolve/${REVISION}/${filePath}`;
    const targetPath = join(TARGET_DIR, filePath);

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

  console.log('\n[download-ai-model] 模型下载完成');
  console.log(`[download-ai-model] 本地路径: ${TARGET_DIR}`);
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
