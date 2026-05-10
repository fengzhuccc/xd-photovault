import { v4 as uuidv4 } from 'uuid';

const mockPhotos = generateMockPhotos(150);

function generateMockPhotos(count: number) {
  const cameras = ['iPhone 14 Pro', 'Sony A7III', 'Canon EOS R5', 'Nikon Z6', 'Google Pixel 7'];
  const locations = [
    { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
    { lat: 48.8566, lng: 2.3522, name: 'Paris' },
    { lat: 40.7128, lng: -74.0060, name: 'New York' },
    { lat: 51.5074, lng: -0.1278, name: 'London' },
    { lat: 22.3193, lng: 114.1694, name: 'Hong Kong' },
    { lat: 37.5665, lng: 126.9780, name: 'Seoul' },
    { lat: 25.2048, lng: 55.2708, name: 'Dubai' },
    { lat: -33.8688, lng: 151.2093, name: 'Sydney' },
    { lat: 41.9028, lng: 12.4964, name: 'Rome' },
    { lat: 52.5200, lng: 13.4050, name: 'Berlin' },
  ];

  const photos = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const hasLocation = Math.random() > 0.3;
    const location = hasLocation ? locations[Math.floor(Math.random() * locations.length)] : null;
    const daysAgo = Math.floor(Math.random() * 365 * 3);
    const takenAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const imageSeed = `photo-${Math.floor(i / 5)}`;

    photos.push({
      id: uuidv4(),
      folder_id: 'folder-1',
      path: `/mock/photos/IMG_${10000 + i}.jpg`,
      filename: `IMG_${10000 + i}.jpg`,
      file_size: Math.floor(Math.random() * 8000000) + 1000000,
      taken_at: takenAt.toISOString(),
      latitude: location?.lat || null,
      longitude: location?.lng || null,
      width: [1920, 2560, 3840, 4000, 6000][Math.floor(Math.random() * 5)],
      height: [1080, 1440, 2160, 2670, 4000][Math.floor(Math.random() * 5)],
      camera: cameras[Math.floor(Math.random() * cameras.length)],
      thumbnail: null,
      image_seed: imageSeed,
    });
  }

  return photos.sort((a, b) => 
    new Date(b.taken_at!).getTime() - new Date(a.taken_at!).getTime()
  );
}

function generateDuplicates() {
  const groups = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < mockPhotos.length - 1; i++) {
    if (usedIndices.has(i)) continue;
    
    if (Math.random() > 0.85) {
      const duplicateCount = Math.floor(Math.random() * 3) + 2;
      const groupPhotos = [mockPhotos[i]];
      usedIndices.add(i);
      const originalSeed = mockPhotos[i].image_seed;

      for (let j = 1; j < duplicateCount && i + j < mockPhotos.length; j++) {
        const dupPhoto = {
          ...mockPhotos[i],
          id: uuidv4(),
          filename: `IMG_${10000 + i}_copy${j}.jpg`,
          path: `/mock/photos/IMG_${10000 + i}_copy${j}.jpg`,
          file_size: mockPhotos[i].file_size + Math.floor(Math.random() * 100000) - 50000,
          image_seed: originalSeed,
        };
        groupPhotos.push(dupPhoto);
        usedIndices.add(i + j);
      }

      const recommended = groupPhotos.reduce((best, current) => {
        if (current.latitude && !best.latitude) return current;
        if (current.file_size > best.file_size) return current;
        return best;
      });

      groups.push({
        id: uuidv4(),
        reason: 'exact' as const,
        recommended_photo_id: recommended.id,
        photos: groupPhotos,
      });
    }
  }

  return groups;
}

export const mockApi = {
  dialog: {
    openFolder: async (): Promise<string | null> => {
      await delay(500);
      return '/Users/demo/Pictures';
    },
  },

  folder: {
    add: async (path: string) => {
      await delay(300);
      return { id: 'folder-1', path, isNew: true };
    },
    remove: async (_id: string) => {
      await delay(200);
    },
    getAll: async () => {
      await delay(100);
      return [
        {
          id: 'folder-1',
          path: '/Users/demo/Pictures',
          added_at: '2024-01-15T10:30:00Z',
          last_scanned: '2024-01-20T14:22:00Z',
          photo_count: mockPhotos.length,
        },
        {
          id: 'folder-2',
          path: '/Users/demo/Desktop/Photos Backup',
          added_at: '2024-02-01T08:15:00Z',
          last_scanned: '2024-02-10T16:45:00Z',
          photo_count: 89,
        },
      ];
    },
  },

  scan: {
    start: async (_folderId: string) => {
      await delay(2000);
      return { totalPhotos: mockPhotos.length, duplicates: 12 };
    },
    onProgress: (callback: (progress: any) => void) => {
      let current = 0;
      const total = mockPhotos.length;
      const interval = setInterval(() => {
        current += Math.floor(Math.random() * 50) + 10;
        if (current >= total) {
          current = total;
          callback({ current, total, currentFile: 'Complete', status: 'complete' });
          clearInterval(interval);
        } else {
          callback({
            current,
            total,
            currentFile: `IMG_${10000 + current}.jpg`,
            status: 'scanning',
          });
        }
      }, 100);
      return () => clearInterval(interval);
    },
  },

  photo: {
    getAll: async (filter?: any) => {
      await delay(100);
      let result = [...mockPhotos];

      if (filter?.hasLocation === true) {
        result = result.filter(p => p.latitude && p.longitude);
      } else if (filter?.hasLocation === false) {
        result = result.filter(p => !p.latitude || !p.longitude);
      }

      if (filter?.camera) {
        result = result.filter(p => p.camera === filter.camera);
      }

      if (filter?.limit) {
        result = result.slice(0, filter.limit);
      }

      return result;
    },
    getById: async (id: string) => {
      await delay(50);
      const photo = mockPhotos.find(p => p.id === id);
      if (!photo) return null;
      return {
        ...photo,
        file_hash: 'abc123def456',
        perceptual_hash: 'phash123',
        aperture: 'f/2.8',
        shutter_speed: '1/250s',
        iso: 400,
        focal_length: '50mm',
      };
    },
    getStats: async () => {
      await delay(50);
      const withLocation = mockPhotos.filter(p => p.latitude && p.longitude).length;
      return {
        total: mockPhotos.length,
        withLocation,
        withoutLocation: mockPhotos.length - withLocation,
        duplicates: 12,
        cameras: [
          { camera: 'iPhone 14 Pro', count: 45 },
          { camera: 'Sony A7III', count: 38 },
          { camera: 'Canon EOS R5', count: 28 },
          { camera: 'Nikon Z6', count: 22 },
          { camera: 'Google Pixel 7', count: 17 },
        ],
      };
    },
    updateLocation: async (_id: string, _lat: number, _lng: number) => {
      await delay(100);
    },
  },

  duplicate: {
    getAll: async () => {
      await delay(200);
      return generateDuplicates();
    },
    delete: async (_photoIds: string[]) => {
      await delay(500);
    },
  },

  thumbnail: {
    get: async (photoId: string, _photoPath?: string) => {
      const photo = mockPhotos.find(p => p.id === photoId);
      const seed = photo?.image_seed || photoId;
      return `https://picsum.photos/seed/${seed}/256/256`;
    },
  },
};

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

declare global {
  interface Window {
    api: typeof import('../../electron/preload').api;
  }
}

export { mockApi };
