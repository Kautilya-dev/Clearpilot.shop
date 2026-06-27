const { app, BrowserWindow, ipcMain, shell, session, desktopCapturer } = require('electron')
const http = require('http')
const path = require('path')
const StealthManager = require('../modules/stealthManager')
const authStore = require('./auth-store')
const apiClient = require('./api-client')
const settingsStore = require('./settings-store')
const RealtimeSessionManager = require('./realtimeSessionManager')

let mainWindow = null
let stealth = null
let callbackServer = null

// One RealtimeSessionManager per device, started/stopped independently via the
// listening:* IPC handlers below. Both can be active simultaneously (Judge mode).
let speakerSession = null
let micSession = null
let speakerStopIntentional = false
let micStopIntentional = false

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  stealth = new StealthManager(mainWindow, null)

  // Re-apply last session's window/behavior preferences - settings.json persists across
  // launches, but BrowserWindow options above don't read from it directly.
  const settings = settingsStore.getAll()
  mainWindow.setOpacity(settings.window.opacity)
  mainWindow.setAlwaysOnTop(settings.window.alwaysOnTop)
  if (settings.behavior.stealthMode) stealth.toggleStealth(true)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // System/speaker audio loopback capture - getDisplayMedia always requires a video
  // constraint even when only audio is wanted, so the renderer requests a throwaway 1x1
  // video track alongside it; this just fulfills that request with real screen + loopback.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}))
  })

  // Mic capture (getUserMedia) is permission-gated separately from display media.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['microphone', 'media', 'audioCapture'].includes(permission))
  })
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
  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

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

  ipcMain.handle('settings:get', async () => {
    return { success: true, settings: settingsStore.getAll() }
  })

  // A single entry point for all persisted preferences - window.opacity/alwaysOnTop are
  // also applied live to the real window here, since settings.json alone doesn't affect
  // the already-open BrowserWindow. behavior.stealthMode is persisted only; the renderer
  // calls stealth:toggle separately for the actual OS-level effect (kept as two calls so
  // this handler doesn't need to know about StealthManager's own success/error shape).
  ipcMain.handle('settings:save', async (event, updates) => {
    const settings = settingsStore.save(updates)
    if (updates.window?.opacity !== undefined) mainWindow?.setOpacity(updates.window.opacity)
    if (updates.window?.alwaysOnTop !== undefined) mainWindow?.setAlwaysOnTop(updates.window.alwaysOnTop)
    return { success: true, settings }
  })

  // true when both sessions run together (Job Mode) — used to update mic instructions
  // with the speaker's suggestion so the judge has context.
  let isJobMode = false

  const SAP_INSTRUCTIONS =
    'You are an expert SAP CPI (Cloud Integration) interview assistant. ' +
    "Listen to the interviewer's question and respond with a clear, concise, accurate answer. " +
    'Focus on SAP Integration Suite, CPI iFlows, adapters, mappings, security, and best practices. ' +
    'Keep answers under 5 sentences unless a detailed explanation is needed.'

  const JUDGE_INITIAL_INSTRUCTIONS =
    'You are an interview coach in Job Mode. Listen to what the candidate says. ' +
    'When they finish speaking, give 2-3 sentences of feedback: what they said well and one specific thing to improve.'

  function judgeInstructionsWithSuggestion(suggestion) {
    return (
      `You are an interview coach. The ideal answer to the interviewer's question was: "${suggestion}". ` +
      "Now listen to what the candidate actually says. When they finish, give 2-3 sentences of feedback: " +
      'what they said well compared to the ideal answer, and one specific thing to improve.'
    )
  }

  async function startSingleSession(interviewId, source, instructions, isRetry = false) {
    const apiKey = settingsStore.getAll().openai?.apiKey
    if (!apiKey) return { success: false, error: 'OpenAI API key not set. Add it in Settings.' }
    try {
      const manager = new RealtimeSessionManager(apiKey)
      manager.setQuestionCallback((text) => {
        mainWindow?.webContents.send('listening:question', { source, text })
      })
      manager.setAnswerCallback((text) => {
        mainWindow?.webContents.send('listening:answer', { source, text })
        // Job Mode: when speaker GPT answers, inject that suggestion into the mic judge session
        // so it has context when the candidate speaks.
        if (isJobMode && source === 'speaker' && micSession) {
          micSession.updateInstructions(judgeInstructionsWithSuggestion(text))
        }
      })
      manager.setErrorCallback(async (error) => {
        const wasIntentional = source === 'speaker' ? speakerStopIntentional : micStopIntentional
        if (wasIntentional || isRetry) {
          mainWindow?.webContents.send('listening:error', { source, message: error.message })
          return
        }
        // One silent reconnect on transient disconnect before surfacing error to UI.
        const retryResult = await startSingleSession(interviewId, source, instructions, true)
        if (!retryResult.success) {
          mainWindow?.webContents.send('listening:error', { source, message: error.message })
        }
      })
      await manager.connect(instructions)
      if (source === 'speaker') {
        speakerSession = manager
        speakerStopIntentional = false
      } else {
        micSession = manager
        micStopIntentional = false
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }

  async function startListeningSession(interviewId, source) {
    if (source === 'both') {
      isJobMode = true
      // Start both sessions concurrently — speaker as SAP assistant, mic as judge
      const [sr, mr] = await Promise.all([
        startSingleSession(interviewId, 'speaker', SAP_INSTRUCTIONS),
        startSingleSession(interviewId, 'mic', JUDGE_INITIAL_INSTRUCTIONS)
      ])
      if (!sr.success) return sr
      if (!mr.success) return mr
      return { success: true }
    }
    isJobMode = false
    const instructions = source === 'speaker' ? SAP_INSTRUCTIONS : JUDGE_INITIAL_INSTRUCTIONS
    return startSingleSession(interviewId, source, instructions)
  }

  ipcMain.handle('listening:start', async (event, { interviewId, source }) => {
    return startListeningSession(interviewId, source)
  })

  ipcMain.handle('listening:stop', async (event, { source }) => {
    if (source === 'speaker' || source === 'both') {
      speakerStopIntentional = true
      speakerSession?.disconnect()
      speakerSession = null
    }
    if (source === 'mic' || source === 'both') {
      micStopIntentional = true
      micSession?.disconnect()
      micSession = null
    }
    if (source === 'both') isJobMode = false
    return { success: true }
  })

  ipcMain.handle('listening:audioChunk', async (event, { source, base64Data }) => {
    const targetSession = source === 'speaker' ? speakerSession : micSession
    if (!targetSession) return { success: false, message: 'No active session' }
    return targetSession.sendAudioChunk(Buffer.from(base64Data, 'base64'))
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
