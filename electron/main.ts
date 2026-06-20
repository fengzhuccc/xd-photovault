import { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import log from 'electron-log';
import { DatabaseService } from './services/database';
import { ScannerService } from './services/scanner';
import { HashService } from './services/hash';
import { ExifService } from './services/exif';
import { ThumbnailService } from './services/thumbnail';
import { VideoService } from './services/video';
import { ConfigService } from './services/config';

// 配置 electron-log
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';

let mainWindow: BrowserWindow | null = null;
let configService: ConfigService;
let db: DatabaseService;
let scanner: ScannerService;
let hashService: HashService;
let exifService: ExifService;
let thumbnailService: ThumbnailService;
let videoService: VideoService;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  Menu.setApplicationMenu(null);

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    show: false,
  };

  // macOS 专属标题栏样式
  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 16 };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 设置合理的 User-Agent，避免瓦片服务器拒绝请求
  mainWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // 生产环境也支持 Ctrl+Shift+I 打开 DevTools
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'I' && input.control && input.shift) {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }
}

async function initializeServices() {
  configService = new ConfigService();
  
  db = new DatabaseService(configService);
  await db.initialize();
  
  // 将数据库注入 ConfigService，使 logPath 等配置从数据库读取
  configService.setDatabase(db);
  
  hashService = new HashService();
  await hashService.initialize();
  exifService = new ExifService();
  const dataPath = configService.getDataPath();
  log.info('Using data path:', dataPath);
  videoService = new VideoService();
  thumbnailService = new ThumbnailService(dataPath, videoService);
  
  scanner = new ScannerService(db, hashService, exifService, thumbnailService, videoService);
  scanner.onProgress = (progress) => {
    mainWindow?.webContents.send('duplicate:progress', progress);
  };
  
  // S8: 检查并恢复中断的扫描
  const recovery = scanner.recoverInterruptedScans();
  if (recovery.recoveredCount > 0) {
    log.info(`[Main] 恢复了 ${recovery.recoveredCount} 个中断的扫描: ${recovery.folderPaths.join(', ')}`);
  }

  // 检查并清理中断的去重检测（方案 A：相似去重设脏标记，启动时清理）
  if (db.isDuplicateDetectionDirty('similar')) {
    log.warn('[Main] 检测到上次相似去重中断，清理相似组...');
    db.clearDuplicateGroupsByReason('similar');
    db.setDuplicateDetectionDirty('similar', false);
  }

  setupIpcHandlers();
  log.info('All services initialized');
}

function getLogPath(): string {
  const customPath = configService.getLogPath();
  if (customPath) {
    return customPath;
  }
  return log.transports.file.getFile().path;
}

