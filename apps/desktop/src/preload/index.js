const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clearpilot', {
  closeWindow: () => ipcRenderer.invoke('window:close'),
  enterFocusMode: () => ipcRenderer.invoke('window:enterFocusMode'),
  exitFocusMode: () => ipcRenderer.invoke('window:exitFocusMode'),

  openBrowserSignIn: () => ipcRenderer.invoke('auth:openBrowserSignIn'),
  getCurrentUser: () => ipcRenderer.invoke('auth:getCurrentUser'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onLoggedIn: (callback) => {
    ipcRenderer.on('auth:loggedIn', (event, user) => callback(user))
  },
  onLoginFailed: (callback) => {
    ipcRenderer.on('auth:loginFailed', (event, message) => callback(message))
  },
  offAuthEvents: () => {
    ipcRenderer.removeAllListeners('auth:loggedIn')
    ipcRenderer.removeAllListeners('auth:loginFailed')
  },

  updateProfile: (displayName) => ipcRenderer.invoke('profile:update', { displayName }),
  updatePreferences: (answerFormatMode, answerLength) =>
    ipcRenderer.invoke('preferences:update', { answerFormatMode, answerLength }),
  changePassword: (currentPassword, newPassword) =>
    ipcRenderer.invoke('auth:changePassword', { currentPassword, newPassword }),
  deleteAccount: () => ipcRenderer.invoke('auth:deleteAccount'),

  listSubjects: () => ipcRenderer.invoke('subjects:list'),
  listInterviews: () => ipcRenderer.invoke('interviews:list'),
  createInterview: (title, subjectIds) => ipcRenderer.invoke('interviews:create', { title, subjectIds }),
  updateInterview: (interviewId, updates) => ipcRenderer.invoke('interviews:update', { interviewId, updates }),
  deleteInterview: (interviewId) => ipcRenderer.invoke('interviews:delete', { interviewId }),

  getHistory: (interviewId, limit) => ipcRenderer.invoke('history:list', { interviewId, limit }),
  deleteHistoryEntry: (interviewId, entryId) => ipcRenderer.invoke('history:deleteEntry', { interviewId, entryId }),
  clearHistory: (interviewId) => ipcRenderer.invoke('history:clear', { interviewId }),

  askQuestion: (interviewId, question) => ipcRenderer.invoke('chat:ask', { interviewId, question }),
  onChatEvent: (callback) => {
    ipcRenderer.on('chat:event', (event, data) => callback(data))
  },
  offChatEvent: () => {
    ipcRenderer.removeAllListeners('chat:event')
  },

  toggleStealth: (enabled) => ipcRenderer.invoke('stealth:toggle', enabled),
  getStealthStatus: () => ipcRenderer.invoke('stealth:getStatus'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (updates) => ipcRenderer.invoke('settings:save', updates),

  startListening: (interviewId, source) => ipcRenderer.invoke('listening:start', { interviewId, source }),
  stopListening: (source) => ipcRenderer.invoke('listening:stop', { source }),
  sendAudioChunk: (source, base64Data) => ipcRenderer.invoke('listening:audioChunk', { source, base64Data }),
  // What was heard from mic/speaker → show in question area
  onListeningQuestion: (callback) => {
    ipcRenderer.on('listening:question', (event, data) => callback(data))
  },
  // GPT's answer → show in answer area directly
  onListeningAnswer: (callback) => {
    ipcRenderer.on('listening:answer', (event, data) => callback(data))
  },
  onListeningError: (callback) => {
    ipcRenderer.on('listening:error', (event, data) => callback(data))
  },
  offListeningEvents: () => {
    ipcRenderer.removeAllListeners('listening:question')
    ipcRenderer.removeAllListeners('listening:answer')
    ipcRenderer.removeAllListeners('listening:error')
  },

  // Practice Partner mode - reuses startListening/stopListening above with source: 'partner';
  // these are just the extra events/calls specific to that mode.
  savePracticeRound: (interviewId, partnerAnswer, yourResponse, coachFeedback) =>
    ipcRenderer.invoke('practice:saveRound', { interviewId, partnerAnswer, yourResponse, coachFeedback }),
  onPracticeTranscript: (callback) => {
    ipcRenderer.on('practice:transcript', (event, data) => callback(data))
  },
  onPracticeGuestStatus: (callback) => {
    ipcRenderer.on('practice:guestStatus', (event, data) => callback(data))
  },
  onPracticeError: (callback) => {
    ipcRenderer.on('practice:relayError', (event, data) => callback(data))
  },
  offPracticeEvents: () => {
    ipcRenderer.removeAllListeners('practice:transcript')
    ipcRenderer.removeAllListeners('practice:guestStatus')
    ipcRenderer.removeAllListeners('practice:relayError')
  },

  listMaterials: (interviewId) => ipcRenderer.invoke('materials:list', { interviewId }),
  createMaterial: (interviewId, type, name, text) =>
    ipcRenderer.invoke('materials:create', { interviewId, type, name, text }),
  uploadMaterial: (interviewId, type, fileName, bytes) =>
    ipcRenderer.invoke('materials:upload', { interviewId, type, fileName, bytes }),
  updateMaterial: (interviewId, materialId, updates) =>
    ipcRenderer.invoke('materials:update', { interviewId, materialId, updates }),
  deleteMaterial: (interviewId, materialId) => ipcRenderer.invoke('materials:delete', { interviewId, materialId }),

  listQa: (interviewId, filters) => ipcRenderer.invoke('qa:list', { interviewId, ...filters }),
  createQa: (interviewId, question, answer) => ipcRenderer.invoke('qa:create', { interviewId, question, answer }),
  uploadQa: (interviewId, fileName, bytes) => ipcRenderer.invoke('qa:upload', { interviewId, fileName, bytes }),
  updateQa: (interviewId, entryId, updates) => ipcRenderer.invoke('qa:update', { interviewId, entryId, updates }),
  deleteQa: (interviewId, entryId) => ipcRenderer.invoke('qa:delete', { interviewId, entryId })
})
