const { app, BrowserWindow, ipcMain, shell, session, desktopCapturer } = require('electron')
const http = require('http')
const path = require('path')
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
// listening:* IPC handlers below. Both can be active simultaneously (Judge mode).
let speakerSession = null
let micSession = null
let speakerStopIntentional = false
let micStopIntentional = false

// Practice Partner mode: a second person, on their own Desktop/web client logged into the
// same account, speaks the answer instead of the AI. practiceRelay is a `ws` client to the
// backend's Redis-Pub/Sub relay (apps/web/routers/practice.py), keyed by interview_id - no
// join code needed since pairing is implicit (same account, same interview). isPartnerMode
// gates the speaker-answer-callback injection inside registerIpcHandlers so the AI's own
// generated answer doesn't overwrite the judge's reference once a real partner is providing
// it - kept as module-level state (like speakerSession/micSession above) even though the
// functions that use it live inside registerIpcHandlers, where judgeInstructionsWithSuggestion
// is in scope.
let practiceRelay = null
let isPartnerMode = false

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

  // true when both sessions run together (Job Mode) — used to update mic instructions
  // with the speaker's suggestion so the judge has context.
  let isJobMode = false

  // Answer Template preference (account-level, shared with the web app) - shapes the
  // generated ANSWER only. Deliberately not applied to JUDGE_INITIAL_INSTRUCTIONS /
  // judgeInstructionsWithSuggestion below, which are coaching commentary, not an answer.
  const FORMAT_MODE_INSTRUCTIONS = {
    bullets: 'Structure the answer as bullet points covering the key ideas - each bullet that introduces a **bolded** term should also unpack it with a brief example.',
    star: 'Structure the answer using the STAR method: Situation, Task, Action, Result, labelling each part - flesh each part out with specifics rather than one-line summaries.',
    concise: 'Give a single, direct one-sentence answer with no elaboration.',
    detailed: "Give a fuller, elaborate explanation: walk through the reasoning and configuration steps in depth, and for every **bolded** key term include a concrete code/configuration example or worked mini-scenario right where it's introduced, not just a definition."
  }
  const ANSWER_LENGTH_INSTRUCTIONS = {
    short: 'Keep it to no more than 3 sentences or bullet points total.',
    medium: 'Keep it to roughly 4-6 sentences or bullet points total.',
    long: 'Go long and thorough - roughly 10-15 sentences or bullet points, covering the reasoning, a worked example, and any relevant edge case or gotcha, so the candidate has enough material to speak on this for a couple of minutes if the interviewer asks them to elaborate.'
  }

  function buildAnswerTemplateInstruction(answerFormatMode, answerLength) {
    const mode = FORMAT_MODE_INSTRUCTIONS[answerFormatMode] || FORMAT_MODE_INSTRUCTIONS.bullets
    const length = ANSWER_LENGTH_INSTRUCTIONS[answerLength] || ANSWER_LENGTH_INSTRUCTIONS.medium
    return `${mode} ${length}`
  }

  function buildSapInstructions(answerFormatMode, answerLength) {
    return (
      'You are an expert SAP CPI (Cloud Integration) interview assistant. ' +
      "Listen to the interviewer's question and respond with a clear, accurate answer. " +
      'Focus on SAP Integration Suite, CPI iFlows, adapters, mappings, security, and best practices. ' +
      'Whenever you **bold** a key term, immediately follow it with a short concrete example or plain-language explanation of what it means in practice, so the candidate could explain it unprompted if the interviewer digs in. ' +
      buildAnswerTemplateInstruction(answerFormatMode, answerLength)
    )
  }

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
        // Same injection point the AI-generated speaker suggestion uses below - the judge
        // session doesn't need to know whether the "ideal answer" came from the AI or a
        // real partner speaking it in the web app's Prompter tab.
        if (micSession) micSession.updateInstructions(judgeInstructionsWithSuggestion(payload.text))
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
        // Job Mode: when speaker GPT answers, inject that suggestion into the mic judge session
        // so it has context when the candidate speaks. Skipped in Practice Partner mode - the
        // speaker session still runs (for the interviewer-question transcript/context above),
        // but the judge's reference answer comes from the relayed partner instead (see
        // connectPracticeRelay's 'transcript_final' handler, which calls updateInstructions itself).
        if (isJobMode && !isPartnerMode && source === 'speaker' && micSession) {
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
    // Fetched fresh (not from authStore's cached user) so a preference change made moments
    // ago on the web app - or on this app's own Settings without restarting - is honored
    // immediately. Session starts aren't a hot path, so the extra round-trip is cheap.
    const token = authStore.getCachedToken()
    const user = token ? await apiClient.getCurrentUser(token).catch(() => null) : null
    const sapInstructions = buildSapInstructions(user?.answer_format_mode || 'bullets', user?.answer_length || 'medium')

    if (source === 'both' || source === 'partner') {
      isJobMode = true
      isPartnerMode = source === 'partner'
      // Start both sessions concurrently — speaker as SAP assistant (or, in partner mode,
      // just for interviewer-question transcript/context - see the gated injection above),
      // mic as judge
      const [sr, mr] = await Promise.all([
        startSingleSession(interviewId, 'speaker', sapInstructions),
        startSingleSession(interviewId, 'mic', JUDGE_INITIAL_INSTRUCTIONS)
      ])
      if (!sr.success) return sr
      if (!mr.success) return mr
      if (isPartnerMode && token) connectPracticeRelay(interviewId, token)
      return { success: true }
    }
    isJobMode = false
    isPartnerMode = false
    const instructions = source === 'speaker' ? sapInstructions : JUDGE_INITIAL_INSTRUCTIONS
    return startSingleSession(interviewId, source, instructions)
  }

  ipcMain.handle('listening:start', async (event, { interviewId, source }) => {
    return startListeningSession(interviewId, source)
  })

  ipcMain.handle('listening:stop', async (event, { source }) => {
    if (source === 'speaker' || source === 'both' || source === 'partner') {
      speakerStopIntentional = true
      speakerSession?.disconnect()
      speakerSession = null
    }
    if (source === 'mic' || source === 'both' || source === 'partner') {
      micStopIntentional = true
      micSession?.disconnect()
      micSession = null
    }
    if (source === 'both' || source === 'partner') {
      isJobMode = false
      isPartnerMode = false
      disconnectPracticeRelay()
    }
    return { success: true }
  })

  ipcMain.handle('practice:saveRound', async (event, { interviewId, partnerAnswer, yourResponse, coachFeedback }) => {
    const token = authStore.getCachedToken()
    if (!token) return { success: false, error: 'Not signed in' }
    try {
      const entry = await apiClient.savePracticeHistoryEntry(token, interviewId, { partnerAnswer, yourResponse, coachFeedback })
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
