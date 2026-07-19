/* ABOUT THIS FILE
 * Settings -> Update tab: a single "Check for update" button and the resulting states
 * (up to date / update available / downloading / error). Entirely user-triggered - nothing
 * checks or downloads automatically on launch. Talks to src/main/index.js's update:check
 * and update:apply IPC handlers via the window.clearpilot.checkForUpdate/applyUpdate bridge
 * (see src/preload/index.js). Rendered by SettingsScreen.jsx.
 */
import { useState } from 'react'

// 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'error'
export default function UpdateTab() {
  const [state, setState] = useState('idle')
  const [versions, setVersions] = useState({ current: '', latest: '' })
  const [errorMessage, setErrorMessage] = useState('')

  async function handleCheck() {
    setState('checking')
    setErrorMessage('')
    const res = await window.clearpilot.checkForUpdate()
    if (!res.success) {
      setState('error')
      setErrorMessage(res.error || 'Could not check for updates.')
      return
    }
    setVersions({ current: res.currentVersion, latest: res.latestVersion })
    setState(res.available ? 'available' : 'upToDate')
  }

  async function handleUpdate() {
    setState('downloading')
    setErrorMessage('')
    const res = await window.clearpilot.applyUpdate()
    // On success the app quits itself moments after this resolves (see main/index.js's
    // update:apply handler) to let the silently-launched installer replace it in place -
    // there's no "done" state to show, the window just closes.
    if (!res.success) {
      setState('error')
      setErrorMessage(res.error || 'Could not download the update.')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Software update</label>
        <p className="text-xs text-gray-500 mb-3">
          Checks are manual - nothing downloads unless you click Update below.
        </p>
      </div>

      {(state === 'idle' || state === 'checking') && (
        <button
          onClick={handleCheck}
          disabled={state === 'checking'}
          className="px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 disabled:opacity-60"
        >
          {state === 'checking' ? 'Checking…' : 'Check for update'}
        </button>
      )}

      {state === 'upToDate' && (
        <div className="space-y-3">
          <p className="text-sm text-green-700">You're up to date (v{versions.current}).</p>
          <button
            onClick={handleCheck}
            className="px-4 py-2 border border-gray-300 text-gray-600 text-sm rounded-md hover:bg-gray-50"
          >
            Check again
          </button>
        </div>
      )}

      {state === 'available' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">
            <span className="font-medium">v{versions.latest}</span> is available (you have v{versions.current}).
          </p>
          <button
            onClick={handleUpdate}
            className="px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700"
          >
            Update
          </button>
        </div>
      )}

      {state === 'downloading' && (
        <p className="text-sm text-gray-500">Downloading the update - the app will restart automatically once it's ready…</p>
      )}

      {state === 'error' && (
        <div className="space-y-3">
          <p className="text-sm text-red-600">{errorMessage}</p>
          <button
            onClick={handleCheck}
            className="px-4 py-2 border border-gray-300 text-gray-600 text-sm rounded-md hover:bg-gray-50"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

/* UPDATES LOG
 * 2026-07-20 - Created for the new Settings -> Update tab auto-update feature: manual
 *   "Check for update" -> "You're up to date" or "vX available" + Update button -> download
 *   + silent install + auto-restart, matching the exact flow requested (nothing automatic on
 *   launch, everything user-triggered from here).
 */
