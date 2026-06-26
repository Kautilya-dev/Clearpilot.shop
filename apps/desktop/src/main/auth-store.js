const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

function tokenFilePath() {
  return path.join(app.getPath('userData'), 'auth-token.bin')
}

// In-memory only for the process lifetime - never handed to the renderer.
let cachedToken = null
let cachedUser = null

function setSession(token, user) {
  cachedToken = token
  cachedUser = user
}

function getCachedToken() {
  return cachedToken
}

function getCachedUser() {
  return cachedUser
}

function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system')
  }
  const encrypted = safeStorage.encryptString(token)
  fs.writeFileSync(tokenFilePath(), encrypted)
}

// Returns the decrypted token, or null if there's nothing usable (no file, can't
// decrypt, encryption unavailable). Caller is responsible for validating it against
// the API - this function only recovers the bytes, it doesn't know if they're still good.
function loadStoredToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const filePath = tokenFilePath()
    if (!fs.existsSync(filePath)) return null
    const encrypted = fs.readFileSync(filePath)
    return safeStorage.decryptString(encrypted)
  } catch (error) {
    console.warn('Failed to decrypt stored auth token:', error.message)
    return null
  }
}

function clearStoredToken() {
  try {
    const filePath = tokenFilePath()
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (error) {
    console.warn('Failed to clear stored auth token:', error.message)
  }
  cachedToken = null
  cachedUser = null
}

module.exports = {
  setSession,
  getCachedToken,
  getCachedUser,
  saveToken,
  loadStoredToken,
  clearStoredToken
}
