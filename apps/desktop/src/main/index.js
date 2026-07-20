/* ABOUT THIS FILE
 * Electron main process - owns the BrowserWindow, all IPC handlers the renderer calls via
 * window.clearpilot (see src/preload/index.js for the bridge, src/renderer/src/*.jsx for
 * callers), the two Realtime API sessions (speaker/mic) used by both Copilot's standalone
 * listening and the Prompter tab, the Practice Partner WebSocket relay to the web app's
 * Prompter tab (apps/web/routers/practice.py), and the desktop auto-update flow (checks/
 * downloads/installs a new build via the same presigned-download endpoints the website's
 * Download page uses, apps/web/routers/downloads.py).
 */
const { app, BrowserWindow, ipcMain, shell, session, desktopCapturer } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const WebSocket = require('ws')
const StealthManager = require('../modules/stealthManager')
const authStore = require('./auth-store')
const apiClient = require('./api-client')
const settingsStore = require('./settings-store')
const RealtimeSessionManager = require('./realtimeSessionManager')

let mainWindow = null
let stealth = null
let callbackServer = null

// One RealtimeSessionManager per device, started/stopped independently via the
// listening:* IPC handlers below. speakerSession is shared by Copilot's standalone
// "Speaker" listening mode and the Prompter tab's AI Generated Response panel; micSession
// is only used by Copilot's standalone "Mic" mode now - the Prompter tab no longer listens
// to the candidate's mic at all (no AI judge/comparison feature - see JudgeTab.jsx's
// removal in favor of PrompterTab.jsx).
let speakerSession = null
let micSession = null
let speakerStopIntentional = false
let micStopIntentional = false

// Practice Partner relay: the desktop's Prompter tab connects to the backend's
// Redis-Pub/Sub relay (apps/web/routers/practice.py) so the web app's Prompter tab can
// stream its live transcript in here as the "Web Prompter Transcription" panel - keyed by
// interview_id, no join code needed since pairing is implicit (same account, same interview).
let practiceRelay = null

