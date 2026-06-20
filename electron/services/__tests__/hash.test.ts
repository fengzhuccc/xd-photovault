import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { HashService } from '../hash';

describe('HashService', () => {
  let hashService: HashService;
  let tmpDir: string;

  beforeAll(async () => {
    hashService = new HashService();
    await hashService.initialize();
    tmpDir = mkdtempSync(join(tmpdir(), 'photovault-hash-test-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const path = join(tmpDir, name);
    writeFileSync(path, content);
    return path;
  }

  async function createImage(name: string, color: string): Promise<string> {
    const path = join(tmpDir, name);
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: color,
      },
    })
      .jpeg()
      .toFile(path);
    return path;
  }

  describe('calculateFileHash', () => {
    it('相同内容应产生相同哈希', async () => {
      const path1 = writeFile('a.txt', 'hello world');
      const path2 = writeFile('b.txt', 'hello world');

      const hash1 = await hashService.calculateFileHash(path1);
      const hash2 = await hashService.calculateFileHash(path2);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{16}$/i);
    });

    it('不同内容应产生不同哈希', async () => {
      const path1 = writeFile('c.txt', 'hello world');
      const path2 = writeFile('d.txt', 'hello world!');

      const hash1 = await hashService.calculateFileHash(path1);
      const hash2 = await hashService.calculateFileHash(path2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('calculatePerceptualHash', () => {
    it('应返回 64 位二进制字符串', async () => {
      const path = await createImage('red.jpg', 'red');
      const phash = await hashService.calculatePerceptualHash(path);

      expect(phash).toHaveLength(64);
      expect(phash).toMatch(/^[01]{64}$/);
    });

    it('相同图片应产生相同 pHash', async () => {
      const path1 = await createImage('same1.jpg', '#1a1a1a');
      const path2 = await createImage('same2.jpg', '#1a1a1a');

      const phash1 = await hashService.calculatePerceptualHash(path1);
      const phash2 = await hashService.calculatePerceptualHash(path2);

      expect(phash1).toBe(phash2);
    });
  });

  describe('hammingDistance', () => {
    it('相同哈希距离为 0', () => {
      const hash = '0'.repeat(64);
      expect(hashService.hammingDistance(hash, hash)).toBe(0);
    });

    it('相差一位距离为 1', () => {
      const hash1 = '0'.repeat(63) + '0';
      const hash2 = '0'.repeat(63) + '1';
      expect(hashService.hammingDistance(hash1, hash2)).toBe(1);
    });

    it('完全相反距离为 64', () => {
      const hash1 = '0'.repeat(64);
      const hash2 = '1'.repeat(64);
      expect(hashService.hammingDistance(hash1, hash2)).toBe(64);
    });
  });

  describe('isLegacyMd5Hash', () => {
    it('32 位十六进制识别为旧版 MD5', () => {
      expect(hashService.isLegacyMd5Hash('a'.repeat(32))).toBe(true);
    });

    it('16 位十六进制识别为新版 xxhash64', () => {
      expect(hashService.isLegacyMd5Hash('a'.repeat(16))).toBe(false);
    });
  });
});
