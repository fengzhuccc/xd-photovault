import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MODEL_ID = 'Xenova/clip-vit-base-patch16';
const LOCAL_MODEL_PATH = join(process.cwd(), 'resources', 'ai-models');
const MODEL_DIR = join(LOCAL_MODEL_PATH, MODEL_ID);

// 一个最小的 1x1 红色 PNG（base64）
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  console.log('[verify-ai-model] 检查本地模型目录...');
  if (!existsSync(MODEL_DIR)) {
    console.error(`[verify-ai-model] 模型不存在: ${MODEL_DIR}`);
    console.error('[verify-ai-model] 请先运行: npm run download:ai-model');
    process.exit(1);
  }

  console.log('[verify-ai-model] 本地模型目录存在');
  console.log('[verify-ai-model] 正在加载 @xenova/transformers...');

  const transformers = await import('@xenova/transformers');
  transformers.env.localModelPath = LOCAL_MODEL_PATH;
  transformers.env.allowRemoteModels = false;

  console.log('[verify-ai-model] 正在加载模型组件...');
  const [tokenizer, textModel, processor, visionModel] = await Promise.all([
    transformers.AutoTokenizer.from_pretrained(MODEL_ID),
    transformers.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
    transformers.AutoProcessor.from_pretrained(MODEL_ID),
    transformers.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
  ]);

  console.log('[verify-ai-model] 测试文本编码...');
  const textInputs = tokenizer('a photo of a cat', { padding: true, truncation: true });
  const { text_embeds } = await textModel(textInputs);
  console.log(`[verify-ai-model] 文本向量维度: ${text_embeds.data.length}`);
  console.log(`[verify-ai-model] 前 5 维: ${Array.from(text_embeds.data).slice(0, 5).map(n => n.toFixed(4)).join(', ')}`);

  console.log('[verify-ai-model] 测试图像编码...');
  const testImagePath = join(tmpdir(), `photovault-ai-test-${Date.now()}.png`);
  writeFileSync(testImagePath, Buffer.from(TEST_PNG_BASE64, 'base64'));
  try {
    const image = await transformers.RawImage.read(testImagePath);
    const imageInputs = await processor(image);
    const { image_embeds } = await visionModel(imageInputs);
    console.log(`[verify-ai-model] 图像向量维度: ${image_embeds.data.length}`);
    console.log(`[verify-ai-model] 前 5 维: ${Array.from(image_embeds.data).slice(0, 5).map(n => n.toFixed(4)).join(', ')}`);
  } finally {
    try { unlinkSync(testImagePath); } catch {}
  }

  console.log('[verify-ai-model] 本地模型加载和推理均正常，内置方案验证通过');
}

main().catch((err) => {
  console.error('[verify-ai-model] 验证失败:', err.message);
  process.exit(1);
});
