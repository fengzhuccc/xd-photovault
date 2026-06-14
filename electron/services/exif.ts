import Exifr from 'exifr';
import sharp from 'sharp';
import { exiftool } from 'exiftool-vendored';
import log from 'electron-log';

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

      let width: number | null = null;
      let height: number | null = null;

      if (exif?.ExifImageWidth || exif?.ImageWidth) {
        width = exif.ExifImageWidth || exif.ImageWidth;
      }
      if (exif?.ExifImageHeight || exif?.ImageHeight) {
        height = exif.ExifImageHeight || exif.ImageHeight;
      }

      if (!width || !height) {
        try {
          const metadata = await sharp(filePath).metadata();
          width = metadata.width || width;
          height = metadata.height || height;
        } catch {
          // sharp 无法读取此文件格式
        }
      }

      if (!exif) {
        // exifr 读不到 EXIF，尝试用 exiftool 读取（支持 PNG 等格式）
        let fallbackTakenAt: Date | null = null;
        let fallbackLat: number | null = null;
        let fallbackLng: number | null = null;
        try {
          const etTags = await exiftool.read(filePath);
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
          const etTags = await exiftool.read(filePath);
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
        shutterSpeed: exif.ExposureTime ? `1/${Math.round(1 / exif.ExposureTime)}s` : null,
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
    let decimal = degrees + minutes / 60 + seconds / 3600;

    if (ref === 'S' || ref === 'W') {
      decimal = -decimal;
    }

    return decimal;
  }

  async writeDate(filePath: string, date: Date): Promise<void> {
    try {
      // 使用 AllDates 快捷标签同时写入 DateTimeOriginal、CreateDate、ModifyDate
      const dateStr = date.toISOString().replace('Z', '');
      await exiftool.write(filePath, {
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
      await exiftool.write(filePath, {
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
}
