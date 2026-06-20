import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import log from 'electron-log';

// 设置 ffmpeg 二进制路径（@ffmpeg-installer 会按平台自动选择）
ffmpeg.setFfmpegPath(ffmpegPath);

export interface VideoMetadata {
  duration: number;
  width: number | null;
  height: number | null;
}

export class VideoService {
  private tempDir: string;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), 'photovault-video-'));
  }

  /**
   * 抽取视频第一帧为临时图片，返回临时文件路径。
   * 调用方负责删除临时文件。
   */
  async extractFirstFrame(videoPath: string, outputPath?: string): Promise<string> {
    const targetPath = outputPath || join(this.tempDir, `frame-${Date.now()}.jpg`);

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(0)
        .frames(1)
        .output(targetPath)
        .on('end', () => resolve(targetPath))
        .on('error', (err) => {
          log.warn(`[VideoService] 抽取视频第一帧失败: ${videoPath}`, err.message);
          reject(err);
        })
        .run();
    });
  }

  /**
   * 读取视频元数据：时长、分辨率。
   */
  async getMetadata(videoPath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          log.warn(`[VideoService] 读取视频元数据失败: ${videoPath}`, err.message);
          return reject(err);
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        resolve({
          duration: metadata.format.duration || 0,
          width: videoStream?.width ?? null,
          height: videoStream?.height ?? null,
        });
      });
    });
  }
}
