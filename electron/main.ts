import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import { join } from 'path';
import { DatabaseService } from './services/database';
import { ScannerService } from './services/scanner';
import { HashService } from './services/hash';
import { ExifService } from './services/exif';
import { ThumbnailService } from './services/thumbnail';

let mainWindow: BrowserWindow | null = null;
let db: DatabaseService;
let scanner: ScannerService;
let hashService: HashService;
let exifService: ExifService;
let thumbnailService: ThumbnailService;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  Menu.setApplicationMenu(null);
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    show: false,
  });

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
}

async function initializeServices() {
  const userDataPath = app.getPath('userData');
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  const dbPath = isDev 
    ? join(__dirname, '..', 'data')
    : join(userDataPath, 'data');
  
  console.log('Using database path:', dbPath);
  
  db = new DatabaseService(dbPath);
  await db.initialize();
  
  hashService = new HashService();
  exifService = new ExifService();
  thumbnailService = new ThumbnailService(dbPath);
  
  scanner = new ScannerService(db, hashService, exifService, thumbnailService);
  
  setupIpcHandlers();
}

function setupIpcHandlers() {
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择照片文件夹',
    });
    return result.filePaths[0] || null;
  });

  ipcMain.handle('folder:add', async (_event, path: string) => {
    return await scanner.addFolder(path);
  });

  ipcMain.handle('folder:remove', async (_event, id: string) => {
    return await db.removeFolder(id);
  });

  ipcMain.handle('folder:getAll', async () => {
    return await db.getFolders();
  });

  ipcMain.handle('scan:start', async (_event, folderId: string) => {
    return await scanner.startScan(folderId, (progress) => {
      mainWindow?.webContents.send('scan:progress', progress);
    });
  });

  ipcMain.handle('photo:getAll', async (_event, filter) => {
    return await db.getPhotos(filter);
  });

  ipcMain.handle('photo:getById', async (_event, id: string) => {
    return await db.getPhotoById(id);
  });

  ipcMain.handle('photo:getStats', async () => {
    return await db.getPhotoStats();
  });

  ipcMain.handle('duplicate:getAll', async () => {
    return await db.getDuplicateGroups();
  });

  ipcMain.handle('duplicate:delete', async (_event, photoIds: string[]) => {
    return await scanner.deletePhotos(photoIds);
  });

  ipcMain.handle('photo:updateLocation', async (_event, id: string, lat: number, lng: number) => {
    return await db.updatePhotoLocation(id, lat, lng);
  });

  ipcMain.handle('thumbnail:get', async (_event, photoId: string, photoPath: string) => {
    return await thumbnailService.getThumbnail(photoId, photoPath);
  });
}

app.whenReady().then(async () => {
  await initializeServices();
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
