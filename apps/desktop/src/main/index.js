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

  ipcMain.handle('profile:update', async (event, { displayName }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const user = await apiClient.updateProfile(token, displayName)
      authStore.setSession(token, user)
      return { success: true, user }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('auth:changePassword', async (event, { currentPassword, newPassword }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.changePassword(token, currentPassword, newPassword)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('auth:deleteAccount', async () => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.deleteAccount(token)
      authStore.clearStoredToken()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('subjects:list', async () => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      return { success: true, subjects: await apiClient.listSubjects(token) }
    } catch (error) {
      return { success: false, error: error.message }
    }
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

  ipcMain.handle('interviews:create', async (event, { title, subjectIds }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const interview = await apiClient.createInterview(token, title, subjectIds)
      return { success: true, interview }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('interviews:update', async (event, { interviewId, updates }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const interview = await apiClient.updateInterview(token, interviewId, updates)
      return { success: true, interview }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('interviews:delete', async (event, { interviewId }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.deleteInterview(token, interviewId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('history:list', async (event, { interviewId, limit }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      return { success: true, entries: await apiClient.getHistory(token, interviewId, limit) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('history:deleteEntry', async (event, { interviewId, entryId }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.deleteHistoryEntry(token, interviewId, entryId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('history:clear', async (event, { interviewId }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.clearHistory(token, interviewId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ipcMain.handle is request/response, not streaming - this returns immediately once the
  // request is kicked off, and the actual answer arrives via repeated 'chat:event' sends
  // as each SSE frame from /chat/ask is parsed (see api-client.js's askQuestion).
  ipcMain.handle('chat:ask', async (event, { interviewId, question }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }

    apiClient
      .askQuestion(token, interviewId, question, (chatEvent) => {
        mainWindow?.webContents.send('chat:event', chatEvent)
      })
      .catch((error) => {
        mainWindow?.webContents.send('chat:event', { type: 'error', detail: error.message })
      })

    return { success: true }
  })

  ipcMain.handle('materials:list', async (event, { interviewId }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      return { success: true, materials: await apiClient.listMaterials(token, interviewId) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('materials:create', async (event, { interviewId, type, name, text }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      return { success: true, material: await apiClient.createMaterial(token, interviewId, type, name, text) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // bytes arrives as a Uint8Array over IPC (structured-clone safe); rewrapped into a
  // Buffer here since that's what api-client's FormData/Blob construction expects.
  ipcMain.handle('materials:upload', async (event, { interviewId, type, fileName, bytes }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const material = await apiClient.uploadMaterial(token, interviewId, type, fileName, Buffer.from(bytes))
      return { success: true, material }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('materials:update', async (event, { interviewId, materialId, updates }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const material = await apiClient.updateMaterial(token, interviewId, materialId, updates)
      return { success: true, material }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('materials:delete', async (event, { interviewId, materialId }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.deleteMaterial(token, interviewId, materialId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('qa:list', async (event, { interviewId, category, search }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const entries = await apiClient.listQa(token, interviewId, { category, search })
      return { success: true, entries }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('qa:create', async (event, { interviewId, question, answer }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      return { success: true, entry: await apiClient.createQa(token, interviewId, question, answer) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('qa:upload', async (event, { interviewId, fileName, bytes }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const entries = await apiClient.uploadQa(token, interviewId, fileName, Buffer.from(bytes))
      return { success: true, entries }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('qa:update', async (event, { interviewId, entryId, updates }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const entry = await apiClient.updateQa(token, interviewId, entryId, updates)
      return { success: true, entry }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('qa:delete', async (event, { interviewId, entryId }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      await apiClient.deleteQa(token, interviewId, entryId)
      return { success: true }
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
