import Exifr from 'exifr';
import sharp from 'sharp';

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
        return {
          ...this.getEmptyExif(),
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

      const make = exif.Make || '';
      const model = exif.Model || '';
      const camera = (make + ' ' + model).trim() || null;

      return {
        takenAt,
        latitude,
        longitude,
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
}