function setupIpcHandlers() {
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择照片文件夹',
    });
    return result.filePaths[0] || null;
  });

  ipcMain.handle('dialog:openDataFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择数据存储位置',
      buttonLabel: '选择文件夹',
    });
    return result.filePaths[0] || null;
  });

  ipcMain.handle('dialog:openLogFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择日志存储位置',
      buttonLabel: '选择文件夹',
    });
    return result.filePaths[0] || null;
  });

  ipcMain.handle('config:get', async () => {
    return configService.getConfig();
  });

  ipcMain.handle('config:setDataPath', async (_event, path: string | null) => {
    configService.setDataPath(path);
    return { success: true, requiresRestart: true };
  });

  ipcMain.handle('config:getDataPath', async () => {
    return configService.getDataPath();
  });

  ipcMain.handle('config:setLogPath', async (_event, path: string | null) => {
    configService.setLogPath(path);
    if (path) {
      log.transports.file.resolvePathFn = () => join(path, 'photovault.log');
    } else {
      log.transports.file.resolvePathFn = undefined as unknown as typeof log.transports.file.resolvePathFn;
    }
    return { success: true };
  });

  ipcMain.handle('config:getLogPath', async () => {
    return getLogPath();
  });

  ipcMain.handle('folder:add', async (_event, path: string) => {
    return await scanner.addFolder(path);
  });

  ipcMain.handle('folder:replaceWithParent', async (_event, childFolderIds: string[], parentPath: string) => {
    return await scanner.replaceWithParentFolder(childFolderIds, parentPath);
  });

  ipcMain.handle('folder:remove', async (_event, id: string) => {
    // 如果该文件夹正在扫描，先安全停止扫描，避免删除过程中还在插入/更新数据
    if (scanner.isScanning) {
      await scanner.stopScan(id);
    }

    // 先获取照片列表用于清理缩略图，再删除数据库记录
    const photos = db.getPhotosByFolder(id);
    db.removeFolder(id);
    // 数据库删除后再清理缩略图文件
    if (photos.length > 0) {
      thumbnailService.deleteThumbnailsByPhotoIds(photos.map((p: { id: string }) => p.id));
    }
    // 清理孤立的缩略图文件（数据库中已无对应照片的）
    thumbnailService.cleanOrphanThumbnails(db);
  });

  ipcMain.handle('folder:getAll', async () => {
    return await db.getFolders();
  });

  ipcMain.handle('scan:start', async (_event, folderId: string, forceRescan: boolean = false) => {
    return await scanner.startScan(folderId, (progress) => {
      mainWindow?.webContents.send('scan:progress', progress);
    }, forceRescan);
  });

  ipcMain.handle('scan:isScanning', async () => {
    return scanner.isScanning;
  });

  ipcMain.handle('photo:getAll', async (_event, filter) => {
    return await db.getPhotos(filter);
  });

  ipcMain.handle('photo:getPage', async (_event, filter) => {
    return db.getPhotosPaged(filter);
  });

  ipcMain.handle('photo:getTimeline', async (_event, filter) => {
    return db.getTimeline(filter);
  });

  ipcMain.handle('photo:getOffsetByMonth', async (_event, filter, monthKey: string) => {
    return db.getPhotoOffsetByMonth(filter, monthKey);
  });

  ipcMain.handle('photo:getById', async (_event, id: string) => {
    return await db.getPhotoById(id);
  });

  ipcMain.handle('photo:getStats', async () => {
    return await db.getPhotoStats();
  });

  ipcMain.handle('duplicate:getAll', async (_event, limit?: number, offset?: number, reason?: 'exact' | 'similar') => {
    return await db.getDuplicateGroupsPaged(limit, offset, reason);
  });

  ipcMain.handle('duplicate:detectExact', async (_event, fullRebuild: boolean = true) => {
    return await scanner.detectExactDuplicates(fullRebuild);
  });

  ipcMain.handle('duplicate:detectSimilar', async (_event, fullRebuild: boolean = true) => {
    return await scanner.detectSimilarDuplicates(fullRebuild);
  });

  ipcMain.handle('duplicate:delete', async (_event, photoIds: string[]) => {
    return await scanner.deletePhotos(photoIds);
  });

  ipcMain.handle('photo:updateLocation', async (_event, id: string, lat: number, lng: number) => {
    // 先获取照片路径用于 EXIF 写入
    const photo = db.getPhotoById(id);
    if (!photo) throw new Error('照片不存在');
    // 先尝试写 EXIF，失败则只更新数据库
    try {
      await exifService.writeLocation(photo.path, lat, lng);
    } catch (e) {
      log.warn('[photo:updateLocation] EXIF 写入失败，仅更新数据库:', e);
    }
    db.updatePhotoLocation(id, lat, lng);
    return { success: true };
  });

  ipcMain.handle('photo:updateDate', async (_event, id: string, date: string) => {
    const photo = db.getPhotoById(id);
    if (!photo) throw new Error('照片不存在');
    try {
      await exifService.writeDate(photo.path, new Date(date));
    } catch (e) {
      log.warn('[photo:updateDate] EXIF 写入失败，仅更新数据库:', e);
    }
    db.updatePhotoDate(id, date);
    return { success: true };
  });

  ipcMain.handle('photo:delete', async (_event, photoIds: string[]) => {
    return await scanner.deletePhotos(photoIds);
  });

  ipcMain.handle('photo:getWithLocation', async () => {
    return db.getPhotosWithLocation();
  });

  ipcMain.handle('photo:getInBounds', async (_event, south: number, west: number, north: number, east: number) => {
    return db.getPhotosInBounds(south, west, north, east);
  });

  ipcMain.handle('photo:getClustersInBounds', async (_event, south: number, west: number, north: number, east: number, zoom: number) => {
    return db.getPhotoClustersInBounds(south, west, north, east, zoom);
  });

  // 地图设置
  ipcMain.handle('map:getSetting', async (_event, key: string) => {
    return db.getSetting(`map_${key}`);
  });

  ipcMain.handle('map:setSetting', async (_event, key: string, value: string) => {
    db.setSetting(`map_${key}`, value);
    return { success: true };
  });

  ipcMain.handle('thumbnail:get', async (_event, photoId: string, photoPath: string, size?: 'small' | 'medium') => {
    return await thumbnailService.getThumbnail(photoId, photoPath, size);
  });

  ipcMain.handle('thumbnail:getBatch', async (_event, items: { photoId: string; photoPath: string; size?: 'small' | 'medium' }[]) => {
    return await thumbnailService.getThumbnailsBatch(items);
  });

  ipcMain.handle('thumbnail:stats', async () => {
    return thumbnailService.getStats();
  });

  ipcMain.handle('thumbnail:clear', async () => {
    return await thumbnailService.clearThumbnails();
  });

  ipcMain.handle('database:clear', async () => {
    try {
      db.clearAllData();
      log.info('[Database] 数据库已清除');
      return { success: true };
    } catch (error) {
      log.error('[Database] 清除数据库失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 日志相关
  ipcMain.handle('log:getPath', async () => {
    return getLogPath();
  });

  ipcMain.handle('log:read', async (_event, lines: number = 200) => {
    try {
      const logFile = log.transports.file.getFile().path;
      if (!existsSync(logFile)) {
        return '暂无日志';
      }
      const content = readFileSync(logFile, 'utf-8');
      const allLines = content.trim().split('\n');
      const selectedLines = allLines.slice(-lines);
      return selectedLines.join('\n');
    } catch (error) {
      log.error('读取日志失败:', error);
      return '读取日志失败';
    }
  });

  ipcMain.handle('log:clear', async () => {
    try {
      const logFile = log.transports.file.getFile().path;
      if (existsSync(logFile)) {
        unlinkSync(logFile);
      }
      log.info('日志已清除');
      return { success: true };
    } catch (error) {
      log.error('清除日志失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('log:openFolder', async () => {
    const logFile = log.transports.file.getFile().path;
    const logDir = join(logFile, '..');
    if (existsSync(logDir)) {
      shell.openPath(logDir);
    }
    return { success: true };
  });

  ipcMain.handle('app:openPath', async (_event, filePath: string) => {
    const result = await shell.openPath(filePath);
    return { success: result === '', error: result || undefined };
  });
}

app.whenReady().then(async () => {
  try {
    // 应用自定义日志路径
    const customLogPath = configService?.getConfig?.().logPath;
    if (customLogPath) {
      if (!existsSync(customLogPath)) {
        mkdirSync(customLogPath, { recursive: true });
      }
      log.transports.file.resolvePathFn = () => join(customLogPath, 'photovault.log');
    }

    await initializeServices();
  } catch (err) {
    log.error('Failed to initialize services:', err);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
