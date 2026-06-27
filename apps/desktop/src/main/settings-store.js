const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  window: { opacity: 1, alwaysOnTop: false },
  behavior: { stealthMode: false },
  openai: { apiKey: '' },
  styles: {
    overallBg: '#ffffff',
    questionBg: '#7c3aed',
    questionFont: '#ffffff',
    questionFontSize: 14,
    answerBg: '#f9fafb',
    answerFont: '#111827',
    answerFontSize: 14
  }
}

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

// Loaded once into memory on first access - settings are read far more often (every
// window/style application) than written (only when the user changes something in
// Settings), so there's no benefit to hitting disk on every get().
let cached = null

function load() {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(settingsFilePath(), 'utf-8').replace(/^﻿/, '')
    const stored = JSON.parse(raw)
    cached = {
      window: { ...DEFAULTS.window, ...stored.window },
      behavior: { ...DEFAULTS.behavior, ...stored.behavior },
      openai: { ...DEFAULTS.openai, ...stored.openai },
      styles: { ...DEFAULTS.styles, ...stored.styles }
    }
  } catch {
    cached = {
      ...DEFAULTS,
      window: { ...DEFAULTS.window },
      behavior: { ...DEFAULTS.behavior },
      openai: { ...DEFAULTS.openai },
      styles: { ...DEFAULTS.styles }
    }
  }
  return cached
}

function getAll() {
  return load()
}

// updates is a partial, one-level-deep per category, e.g. { window: { opacity: 0.8 } }
function save(updates) {
  const current = load()
  cached = {
    window: { ...current.window, ...updates.window },
    behavior: { ...current.behavior, ...updates.behavior },
    openai: { ...current.openai, ...updates.openai },
    styles: { ...current.styles, ...updates.styles }
  }
  fs.writeFileSync(settingsFilePath(), JSON.stringify(cached, null, 2), 'utf-8')
  return cached
}

module.exports = { getAll, save }
