import Exifr from 'exifr';
import sharp from 'sharp';
import log from 'electron-log';

// 延迟加载 exiftool，避免应用启动时立即 fork Perl 子进程
let exiftoolPromise: Promise<typeof import('exiftool-vendored').exiftool> | null = null;

async function getExiftool() {
  if (!exiftoolPromise) {
    exiftoolPromise = import('exiftool-vendored').then((m) => m.exiftool);
  }
  return exiftoolPromise;
}

/** 格式化快门速度，正确处理长曝光（≥1秒）和除零情况 */
function formatShutterSpeed(exposureTime: number | undefined | null): string | null {
  if (!exposureTime || exposureTime === 0) return null;
  if (exposureTime >= 1) return `${exposureTime}s`;
  return `1/${Math.round(1 / exposureTime)}s`;
}

export interface ExifData {
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  width: number | null;
  height: number | null;
  camera: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  iso: number | null;
  focalLength: string | null;
}

export class ExifService {
  async extractExif(filePath: string): Promise<ExifData> {
    try {
      // S5: 先用 sharp 获取宽高（一次 I/O），避免后续再调 sharp
      let width: number | null = null;
      let height: number | null = null;
      try {
        const metadata = await sharp(filePath).metadata();
        width = metadata.width || null;
        height = metadata.height || null;
      } catch {
        // sharp 无法读取此文件格式
      }

      // 用 exifr 解析 EXIF
      const exif = await Exifr.parse(filePath, {
        pick: [
          'DateTimeOriginal',
          'CreateDate',
          'ModifyDate',
          'GPSLatitude',
          'GPSLongitude',
          'ImageWidth',
          'ImageHeight',
          'ExifImageWidth',
          'ExifImageHeight',
          'Make',
          'Model',
          'FNumber',
          'ExposureTime',
          'ISO',
          'FocalLength',
        ],
      });

      // EXIF 中的宽高优先于 sharp 的（EXIF 更准确）
      if (exif?.ExifImageWidth || exif?.ImageWidth) {
        width = exif.ExifImageWidth || exif.ImageWidth;
      }
      if (exif?.ExifImageHeight || exif?.ImageHeight) {
        height = exif.ExifImageHeight || exif.ImageHeight;
      }

      if (!exif) {
        // exifr 读不到 EXIF，尝试用 exiftool 读取（支持 PNG 等格式）
        let fallbackTakenAt: Date | null = null;
        let fallbackLat: number | null = null;
        let fallbackLng: number | null = null;
        try {
          const etTags = await (await getExiftool()).read(filePath);
          const etDate = etTags.DateTimeOriginal || etTags.CreateDate || etTags.ModifyDate;
          if (etDate) {
            fallbackTakenAt = etDate instanceof Date ? etDate : new Date(String(etDate));
          }
          if (etTags.GPSLatitude != null && etTags.GPSLongitude != null) {
            fallbackLat = typeof etTags.GPSLatitude === 'number' ? etTags.GPSLatitude : null;
            fallbackLng = typeof etTags.GPSLongitude === 'number' ? etTags.GPSLongitude : null;
          }
        } catch {
          // exiftool 也读不到，忽略
        }
        return {
          ...this.getEmptyExif(),
          takenAt: fallbackTakenAt,
          latitude: fallbackLat,
          longitude: fallbackLng,
          width,
          height,
        };
      }

      const latitude = this.convertGPS(
        exif.GPSLatitude,
        exif.GPSLatitudeRef
      );
      const longitude = this.convertGPS(
        exif.GPSLongitude,
        exif.GPSLongitudeRef
      );

      const takenAt = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || null;

      // exifr 读不到时，尝试用 exiftool 读取（支持 PNG 等格式）
      let finalTakenAt = takenAt;
      let finalLat = latitude;
      let finalLng = longitude;
      if (!finalTakenAt || (finalLat === null && finalLng === null)) {
        try {
          const etTags = await (await getExiftool()).read(filePath);
          if (!finalTakenAt) {
            const etDate = etTags.DateTimeOriginal || etTags.CreateDate || etTags.ModifyDate;
            if (etDate) {
              finalTakenAt = etDate instanceof Date ? etDate : new Date(String(etDate));
            }
          }
          if (finalLat === null && finalLng === null) {
            if (etTags.GPSLatitude != null && etTags.GPSLongitude != null) {
              finalLat = typeof etTags.GPSLatitude === 'number' ? etTags.GPSLatitude : null;
              finalLng = typeof etTags.GPSLongitude === 'number' ? etTags.GPSLongitude : null;
            }
          }
        } catch {
          // exiftool 也读不到，忽略
        }
      }

      const make = exif.Make || '';
      const model = exif.Model || '';
      const camera = (make + ' ' + model).trim() || null;

      return {
        takenAt: finalTakenAt,
        latitude: finalLat,
        longitude: finalLng,
        width,
        height,
        camera,
        aperture: exif.FNumber ? `f/${exif.FNumber}` : null,
        shutterSpeed: formatShutterSpeed(exif.ExposureTime),
        iso: exif.ISO || null,
        focalLength: exif.FocalLength ? `${exif.FocalLength}mm` : null,
      };
    } catch (error) {
      return this.getEmptyExif();
    }
  }

  private getEmptyExif(): ExifData {
    return {
      takenAt: null,
      latitude: null,
      longitude: null,
      width: null,
      height: null,
      camera: null,
      aperture: null,
      shutterSpeed: null,
      iso: null,
      focalLength: null,
    };
  }

  private convertGPS(
    coords: number[] | undefined,
    ref: string | undefined
  ): number | null {
    if (!coords || coords.length < 3) return null;

    const [degrees, minutes, seconds] = coords;
    // M-31: 验证坐标值有效性，过滤 NaN 和异常值
    if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }
    let decimal = degrees + minutes / 60 + seconds / 3600;

    if (ref === 'S' || ref === 'W') {
      decimal = -decimal;
    }

    // 验证最终坐标在合理范围内
    if (!Number.isFinite(decimal)) return null;

    return decimal;
  }

  async writeDate(filePath: string, date: Date): Promise<void> {
    try {
      // M-27: 使用本地时间格式化，避免 toISOString 转 UTC 后去 Z 导致时间偏移
      // EXIF 标准期望本地时间（无时区），格式 YYYY:MM:DD HH:MM:SS
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      await (await getExiftool()).write(filePath, {
        AllDates: dateStr,
      }, ['-overwrite_original']);
      log.info(`[ExifService] 写入日期成功: ${filePath}`);
    } catch (error) {
      log.error(`[ExifService] 写入日期失败: ${filePath}`, error);
      throw error;
    }
  }

  async writeLocation(filePath: string, lat: number, lng: number): Promise<void> {
    try {
      await (await getExiftool()).write(filePath, {
        GPSLatitude: lat,
        GPSLatitudeRef: lat >= 0 ? 'N' : 'S',
        GPSLongitude: lng,
        GPSLongitudeRef: lng >= 0 ? 'E' : 'W',
      }, ['-overwrite_original']);
      log.info(`[ExifService] 写入位置成功: ${filePath}`);
    } catch (error) {
      log.error(`[ExifService] 写入位置失败: ${filePath}`, error);
      throw error;
    }
  }

  /** 应用退出前终止 exiftool 子进程 */
  async dispose(): Promise<void> {
    try {
      if (exiftoolPromise) {
        const et = await exiftoolPromise;
        await et.end();
        exiftoolPromise = null;
      }
    } catch (error) {
      log.error('[ExifService] 终止 exiftool 失败:', error);
    }
  }
}
