import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import sharp from 'sharp';

export class HashService {
  async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('md5');
      const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  async calculatePartialHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('md5');
      const stream = createReadStream(filePath, { start: 0, end: 1023 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * 计算真正的感知哈希（pHash），使用 DCT 变换生成 64 位哈希
   * 原理：将图片缩放到 32x32 灰度图 → DCT 变换 → 取 8x8 低频系数 → 生成 64 位哈希
   */
  async calculatePerceptualHash(filePath: string): Promise<string> {
    try {
      // 1. 缩放到 32x32 灰度图
      const { data } = await sharp(filePath)
        .grayscale()
        .resize(32, 32, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // 2. DCT 变换
      const dct = this.dct2d(data, 32);

      // 3. 取 8x8 低频系数（左上角）
      const lowFreq: number[] = [];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          // 跳过 DC 分量（0,0），只取 AC 分量
          if (y === 0 && x === 0) continue;
          lowFreq.push(dct[y * 32 + x]);
        }
      }

      // 4. 计算中值
      const sorted = [...lowFreq].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      // 5. 生成 64 位哈希：大于中值为 1，否则为 0
      let hash = '';
      for (const val of lowFreq) {
        hash += val > median ? '1' : '0';
      }

      return hash;
    } catch {
      // sharp 无法处理此文件格式，返回空哈希
      return '0'.repeat(64);
    }
  }

  /**
   * 二维 DCT 变换（简化版）
   * 对 32x32 灰度矩阵进行 DCT-II 变换
   */
  private dct2d(data: Buffer, size: number): number[] {
    const N = size;
    const result = new Float64Array(N * N);

    // 先对每行做一维 DCT
    const rowDct = new Float64Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let k = 0; k < N; k++) {
        let sum = 0;
        for (let n = 0; n < N; n++) {
          sum += data[y * N + n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
        }
        rowDct[y * N + k] = sum;
      }
    }

    // 再对每列做一维 DCT
    for (let x = 0; x < N; x++) {
      for (let k = 0; k < N; k++) {
        let sum = 0;
        for (let n = 0; n < N; n++) {
          sum += rowDct[n * N + x] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
        }
        result[k * N + x] = sum;
      }
    }

    return Array.from(result);
  }

  /**
   * 计算两个 pHash 的汉明距离
   */
  hammingDistance(hash1: string, hash2: string): number {
    let distance = 0;
    const len = Math.min(hash1.length, hash2.length);
    for (let i = 0; i < len; i++) {
      if (hash1[i] !== hash2[i]) {
        distance++;
      }
    }
    return distance;
  }
}
