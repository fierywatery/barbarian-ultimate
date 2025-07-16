const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

let mainWindow;
let serverProcess;
const windowStateFile = path.join(__dirname, 'window-state.json');

function saveWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const isMaximized = mainWindow.isMaximized();
    
    const currentDisplay = screen.getDisplayMatching(bounds);
    
    const windowState = { 
      bounds, 
      isMaximized,
      displayId: currentDisplay.id
    };
    
    
    try {
      fs.writeFileSync(windowStateFile, JSON.stringify(windowState));
    } catch (error) {
      console.error('Failed to save window state:', error);
    }
  }
}

function validateWindowBounds(bounds) {
  const displays = screen.getAllDisplays();
  
  if (bounds.x === undefined || bounds.y === undefined) {
    return { ...bounds, x: undefined, y: undefined };
  }
  
  const windowRect = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
  
  for (const display of displays) {
    const { x, y, width, height } = display.workArea;
    
    if (windowRect.x < x + width && 
        windowRect.x + windowRect.width > x &&
        windowRect.y < y + height && 
        windowRect.y + windowRect.height > y) {
      
      const adjustedBounds = { ...bounds };
      
      if (adjustedBounds.x < x) adjustedBounds.x = x;
      if (adjustedBounds.y < y) adjustedBounds.y = y;
      if (adjustedBounds.x + adjustedBounds.width > x + width) {
        adjustedBounds.x = x + width - adjustedBounds.width;
      }
      if (adjustedBounds.y + adjustedBounds.height > y + height) {
        adjustedBounds.y = y + height - adjustedBounds.height;
      }
      
      return adjustedBounds;
    }
  }
  
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.workArea;
  
  const newWidth = Math.min(bounds.width, width * 0.9);
  const newHeight = Math.min(bounds.height, height * 0.9);
  
  return {
    width: newWidth,
    height: newHeight,
    x: x + (width - newWidth) / 2,
    y: y + (height - newHeight) / 2
  };
}

function loadWindowState() {
  try {
    if (fs.existsSync(windowStateFile)) {
      const data = fs.readFileSync(windowStateFile, 'utf8');
      const state = JSON.parse(data);
      
      // Get the current primary display to ensure reasonable sizing
      const primaryDisplay = screen.getPrimaryDisplay();
      const { workArea } = primaryDisplay;
      
      const maxWidth = Math.floor(workArea.width * 0.9);
      const maxHeight = Math.floor(workArea.height * 0.9);
      
      let adjustedBounds = {
        width: state.bounds.width,
        height: state.bounds.height,
        x: state.bounds.x,
        y: state.bounds.y
      };
      
      adjustedBounds = validateWindowBounds(adjustedBounds);
      if (adjustedBounds.width > maxWidth) {
        adjustedBounds.width = maxWidth;
      }
      if (adjustedBounds.height > maxHeight) {
        adjustedBounds.height = maxHeight;
      }
      
      return {
        bounds: adjustedBounds,
        isMaximized: state.isMaximized || false
      };
    }
  } catch (error) {
    console.error('Failed to load window state:', error);
  }
  
  return {
    bounds: { width: 1600, height: 900, x: undefined, y: undefined },
    isMaximized: false
  };
}


function createWindow() {
  const windowState = loadWindowState();

  mainWindow = new BrowserWindow({
    ...windowState.bounds,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'public', 'favicon.ico'),
    show: false
  });

  const actualBounds = mainWindow.getBounds();
  if (actualBounds.width !== windowState.bounds.width || actualBounds.height !== windowState.bounds.height) {
    mainWindow.setBounds(windowState.bounds);
  }

  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load main window:', errorCode, errorDescription);
  });

  mainWindow.once('ready-to-show', () => {
    console.log('Main window ready to show');
    mainWindow.show();
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);

  mainWindow.on('closed', () => {
    saveWindowState();
    mainWindow = null;
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['server.js'], {
      stdio: 'pipe',
      cwd: __dirname,
      env: {
        ...process.env,
        ELECTRON_APP: 'true'
      }
    });

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`Server: ${output}`);
      
      if (output.includes('Server running on http://localhost:')) {
        console.log('Server is ready');
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server Error: ${data}`);
    });

    serverProcess.on('error', (error) => {
      console.error('Failed to start server:', error);
      reject(error);
    });
  });
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (error) {
    console.error('Failed to start application:', error);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});