// Focus Mode shrinks the same window into a compact floating widget rather than opening a
// second BrowserWindow - this remembers what bounds to restore on Dashboard-return. Always-on-top
// is restored from the live persisted setting instead (see window:exitFocusMode) since the user
// can change that preference from Focus Mode's own Settings panel.
let priorBounds = null

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

  // Unlike auth:getCurrentUser above, this always hits the network - that one returns
  // authStore's in-memory cache when present, which is exactly wrong for "did this account's
  // preferences change on another device/the web app" checks. Settings screens call this on
  // mount so opening Settings always reflects the latest account state, not a stale login-time
  // snapshot.
  ipcMain.handle('auth:refreshCurrentUser', async () => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false }
    try {
      const user = await apiClient.getCurrentUser(token)
      authStore.setSession(token, user)
      return { success: true, user }
    } catch (error) {
      return { success: false, error: error.message }
    }
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

  ipcMain.handle('preferences:update', async (event, { answerFormatMode, answerLength }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const user = await apiClient.updatePreferences(token, answerFormatMode, answerLength)
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

  ipcMain.handle('admin:getUsers', async () => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const users = await apiClient.getAdminUsers(token)
      return { success: true, users }
    } catch (error) {
      // error.message is the backend's HTTPException detail verbatim (e.g. "Admin access
      // required" on 403) - AdminScreen matches on that exact string to show the denied state.
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('admin:getHistory', async () => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const entries = await apiClient.getAdminHistory(token)
      return { success: true, entries }
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

  // Focus Mode - shrink the existing window into a compact floating widget. Not a second
  // BrowserWindow, so opacity/stealth/always-on-top toggles from Settings keep applying to it.
  ipcMain.handle('window:enterFocusMode', () => {
    if (!mainWindow) return { success: false }
    if (priorBounds) return { success: true } // already compact - don't clobber the saved original bounds
    priorBounds = mainWindow.getBounds()
    mainWindow.setAlwaysOnTop(true) // forced on regardless of the user's Settings toggle
    const { x, y } = priorBounds
    mainWindow.setBounds({ x, y, width: 400, height: 560 })
    return { success: true }
  })

  ipcMain.handle('window:exitFocusMode', () => {
    if (!mainWindow) return { success: false }
    if (priorBounds) mainWindow.setBounds(priorBounds)
    // Read the live persisted preference, not an entry-time snapshot - the user can now change
    // Always On Top from the Settings panel embedded inside Focus Mode itself, and that change
    // should stick on exit rather than being reverted to whatever it was before Focus Mode opened.
    mainWindow.setAlwaysOnTop(settingsStore.getAll().window.alwaysOnTop)
    priorBounds = null
    return { success: true }
  })

  // Answer Template preference (account-level, shared with the web app) - shapes the
  // generated ANSWER only.
  const FORMAT_MODE_INSTRUCTIONS = {
    bullets: 'Structure the answer as bullet points covering the key ideas - the bullet that introduces a **bolded** term should also unpack it with a brief example.',
    star: 'Structure the answer using the STAR method: Situation, Task, Action, Result, labelling each part - keep each part to a sentence or two so the whole thing still fits the word-count target below.',
    concise: 'Give a single, direct sentence with no elaboration - even shorter than the word-count target below.',
    detailed: "Give a fuller explanation with real reasoning and a fully worked example - reach the word-count target below by going deeper on the 1-2 most important terms, not by trimming to a quick summary."
  }
  // Calibrated to actual spoken duration (~130-150 words/minute at a natural, measured
  // interview pace) rather than vague sentence counts, so "medium" reliably produces the
  // interview-perfect one-minute answer regardless of which format above shapes its structure.
  // Each range's lower bound is a floor to explicitly guard against the model's tendency to
  // undershoot a loose "roughly N words" target and default to a short summary instead.
  const ANSWER_LENGTH_INSTRUCTIONS = {
    short: 'Write at least 50 words, up to about 70 (roughly 20-30 seconds spoken aloud) - the fastest version, but still one full, complete sentence or two, not a fragment.',
    medium: 'Write at least 130 words, up to about 160 (roughly one minute spoken aloud) - the interview-perfect default. 130 words is a floor: if your answer is shorter, you stopped too early - go back and actually explain the reasoning and walk through one concrete example, don\'t just pad it. This should read as 4-6 full sentences of real substance, never a 2-sentence summary.',
    // Fallback only - "one_minute" is only selectable alongside star/detailed (see
    // STAR_DETAILED_LENGTH_INSTRUCTIONS below), but an account that saved this combo before
    // that restriction existed could still have it stored with a different format.
    one_minute: 'Write at least 130 words, up to about 160 (roughly one minute spoken aloud) - the interview-perfect default. 130 words is a floor: if your answer is shorter, you stopped too early - go back and actually explain the reasoning and walk through one concrete example, don\'t just pad it. This should read as 4-6 full sentences of real substance, never a 2-sentence summary.',
    long: 'Write at least 200 words, up to about 260 (roughly 90 seconds spoken aloud) - use this only when the question genuinely needs more depth (a multi-part scenario, a comparison). 200 words is a floor - go deeper with a second example or edge case rather than repeating the same point to pad it out.'
  }

  // STAR and Detailed have the structure to support a genuinely comprehensive answer, so for
  // these two formats "1 Minute" and "Long" mean a thorough, multi-angle answer rather than a
  // tight one-minute spoken one - a deliberate exception to the system prompt's "pick 2-3
  // points" guidance, only for this format+length combination.
  const STAR_DETAILED_LENGTH_INSTRUCTIONS = {
    one_minute:
      'Write a genuinely comprehensive answer, at least 500 words, up to about 650 - this is an intentional exception to the "pick 2-3 points" guidance. Structure it the way a thorough technical mentor would: the core answer with a concrete example, the practical nuance of when this applies versus when it doesn\'t (if relevant to the question), a real-world design pattern or approach you follow, and close with a short, tightly-distilled interview-ready version of the same answer (2-4 sentences) so the candidate has both the deep understanding and the quick spoken version ready.',
    long: 'Write a thorough answer, at least 300 words, up to about 450 - covering the core answer with a concrete example plus one layer of practical nuance (when it applies, a real design consideration), without needing every angle the most comprehensive answer would cover.'
  }

  function buildAnswerTemplateInstruction(answerFormatMode, answerLength) {
    const mode = FORMAT_MODE_INSTRUCTIONS[answerFormatMode] || FORMAT_MODE_INSTRUCTIONS.bullets
    const isStarOrDetailed = answerFormatMode === 'star' || answerFormatMode === 'detailed'
    const length =
      (isStarOrDetailed && STAR_DETAILED_LENGTH_INSTRUCTIONS[answerLength]) ||
      ANSWER_LENGTH_INSTRUCTIONS[answerLength] ||
      ANSWER_LENGTH_INSTRUCTIONS.medium
    return `${mode} ${length}`
  }

  // Realtime voice models default to mirroring whatever language they hear, unlike the
  // web app's text-only chat completions - so this needs to be stated explicitly here too
  // (matches apps/web/services/rag_service.py's SYSTEM_PROMPT_TEMPLATE rule 8) or a
  // question asked in Hindi/Telugu/etc. gets answered/coached in that same language.
  const ENGLISH_ONLY_INSTRUCTION =
    'Always respond in English only, regardless of what language you hear the interviewer, the candidate, or the practice partner speak in - never switch languages to match them.'

  function buildSapInstructions(answerFormatMode, answerLength) {
    return (
      'You are an expert SAP CPI (Cloud Integration) interview assistant. ' +
      "Listen to the interviewer's question and respond with a clear, accurate answer. " +
      'Focus on SAP Integration Suite, CPI iFlows, adapters, mappings, security, and best practices. ' +
      'Whenever you **bold** a key term, immediately follow it with a short concrete example or plain-language explanation of what it means in practice, so the candidate could explain it unprompted if the interviewer digs in. ' +
      `${ENGLISH_ONLY_INSTRUCTION} ` +
      buildAnswerTemplateInstruction(answerFormatMode, answerLength)
    )
  }

  function wsUrl(urlPath) {
    return apiClient.BASE_URL.replace(/^http/, 'ws') + urlPath
  }

  // Practice Partner mode's "host" (candidate) side - connects to the backend relay that
  // apps/web/pages/interview.html's Prompter tab (the "guest") also connects to, keyed by
  // interview_id so no join code is needed (same account owns both sides).
  function connectPracticeRelay(interviewId, token) {
    const url = `${wsUrl('/api/practice-relay/ws')}?interview_id=${interviewId}&role=host&token=${encodeURIComponent(token)}`
    console.log('[practice] connecting to relay:', url.replace(/token=[^&]+/, 'token=***'))
    practiceRelay = new WebSocket(url)
    practiceRelay.on('open', () => console.log('[practice] relay connected'))
    practiceRelay.on('close', (code) => console.log('[practice] relay closed, code:', code))
    practiceRelay.on('message', (data) => {
      let payload
      try {
        payload = JSON.parse(data.toString())
      } catch {
        return
      }
      console.log('[practice] received:', payload.type, payload.text ? `"${payload.text}"` : '')
      if (payload.type === 'transcript_final' && payload.text) {
        mainWindow?.webContents.send('practice:transcript', { text: payload.text })
      } else if (payload.type === 'guest_joined') {
        mainWindow?.webContents.send('practice:guestStatus', { connected: true })
      } else if (payload.type === 'guest_left') {
        mainWindow?.webContents.send('practice:guestStatus', { connected: false })
      }
    })
    practiceRelay.on('error', (error) => {
      console.error('[practice] relay error:', error.message)
      mainWindow?.webContents.send('practice:relayError', { message: error.message })
    })
  }

  function disconnectPracticeRelay() {
    practiceRelay?.close()
    practiceRelay = null
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
    // Fetched fresh (not from authStore's cached user) so a preference change made moments
    // ago on the web app - or on this app's own Settings without restarting - is honored
    // immediately. Session starts aren't a hot path, so the extra round-trip is cheap.
    const token = authStore.getCachedToken()
    const user = token ? await apiClient.getCurrentUser(token).catch(() => null) : null
    const sapInstructions = buildSapInstructions(user?.answer_format_mode || 'bullets', user?.answer_length || 'medium')

    if (source === 'prompter') {
      // Prompter tab's base session - just the Web Prompter Transcription relay. Needs no
      // OpenAI key at all, and must not depend on the Speaker session succeeding - the
      // renderer starts/stops that independently via source: 'speaker' below (same channel
      // Copilot's own standalone Speaker mode uses) so the AI Generated Response panel can
      // be genuinely enabled/disabled (not just hidden) without ever blocking the relay.
      if (!token) return { success: false, error: 'Not signed in' }
      connectPracticeRelay(interviewId, token)
      return { success: true }
    }
    // Copilot mode (single device) and the Prompter tab's AI Generated Response panel both
    // land here for source 'speaker'/'mic' - which one a given session's events are routed
    // to is decided client-side by the renderer's current listenMode, not here.
    return startSingleSession(interviewId, source, sapInstructions)
  }

  ipcMain.handle('listening:start', async (event, { interviewId, source }) => {
    return startListeningSession(interviewId, source)
  })

  ipcMain.handle('listening:stop', async (event, { source }) => {
    // 'prompter' only ever controls the relay now - it must NOT also stop 'speaker' here,
    // or the AI Generated Response panel's independent enable/disable (which stops/starts
    // 'speaker' on its own, see InterviewWorkspace.jsx) and the Prompter tab's own Stop
    // button would fight over the same speakerSession.
    if (source === 'speaker') {
      speakerStopIntentional = true
      speakerSession?.disconnect()
      speakerSession = null
    }
    if (source === 'mic') {
      micStopIntentional = true
      micSession?.disconnect()
      micSession = null
    }
    if (source === 'prompter') {
      disconnectPracticeRelay()
    }
    return { success: true }
  })

  ipcMain.handle('practice:saveSession', async (event, { interviewId, webTranscript, aiResponse }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const entry = await apiClient.savePrompterSession(token, interviewId, { webTranscript, aiResponse })
      return { success: true, entry }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('listening:audioChunk', async (event, { source, base64Data }) => {
    const targetSession = source === 'speaker' ? speakerSession : micSession
    if (!targetSession) return { success: false, message: 'No active session' }
    return targetSession.sendAudioChunk(Buffer.from(base64Data, 'base64'))
  })

  // Auto-update - fully user-triggered from Settings -> Update tab, nothing runs on launch.
  // Reuses the website's existing presigned-download infrastructure (downloads.py) instead
  // of a dedicated update-manifest host: /download/latest-version returns the current
  // release's version string, /download/windows is the same presigned installer URL the
  // website's Download page already uses. Downloads the full installer into memory (this
  // app is ~92MB - simple and reliable beats streaming-with-progress for a personal
  // project) and launches it silently (NSIS /S - this build is per-user/no-elevation, see
  // package.json's build.nsis config, so no UAC prompt), then quits so the installer can
  // replace the running app's files.
  ipcMain.handle('update:check', async () => {
    try {
      const { version: latestVersion } = await apiClient.fetchLatestVersion()
      const currentVersion = app.getVersion()
      return { success: true, currentVersion, latestVersion, available: latestVersion !== currentVersion }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('update:apply', async () => {
    try {
      const installerBuffer = await apiClient.downloadInstaller()
      const tempPath = path.join(app.getPath('temp'), 'ClearPilot-Update.exe')
      fs.writeFileSync(tempPath, installerBuffer)

      // NSIS can't overwrite this app's own running .exe/.asar files. Spawning the
      // installer immediately and quitting 800ms later (the previous version of this
      // handler) was a race: app.quit() only STARTS an async shutdown, it doesn't
      // guarantee the process - and its file locks - is actually gone by the time the
      // installer runs, so the install could silently fail to overwrite anything.
      // Confirmed live: the update downloaded but didn't reinstall. A companion batch
      // script polls tasklist for THIS process's own PID to genuinely disappear before
      // launching the installer, then deletes itself.
      const pid = process.pid
      const scriptPath = path.join(app.getPath('temp'), 'clearpilot-update.bat')
      const script = [
        '@echo off',
        ':wait',
        `tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL`,
        'if not errorlevel 1 (',
        '  timeout /t 1 /nobreak >NUL',
        '  goto wait',
        ')',
        `start "" "${tempPath}" /S`,
        'del "%~f0"'
      ].join('\r\n')
      fs.writeFileSync(scriptPath, script)

      spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      app.quit()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
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

/* UPDATES LOG
 * 2026-07-20 - Removed the AI judge entirely (JUDGE_INITIAL_INSTRUCTIONS,
 *   judgeInstructionsWithSuggestion, isJobMode, isPartnerMode, and the mic-session
 *   judge-injection in both startSingleSession's answer callback and connectPracticeRelay's
 *   message handler) - Job Mode and Practice Partner merged into a single "Prompter" mode
 *   (source: 'prompter') that runs only the Speaker session (AI Generated Response) and the
 *   practice relay (Web Prompter Transcription), with no mic listening or comparison of the
 *   candidate's spoken response. Renamed practice:saveRound -> practice:saveSession with a
 *   {webTranscript, aiResponse} shape (was {partnerAnswer, yourResponse, coachFeedback}).
 *   Added update:check / update:apply IPC handlers for the new Settings -> Update tab.
 * 2026-07-20 (later same day) - Split source 'prompter' apart from source 'speaker': the
 *   relay (Web Prompter Transcription) no longer waits on startSingleSession(..., 'speaker',
 *   ...) succeeding first - a missing/failing OpenAI key was silently preventing the relay
 *   from ever connecting. listening:stop's 'prompter' branch no longer also tears down
 *   speakerSession - the renderer now stops 'speaker' explicitly and independently when the
 *   AI Generated Response panel is disabled, instead of it staying connected underneath a
 *   hidden panel.
 * 2026-07-20 (later same day) - Fixed update:apply not actually reinstalling: launching the
 *   installer immediately and quitting 800ms later was a race - app.quit() only starts an
 *   async shutdown, it doesn't guarantee this process's file locks are released by the time
 *   NSIS tries to overwrite them. Confirmed live: the update downloaded but never installed.
 *   Now spawns a companion batch script that polls tasklist for this process's own PID to
 *   genuinely disappear before launching the installer (verified this polling logic
 *   in isolation against a dummy process before shipping it), then self-deletes.
 */
