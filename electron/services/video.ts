import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { app } from 'electron';
import log from 'electron-log';

// 设置 ffmpeg 二进制路径（@ffmpeg-installer 会按平台自动选择）
// 打包后二进制文件位于 app.asar.unpacked，需要修正路径
const resolvedFfmpegPath = app.isPackaged
  ? ffmpegPath.replace(/app\.asar(?=\\|\/|$)/, 'app.asar.unpacked')
  : ffmpegPath;
ffmpeg.setFfmpegPath(resolvedFfmpegPath);

export interface VideoMetadata {
  duration: number;
  width: number | null;
  height: number | null;
}

export class VideoService {
  /**
   * 抽取视频第一帧，直接返回 JPEG Buffer，避免生成临时文件。
   */
  async extractFirstFrame(videoPath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const command = ffmpeg(videoPath)
        .seekInput(0)
        .frames(1)
        .outputFormat('image2')
        .on('error', (err) => {
          log.warn(`[VideoService] 抽取视频第一帧失败: ${videoPath}`, err.message);
          reject(err);
        });

      const stream = command.pipe();
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err: Error) => {
        log.warn(`[VideoService] 读取视频第一帧流失败: ${videoPath}`, err.message);
        reject(err);
      });
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
