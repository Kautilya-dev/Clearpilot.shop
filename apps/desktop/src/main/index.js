const { app, BrowserWindow, ipcMain, shell } = require('electron')
const http = require('http')
const path = require('path')
const StealthManager = require('../modules/stealthManager')
const authStore = require('./auth-store')
const apiClient = require('./api-client')

let mainWindow = null
let stealth = null
let callbackServer = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  stealth = new StealthManager(mainWindow, null)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function closeCallbackServer() {
  if (callbackServer) {
    callbackServer.close()
    callbackServer = null
  }
}

// Starts a one-shot local HTTP server, opens the system browser to log in, and tears the
// server down once a callback arrives (or after a timeout). A plain http://127.0.0.1
// request needs no OS-level registration, unlike a custom URL protocol (clearpilot://) -
// which, on this Windows dev setup, registered correctly in the registry but the OS still
// silently wouldn't invoke it, with no error at any layer. This local-server pattern is
// the same one `gh auth login --web` and `gcloud auth login` use, specifically for this
// reliability reason.
function startBrowserSignIn() {
  if (callbackServer) return // a sign-in attempt is already in flight

  callbackServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      '<html><body style="font-family: sans-serif; text-align: center; padding: 4rem;">' +
        '<h2>Signed in</h2><p>You can close this tab and return to ClearPilot Desktop.</p>' +
        '</body></html>'
    )
    closeCallbackServer()

    if (!code) {
      mainWindow?.webContents.send('auth:loginFailed', 'No code received')
      return
    }
    try {
      const { access_token } = await apiClient.desktopExchange(code)
      const user = await apiClient.getCurrentUser(access_token)
      authStore.saveToken(access_token)
      authStore.setSession(access_token, user)
      mainWindow?.webContents.send('auth:loggedIn', user)
    } catch (error) {
      console.error('Desktop sign-in callback failed:', error)
      mainWindow?.webContents.send('auth:loginFailed', error.message)
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  callbackServer.listen(0, '127.0.0.1', () => {
    const port = callbackServer.address().port
    shell.openExternal(`${apiClient.BASE_URL}/login?desktop=1&port=${port}`)
  })

  // Don't let a never-completed sign-in attempt hold the server open forever - matches
  // the 5-minute TTL on the exchange code itself (see services/desktop_auth_service.py).
  setTimeout(closeCallbackServer, 5 * 60 * 1000)
}

function registerIpcHandlers() {
  ipcMain.handle('auth:openBrowserSignIn', () => {
    startBrowserSignIn()
  })

  // Called on app startup to decide which screen to show first - recovers and validates
  // a stored token if one exists, rather than always forcing a fresh sign-in.
  ipcMain.handle('auth:getCurrentUser', async () => {
    if (authStore.getCachedUser()) {
      return { success: true, user: authStore.getCachedUser() }
    }
    const token = authStore.loadStoredToken()
    if (!token) return { success: false }
    try {
      const user = await apiClient.getCurrentUser(token)
      authStore.setSession(token, user)
      return { success: true, user }
    } catch (error) {
      // Expired, undecryptable, or the backend rejected it - either way the right move
      // is the same: clear it and fall back to sign-in. Don't try to distinguish why.
      authStore.clearStoredToken()
      return { success: false }
    }
  })

  ipcMain.handle('auth:logout', async () => {
    authStore.clearStoredToken()
    return { success: true }
  })

  ipcMain.handle('interviews:list', async () => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const interviews = await apiClient.listInterviews(token)
      return { success: true, interviews }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('stealth:toggle', async (event, enabled) => {
    if (!stealth) return { success: false, error: 'Stealth not initialized' }
    return await stealth.toggleStealth(enabled)
  })

  ipcMain.handle('stealth:getStatus', async () => {
    if (!stealth) return { success: false, error: 'Stealth not initialized' }
    return stealth.getStatus()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    createWindow()
    registerIpcHandlers()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
