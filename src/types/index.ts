export interface ScanProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'hashing' | 'complete' | 'idle';
}

export interface PhotoFilter {
  folderId?: string;
  dateStart?: string;
  dateEnd?: string;
  hasLocation?: boolean;
  camera?: string;
  limit?: number;
  offset?: number;
}

export interface Folder {
  id: string;
  path: string;
  added_at: string;
  last_scanned: string | null;
  photo_count: number;
}

export interface Photo {
  id: string;
  folder_id: string;
  path: string;
  filename: string;
  file_size: number;
  taken_at: string | null;
  latitude: number | null;
  longitude: number | null;
  width: number;
  height: number;
  camera: string | null;
  thumbnail: string | null;
  image_seed?: string;
}

export interface PhotoDetail extends Photo {
  file_hash: string;
  perceptual_hash: string;
  aperture: string | null;
  shutter_speed: string | null;
  iso: number | null;
  focal_length: string | null;
}

export interface DuplicateGroup {
  id: string;
  reason: 'exact' | 'similar';
  recommended_photo_id: string;
  photos: Photo[];
}

export interface PhotoStats {
  total: number;
  withLocation: number;
  withoutLocation: number;
  duplicates: number;
  folders: number;
  cameras: { camera: string; count: number }[];
}
