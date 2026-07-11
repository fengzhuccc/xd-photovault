import { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import log from 'electron-log';
import { DatabaseService } from './services/database';
import { ScannerService } from './services/scanner';
import { HashService } from './services/hash';
import { ExifService } from './services/exif';
import { ThumbnailService } from './services/thumbnail';
import { VideoService } from './services/video';
import { ConfigService } from './services/config';
import { AiIndexService } from './services/aiIndexService';
import { AiSearchService } from './services/aiSearchService';
import { AiEmbeddingService } from './services/aiEmbedding';
import { setAiConfig } from './services/aiConfig';

// 配置 electron-log
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';

// 启动耗时统计：从进程启动到 main.ts 脚本执行完毕
const startupBaseTime = Date.now();
log.info(`[Startup] main.ts loaded, process uptime: ${process.uptime() * 1000}ms, script load time: ${startupBaseTime}ms`);

let mainWindow: BrowserWindow | null = null;
let configService: ConfigService;
let db: DatabaseService;
let scanner: ScannerService;
let hashService: HashService;
let exifService: ExifService;
let thumbnailService: ThumbnailService;
let videoService: VideoService;
let aiIndexService: AiIndexService;
let aiSearchService: AiSearchService;
let aiEmbeddingService: AiEmbeddingService;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  Menu.setApplicationMenu(null);

  const iconPath = isDev
    ? join(process.cwd(), 'public/icon.png')
    : join(__dirname, '../dist/icon.png');

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#1a1a1a',
    icon: iconPath,
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
    log.info(`[Startup] window ready-to-show, elapsed: ${Date.now() - startupBaseTime}ms`);
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log.info(`[Startup] window did-finish-load, elapsed: ${Date.now() - startupBaseTime}ms`);
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

  // AI 语义搜索服务（模型按需加载，启动时不初始化）
  const bundledModelPath = app.isPackaged
    ? join(process.resourcesPath, 'ai-models')
    : join(process.cwd(), 'resources', 'ai-models');
  log.info('[Main] AI 模型内置路径:', bundledModelPath);

  // 读取用户是否开启 GPU 加速
  const aiUseGpu = db.getSetting('ai_use_gpu') === 'true';
  setAiConfig({ useGpu: aiUseGpu });
  log.info('[Main] AI GPU 加速:', aiUseGpu ? '已开启' : '已关闭');

  aiEmbeddingService = new AiEmbeddingService(dataPath, bundledModelPath, { useGpu: aiUseGpu });
  aiIndexService = new AiIndexService(db, dataPath, aiEmbeddingService);
  aiIndexService.onProgress((progress) => {
    mainWindow?.webContents.send('aiIndex:progress', progress);
    // 索引完成或取消后清除搜索缓存，使下次搜索加载新 embedding
    if (progress.status === 'complete' || progress.status === 'idle') {
      aiSearchService.invalidateCache();
    }
  });
  aiSearchService = new AiSearchService(db, dataPath, aiEmbeddingService);
  
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
      // M-8: 从文件尾部读取，避免大日志文件全部读入内存
      const fileSize = statSync(logFile).size;
      const maxBytes = Math.min(fileSize, lines * 512); // 估算每行最多 512 字节
      const fd = openSync(logFile, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const bytesRead = readSync(fd, buffer, 0, maxBytes, fileSize - maxBytes);
        const content = buffer.slice(0, bytesRead).toString('utf-8');
        const allLines = content.trim().split('\n');
        const selectedLines = allLines.slice(-lines);
        return selectedLines.join('\n');
      } finally {
        closeSync(fd);
      }
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

  // AI 语义搜索
  ipcMain.handle('aiSearch:search', async (_event, query: string, limit?: number) => {
    try {
      const results = await aiSearchService.search(query, limit ?? 50);
      return { success: true, results };
    } catch (error) {
      log.error('[AI] 搜索失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // AI 索引后台任务
  ipcMain.handle('aiIndex:start', async () => {
    if (aiIndexService.isRunning()) return { success: true, message: '索引已在运行' };
    // 异步启动，不阻塞 IPC 响应
    aiIndexService.start().catch((error) => {
      log.error('[AI] 索引任务启动失败:', error);
    });
    return { success: true, message: '索引已启动' };
  });

  ipcMain.handle('aiIndex:pause', async () => {
    aiIndexService.pause();
    return { success: true };
  });

  ipcMain.handle('aiIndex:resume', async () => {
    aiIndexService.resume();
    return { success: true };
  });

  ipcMain.handle('aiIndex:cancel', async () => {
    aiIndexService.cancel();
    return { success: true };
  });

  ipcMain.handle('aiIndex:getStatus', async () => {
    return aiIndexService.getStatus();
  });

  ipcMain.handle('aiIndex:getGpuStatus', async () => {
    const enabled = db.getSetting('ai_use_gpu') === 'true';
    return {
      enabled,
      actualProvider: aiEmbeddingService?.getActualExecutionProvider() ?? 'cpu',
    };
  });

  ipcMain.handle('aiIndex:setUseGpu', async (_event, enabled: boolean) => {
    try {
      db.setSetting('ai_use_gpu', enabled ? 'true' : 'false');
      setAiConfig({ useGpu: enabled });
      // 如果模型已经加载，重置模型状态，让下次 init() 按新配置重新加载
      if (aiEmbeddingService?.isReady()) {
        aiEmbeddingService.reset();
        log.info('[AI] GPU 设置已更改，模型已重置，下次索引将使用新配置');
      }
      return { success: true };
    } catch (error) {
      log.error('[AI] 设置 GPU 加速失败:', error);
      return { success: false, error: String(error) };
    }
  });
}

// 单实例模式：请求锁，若已有实例运行则退出当前进程
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.info('[App] 已有实例在运行，退出当前进程');
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    log.info('[App] 检测到第二次启动请求，聚焦到已有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  log.info(`[Startup] app.whenReady fired, elapsed: ${Date.now() - startupBaseTime}ms`);
  try {
    // 应用自定义日志路径
    const customLogPath = configService?.getConfig?.().logPath;
    if (customLogPath) {
      if (!existsSync(customLogPath)) {
        mkdirSync(customLogPath, { recursive: true });
      }
      log.transports.file.resolvePathFn = () => join(customLogPath, 'photovault.log');
    }

    const serviceStart = Date.now();
    await initializeServices();
    log.info(`[Startup] initializeServices done, elapsed: ${Date.now() - startupBaseTime}ms, service init cost: ${Date.now() - serviceStart}ms`);
  } catch (err) {
    log.error('Failed to initialize services:', err);
    dialog.showErrorBox('初始化失败', `服务初始化失败，应用将退出:\n${err instanceof Error ? err.message : String(err)}`);
    app.quit();
    return;
  }
  log.info(`[Startup] creating window, elapsed: ${Date.now() - startupBaseTime}ms`);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// H-4/H-5: 应用退出前清理资源（exiftool 进程、DB 连接、停止扫描）
app.on('before-quit', async (event) => {
  event.preventDefault();
  try {
    // 停止正在进行的扫描（设置取消标志，不等待完成）
    if (scanner?.isScanning && scanner['activeScanFolderId']) {
      scanner['cancelRequested'] = true;
    }
    // 终止 exiftool 子进程池
    await exifService?.dispose();
  } catch (err) {
    log.error('退出清理失败:', err);
  }
  // 关闭数据库连接（WAL checkpoint）
  try {
    db?.close();
  } catch {
    // ignore
  }
  app.exit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
