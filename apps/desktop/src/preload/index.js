const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clearpilot', {
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

  listInterviews: () => ipcRenderer.invoke('interviews:list'),

  toggleStealth: (enabled) => ipcRenderer.invoke('stealth:toggle', enabled),
  getStealthStatus: () => ipcRenderer.invoke('stealth:getStatus')
})
