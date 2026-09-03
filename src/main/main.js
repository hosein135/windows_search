'use strict';

/**
 * Electron main process (Node.js):
 * owns the MongoDB connection, the importer, and all file/DB access.
 * The renderer owns the GPU (WebGPU) and the UI.
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');
const db = require('./db');
const { registerIpc } = require('./ipc');

const DATABASES_DIR = path.join(app.getAppPath(), 'databases');

let win = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#101418',
    title: 'Windows Search (demo) - MongoDB + GPU',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  registerIpc({ databasesDir: DATABASES_DIR, getWindow: () => win });

  // Mongo is required for search/import but the GUI still opens without it,
  // so the user can see the hardware inventory and the setup instructions.
  try {
    await db.connect();
    await db.ensureIndexes();
    console.log('[mongo] connected:', db.DEFAULT_URL, 'db:', db.DB_NAME);
  } catch (err) {
    console.warn('[mongo] not reachable yet:', err.message);
  }

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  await db.close().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
