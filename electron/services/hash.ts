import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

export class HashService {
  async calculateFileHash(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    return createHash('md5').update(buffer).digest('hex');
  }

  async calculatePartialHash(filePath: string): Promise<string> {
    const buffer = await readFile(filePath, { start: 0, end: 1023 });
    return createHash('md5').update(buffer).digest('hex');
  }

  calculatePerceptualHash(imageData: Buffer): string {
    return createHash('md5').update(imageData).digest('hex').substring(0, 16);
  }

  hammingDistance(hash1: string, hash2: string): number {
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) {
        distance++;
      }
    }
    return distance;
  }
}
