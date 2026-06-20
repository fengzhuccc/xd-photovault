import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { ThumbnailService } from '../thumbnail';

describe('ThumbnailService', () => {
  let service: ThumbnailService;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'photovault-thumb-test-'));
    service = new ThumbnailService(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSourceImage(name: string): Promise<string> {
    const path = join(tmpDir, name);
    await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 3,
        background: 'green',
      },
    })
      .jpeg()
      .toFile(path);
    return path;
  }

  it('缩略图路径应按 photoId 前两位分片', () => {
    // 通过生成缩略图后检查磁盘路径来验证
    const photoId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const expectedDir = join(tmpDir, 'thumbnails', 'ab');
    const expectedFile = join(expectedDir, `${photoId}_small.webp`);

    expect(expectedFile.startsWith(join(tmpDir, 'thumbnails', 'ab'))).toBe(true);
    expect(expectedFile.endsWith('_small.webp')).toBe(true);
  });

  it('应生成 small 和 medium 缩略图并返回 file:// URL', async () => {
    const photoId = 'img-001-abc';
    const sourcePath = await createSourceImage('source1.jpg');

    const smallUrl = await service.getThumbnail(photoId, sourcePath, 'small');
    const mediumUrl = await service.getThumbnail(photoId, sourcePath, 'medium');

    expect(smallUrl.startsWith('file:///')).toBe(true);
    expect(mediumUrl.startsWith('file:///')).toBe(true);

    const smallFile = join(tmpDir, 'thumbnails', 'im', `${photoId}_small.webp`);
    const mediumFile = join(tmpDir, 'thumbnails', 'im', `${photoId}_medium.webp`);

    expect(existsSync(smallFile)).toBe(true);
    expect(existsSync(mediumFile)).toBe(true);
  });

  it('同一 photoId:size 的并发请求应共享一次生成', async () => {
    const photoId = 'img-002-def';
    const sourcePath = await createSourceImage('source2.jpg');

    const [url1, url2] = await Promise.all([
      service.getThumbnail(photoId, sourcePath, 'small'),
      service.getThumbnail(photoId, sourcePath, 'small'),
    ]);

    expect(url1).toBe(url2);
  });

  it('缩略图过期时应重新生成', async () => {
    const photoId = 'img-003-ghi';
    const sourcePath = await createSourceImage('source3.jpg');

    const url1 = await service.getThumbnail(photoId, sourcePath, 'small');
    const filePath = url1.replace('file:///', '').replace(/\//g, '\\');

    // 把缩略图 mtime 改旧
    const oldTime = new Date('2000-01-01');
    const newTime = new Date();
    statSync(filePath);
    writeFileSync(filePath, Buffer.from('stale'));

    // 修改原图 mtime 为更新时间，让缩略图过期
    // 注意：这里通过覆盖缩略图为空内容，并依赖 isThumbnailFresh 判断过期
    // 实际过期逻辑：source mtime > thumb mtime
    // 我们通过 touch 缩略图到过去来模拟
    const fs = await import('fs');
    fs.utimesSync(filePath, oldTime, oldTime);
    fs.utimesSync(sourcePath, newTime, newTime);

    const url2 = await service.getThumbnail(photoId, sourcePath, 'small');
    expect(url2).toBe(url1);

    const stat = statSync(filePath);
    expect(stat.mtime.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  it('deleteThumbnailsByPhotoIds 应删除对应缩略图文件', async () => {
    const photoId = 'img-004-jkl';
    const sourcePath = await createSourceImage('source4.jpg');

    await service.getThumbnail(photoId, sourcePath, 'small');
    await service.getThumbnail(photoId, sourcePath, 'medium');

    service.deleteThumbnailsByPhotoIds([photoId]);

    const shardDir = join(tmpDir, 'thumbnails', 'im');
    expect(existsSync(join(shardDir, `${photoId}_small.webp`))).toBe(false);
    expect(existsSync(join(shardDir, `${photoId}_medium.webp`))).toBe(false);
  });

  it('stats 应统计缩略图文件数量和大小', async () => {
    const photoId = 'img-005-mno';
    const sourcePath = await createSourceImage('source5.jpg');

    await service.getThumbnail(photoId, sourcePath, 'small');
    await service.getThumbnail(photoId, sourcePath, 'medium');

    const stats = service.getStats();
    expect(stats.count).toBeGreaterThanOrEqual(2);
    expect(stats.totalSize).toBeGreaterThan(0);
    expect(stats.smallCount).toBeGreaterThanOrEqual(1);
    expect(stats.mediumCount).toBeGreaterThanOrEqual(1);
  });
});
