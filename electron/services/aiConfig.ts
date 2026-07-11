import { join } from 'path';
import log from 'electron-log';

export interface AiModelConfig {
  /** Hugging Face 模型名称（需兼容 @xenova/transformers） */
  model: string;
  /** 向量维度 */
  embeddingDim: number;
  /** 后台索引每批从数据库读取的照片数量 */
  indexBatchSize: number;
  /** 索引单张照片时内部推理的 batch size（CPU 建议 1，GPU 可适当增大） */
  inferenceBatchSize: number;
  /** 是否使用 GPU 加速（Windows 下使用 DirectML，失败自动回退 CPU） */
  useGpu: boolean;
  /** 语义搜索最小相似度阈值，低于此值的结果不返回 */
  searchMinSimilarity: number;
}

/** 默认模型：OpenAI CLIP ViT-B/16 的 ONNX 版本，支持简单中文查询。 */
export const DEFAULT_AI_CONFIG: AiModelConfig = {
  model: 'Xenova/clip-vit-base-patch16',
  embeddingDim: 512,
  indexBatchSize: 8,
  inferenceBatchSize: 1,
  useGpu: false,
  searchMinSimilarity: 0.28,
};

/** 中文 CLIP 示例配置（需自行准备 ONNX 权重）。 */
export const CHINESE_CLIP_CONFIG: AiModelConfig = {
  model: 'OFA-Sys/chinese-clip-vit-base-patch16',
  embeddingDim: 512,
  indexBatchSize: 4,
  inferenceBatchSize: 1,
  useGpu: false,
  searchMinSimilarity: 0.2,
};

let activeConfig: AiModelConfig = { ...DEFAULT_AI_CONFIG };

export function getAiConfig(): AiModelConfig {
  return activeConfig;
}

export function setAiConfig(config: Partial<AiModelConfig>): void {
  activeConfig = { ...activeConfig, ...config };
  log.info('[AI] 配置已更新:', activeConfig.model);
}

export function resetAiConfig(): void {
  activeConfig = { ...DEFAULT_AI_CONFIG };
}

/** 获取模型缓存目录 */
export function getModelCachePath(dataPath: string): string {
  return join(dataPath, 'ai-models');
}
