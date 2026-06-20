import type { PhotoRow } from './database';

/**
 * 照片评分函数（纯函数，方便单元测试）。
 * 综合考虑 GPS、文件大小、分辨率、文件名规范性，避免单一条件直接胜出导致其他维度被忽略。
 * - 有 GPS：+100（位置信息珍贵）
 * - 文件大小：log2(size)*10（越大分越高，但用对数避免大文件垄断）
 * - 分辨率：像素数/1e6（百万像素）
 * - 文件名规范：不含 copy/副本/edited/修改/截图 等关键词 +10
 */
export function scorePhoto(p: PhotoRow): number {
  let score = 0;
  if (p.latitude && p.longitude) score += 100;
  score += Math.log2(Math.max(1, p.file_size)) * 10;
  score += ((p.width || 0) * (p.height || 0)) / 1000000;
  const name = (p.filename || '').toLowerCase();
  if (!/copy|副本|edited|修改|截图/.test(name)) score += 10;
  return score;
}
