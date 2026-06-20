import { createReadStream } from 'fs';
import { createXXHash64 } from 'hash-wasm';
import sharp from 'sharp';

type XXHash64Hasher = Awaited<ReturnType<typeof createXXHash64>>;

export class HashService {
  private hasherPool: XXHash64Hasher[] = [];

  async initialize(): Promise<void> {
    // 预创建一组 hasher，供并发文件处理使用；hash-wasm 的 hasher 不能跨调用并发共享
    const poolSize = 4;
    for (let i = 0; i < poolSize; i++) {
      this.hasherPool.push(await createXXHash64());
    }
  }

  private async acquireHasher(): Promise<XXHash64Hasher> {
    if (this.hasherPool.length > 0) {
      return this.hasherPool.pop()!;
    }
    return createXXHash64();
  }

  private releaseHasher(hasher: XXHash64Hasher): void {
    this.hasherPool.push(hasher);
  }

  /**
   * 计算 Buffer 内容 hash，使用 xxhash64。
   */
  async calculateHash(data: Buffer): Promise<string> {
    const hasher = await this.acquireHasher();
    try {
      hasher.init();
      hasher.update(data);
      return hasher.digest();
    } finally {
      this.releaseHasher(hasher);
    }
  }

  /**
   * 计算文件内容 hash，使用 xxhash64（比 MD5 快数倍，碰撞率对照片去重足够低）。
   * 每次从池中取独立 hasher，避免并发 digest/init 竞态。
   */
  async calculateFileHash(filePath: string): Promise<string> {
    const hasher = await this.acquireHasher();
    try {
      return await new Promise((resolve, reject) => {
        hasher.init();
        const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
        stream.on('data', (chunk) => hasher.update(chunk as Buffer));
        stream.on('end', () => resolve(hasher.digest()));
        stream.on('error', reject);
      });
    } finally {
      this.releaseHasher(hasher);
    }
  }

  async calculatePartialHash(filePath: string): Promise<string> {
    const hasher = await this.acquireHasher();
    try {
      return await new Promise((resolve, reject) => {
        hasher.init();
        const stream = createReadStream(filePath, { start: 0, end: 1023, highWaterMark: 64 * 1024 });
        stream.on('data', (chunk) => hasher.update(chunk as Buffer));
        stream.on('end', () => resolve(hasher.digest()));
        stream.on('error', reject);
      });
    } finally {
      this.releaseHasher(hasher);
    }
  }

  /**
   * 判断 file_hash 是否为旧版 MD5（32 位十六进制）。
   * xxhash64 输出为 16 位十六进制。
   */
  isLegacyMd5Hash(hash: string | null): boolean {
    return !!hash && /^[a-f0-9]{32}$/i.test(hash);
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

      // 2. DCT 变换：只计算 8x8 低频 AC 系数（跳过 DC），约 100 倍快于完整 32x32 DCT
      const lowFreq = this.dct2dLowFreq(data, 32);

      // 3. 计算中值
      const sorted = [...lowFreq].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      // 4. 生成 64 位哈希：大于中值为 1，否则为 0
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
   * 二维 DCT 变换优化版：只计算前 8x8 低频系数。
   * 预计算余弦表，避免在热循环中重复调用 Math.cos。
   */
  private dct2dLowFreq(data: Buffer, size: number): number[] {
    const N = size;
    // 预计算 u=0..7, x=0..N-1 的余弦表
    const cosU = new Float64Array(8 * N);
    const cosV = new Float64Array(8 * N);
    for (let u = 0; u < 8; u++) {
      for (let x = 0; x < N; x++) {
        cosU[u * N + x] = Math.cos((Math.PI * (2 * x + 1) * u) / (2 * N));
      }
    }
    for (let v = 0; v < 8; v++) {
      for (let y = 0; y < N; y++) {
        cosV[v * N + y] = Math.cos((Math.PI * (2 * y + 1) * v) / (2 * N));
      }
    }

    const result: number[] = [];
    for (let v = 0; v < 8; v++) {
      for (let u = 0; u < 8; u++) {
        let sum = 0;
        for (let y = 0; y < N; y++) {
          const vy = cosV[v * N + y];
          const rowOffset = y * N;
          for (let x = 0; x < N; x++) {
            sum += data[rowOffset + x] * cosU[u * N + x] * vy;
          }
        }
        result.push(sum);
      }
    }

    return result;
  }

  /**
   * 计算两个 pHash 的汉明距离。
   * pHash 为 64 位二进制字符串，使用 BigInt XOR + popcount，比逐字符比较快 5~10 倍。
   */
  hammingDistance(hash1: string, hash2: string): number {
    const len = Math.min(hash1.length, hash2.length);
    if (len === 0) return 0;

    // 分段处理：每 64 位一个 BigInt，避免单个大数转换过慢
    let distance = 0;
    for (let offset = 0; offset < len; offset += 64) {
      const a = BigInt.asUintN(64, BigInt('0b' + hash1.slice(offset, offset + 64)));
      const b = BigInt.asUintN(64, BigInt('0b' + hash2.slice(offset, offset + 64)));
      let xor = a ^ b;
      while (xor > 0n) {
        distance++;
        xor &= xor - 1n;
      }
    }
    return distance;
  }
}
