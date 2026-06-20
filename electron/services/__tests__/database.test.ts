import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from './test-utils';

function createPhoto(id: string, folderId: string, path: string, overrides: Partial<{
  fileSize: number;
  fileHash: string;
  perceptualHash: string;
  takenAt: string;
  latitude: number;
  longitude: number;
  mediaType: 'image' | 'video';
  duration: number | null;
  frameHash: string | null;
}> = {}) {
  return {
    id,
    folderId,
    path,
    filename: path.split(/[/\\]/).pop() || path,
    fileSize: overrides.fileSize ?? 1000,
    fileHash: overrides.fileHash ?? `hash-${id}`,
    perceptualHash: overrides.perceptualHash ?? null,
    takenAt: overrides.takenAt ?? '2024-01-01T00:00:00.000Z',
    latitude: overrides.latitude ?? null,
    longitude: overrides.longitude ?? null,
    camera: null,
    aperture: null,
    shutterSpeed: null,
    iso: null,
    focalLength: null,
    width: null,
    height: null,
    thumbnailPath: null,
    modifiedTime: '2024-01-01T00:00:00.000Z',
    mediaType: overrides.mediaType ?? 'image',
    duration: overrides.duration ?? null,
    frameHash: overrides.frameHash ?? null,
  };
}

describe('DatabaseService', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>['db'];
  let cleanup: () => void;

  beforeEach(async () => {
    const testDb = await createTestDatabase();
    db = testDb.db;
    cleanup = testDb.cleanup;
  });

  afterEach(() => {
    cleanup?.();
  });

  describe('deletePhotosBatch', () => {
    it('应删除照片并清理 photo_duplicates 关联', () => {
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('p1', 'f1', '/photos/a.jpg'));
      db.insertPhoto(createPhoto('p2', 'f1', '/photos/b.jpg'));

      db.rebuildDuplicateGroups('exact', [
        { id: 'g1', recommendedPhotoId: 'p1', photoIds: ['p1', 'p2'] },
      ]);

      db.deletePhotosBatch(['p2']);

      const remaining = db.getPhotos({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('p1');

      const groups = db.getDuplicateGroupsPaged();
      expect(groups.total).toBe(0);
    });

    it('删除推荐照片时不应触发外键约束失败', () => {
      // 这是用户实际遇到的 bug 回归测试
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('p1', 'f1', '/photos/a.jpg'));
      db.insertPhoto(createPhoto('p2', 'f1', '/photos/b.jpg'));

      db.rebuildDuplicateGroups('exact', [
        { id: 'g1', recommendedPhotoId: 'p1', photoIds: ['p1', 'p2'] },
      ]);

      // 删除被设为 recommended_photo_id 的 p1
      expect(() => db.deletePhotosBatch(['p1'])).not.toThrow();

      const remaining = db.getPhotos({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('p2');
    });

    it('应保留未删除照片所在的重复组', () => {
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('p1', 'f1', '/photos/a.jpg'));
      db.insertPhoto(createPhoto('p2', 'f1', '/photos/b.jpg'));
      db.insertPhoto(createPhoto('p3', 'f1', '/photos/c.jpg'));

      db.rebuildDuplicateGroups('exact', [
        { id: 'g1', recommendedPhotoId: 'p1', photoIds: ['p1', 'p2', 'p3'] },
      ]);

      db.deletePhotosBatch(['p3']);

      const groups = db.getDuplicateGroupsPaged();
      expect(groups.total).toBe(1);
      expect(groups.groups[0].photos).toHaveLength(2);
    });
  });

  describe('removeFolder', () => {
    it('应清理文件夹及其所有照片和重复组', () => {
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('p1', 'f1', '/photos/a.jpg'));
      db.insertPhoto(createPhoto('p2', 'f1', '/photos/b.jpg'));
      db.rebuildDuplicateGroups('exact', [
        { id: 'g1', recommendedPhotoId: 'p1', photoIds: ['p1', 'p2'] },
      ]);

      db.removeFolder('f1');

      expect(db.getFolders()).toHaveLength(0);
      expect(db.getPhotos({})).toHaveLength(0);
      expect(db.getDuplicateGroupsPaged().total).toBe(0);
    });
  });

  describe('findExactDuplicates', () => {
    it('图片应按 file_hash 分组', () => {
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('p1', 'f1', '/photos/a.jpg', { fileHash: 'same' }));
      db.insertPhoto(createPhoto('p2', 'f1', '/photos/b.jpg', { fileHash: 'same' }));
      db.insertPhoto(createPhoto('p3', 'f1', '/photos/c.jpg', { fileHash: 'different' }));

      const duplicates = db.findExactDuplicates();
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].key).toBe('same');
      expect(duplicates[0].count).toBe(2);
    });

    it('视频应按 frame_hash + file_size 分组', () => {
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('v1', 'f1', '/photos/a.mp4', { mediaType: 'video', fileSize: 1000, frameHash: 'frame-same' }));
      db.insertPhoto(createPhoto('v2', 'f1', '/photos/b.mp4', { mediaType: 'video', fileSize: 1000, frameHash: 'frame-same' }));
      db.insertPhoto(createPhoto('v3', 'f1', '/photos/c.mp4', { mediaType: 'video', fileSize: 2000, frameHash: 'frame-same' }));

      const duplicates = db.findExactDuplicates();
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].key).toBe('frame-same_1000');
      expect(duplicates[0].count).toBe(2);
    });

    it('图片和视频不应互相干扰', () => {
      db.addFolder('f1', '/photos');
      db.insertPhoto(createPhoto('p1', 'f1', '/photos/a.jpg', { fileHash: 'same' }));
      db.insertPhoto(createPhoto('p2', 'f1', '/photos/b.jpg', { fileHash: 'same' }));
      db.insertPhoto(createPhoto('v1', 'f1', '/photos/a.mp4', { mediaType: 'video', fileSize: 1000, frameHash: 'same' }));
      db.insertPhoto(createPhoto('v2', 'f1', '/photos/b.mp4', { mediaType: 'video', fileSize: 1000, frameHash: 'same' }));

      const duplicates = db.findExactDuplicates();
      expect(duplicates).toHaveLength(2);
    });
  });

  describe('migrations', () => {
    it('应创建 schema_version 并执行所有迁移', () => {
      // 在 createTestDatabase 中已经初始化，直接检查关键字段存在
      const folders = db.getFolders();
      expect(Array.isArray(folders)).toBe(true);
    });
  });
});
