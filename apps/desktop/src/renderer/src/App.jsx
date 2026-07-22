/* ABOUT THIS FILE
Root React component for the desktop renderer (mounted by main.jsx). Owns top-level
navigation state (`screen`) and renders one of: loading, login, or the post-login shell
(TitleBar + Sidebar + whichever screen is active - picker/history/settings/admin/workspace).

Linked from:
- src/renderer/src/main.jsx: mounts <App /> into the DOM.
- InterviewWorkspace.jsx: rendered here for `screen === 'workspace'`; owns focusMode, which
  this file uses to hide TitleBar/Sidebar entirely (a borderless overlay look) while active.
- PickerScreen.jsx / HistoryScreen.jsx / SettingsScreen.jsx / AdminScreen.jsx: the other
  four screens, swapped in based on `screen`.
- src/preload/index.js: everything under `window.clearpilot.*` (getCurrentUser, onLoggedIn,
  onLoginFailed, getSettings, openBrowserSignIn, logout, closeWindow) is defined there.

Sidebar (defined in this file, no separate component file exists for it) supports a
collapsed (icon-only, w-16) and expanded (icon+label, w-56) state via `sidebarCollapsed`,
toggled with the PanelLeftClose/PanelLeftOpen button above the logout footer. This is
session-only state - see the state declaration below for why it isn't persisted.
*/
import { useEffect, useState } from 'react'
import {
  Compass,
  LogOut,
  X,
  LayoutDashboard,
  History as HistoryIcon,
  Settings as SettingsIcon,
  Shield,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import InterviewWorkspace from './InterviewWorkspace'
import PickerScreen from './PickerScreen'
import HistoryScreen from './HistoryScreen'
import SettingsScreen from './SettingsScreen'
import AdminScreen from './AdminScreen'
import { applyStyles } from './applyStyles'

// Thin draggable strip replacing the OS title bar (window is frameless).
// Only a close button — no minimize, no maximize. This is intentional and permanent.
function TitleBar() {
  return (
    <div
      className="h-8 shrink-0 flex items-center justify-between px-4 bg-white border-b border-gray-100 select-none"
      style={{ WebkitAppRegion: 'drag' }}
    >
      <span className="text-xs text-gray-400 flex items-center gap-1.5">
        <Compass className="w-3 h-3 text-purple-500" />
        ClearPilot
      </span>
      <button
        onClick={() => window.clearpilot.closeWindow()}
        title="Close"
        style={{ WebkitAppRegion: 'no-drag' }}
        className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

const NAV_ITEMS = [
  { key: 'picker', label: 'My Interviews', icon: LayoutDashboard },
  { key: 'history', label: 'History', icon: HistoryIcon },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
  // Shown to everyone, same as web's unlisted-but-reachable /admin - the real gate is
  // server-side (require_admin in routers/admin.py); a non-admin just sees "access required".
  { key: 'admin', label: 'Admin', icon: Shield }
]

// Collapses to a narrow icon-only strip (w-16) instead of hiding entirely, so navigation
// and logout stay reachable with one click even when collapsed - only the text labels and
// the ClearPilot wordmark disappear. `collapsed`/`onToggleCollapse` are lifted to App (not
// local state here) purely so a future persisted preference (matching settingsStore's
// window/behavior prefs) has somewhere to plug in without restructuring this component again.
function Sidebar({ user, activeScreen, onNavigate, onLogout, collapsed, onToggleCollapse }) {
  return (
    <aside
      className={`shrink-0 border-r border-gray-200 flex flex-col bg-white transition-[width] duration-150 ${
        collapsed ? 'w-16' : 'w-56'
      }`}
    >
      <div className={`h-16 flex items-center border-b border-gray-200 ${collapsed ? 'justify-center' : 'px-5'}`}>
        {collapsed ? (
          <Compass className="text-purple-600 w-5 h-5 shrink-0" />
        ) : (
          <span className="flex items-center gap-2 font-semibold">
            <Compass className="text-purple-600 w-5 h-5 shrink-0" />
            ClearPilot
          </span>
        )}
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              title={collapsed ? item.label : undefined}
              className={`sidebar-link w-full ${collapsed ? 'justify-center px-0' : 'text-left'} ${
                activeScreen === item.key ? 'active' : ''
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          )
        })}
      </nav>
      <div className="px-3 py-2 border-t border-gray-200">
        <button
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`sidebar-link w-full text-gray-400 ${collapsed ? 'justify-center px-0' : 'text-left'}`}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4 shrink-0" /> : <PanelLeftClose className="w-4 h-4 shrink-0" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
      <div className={`px-3 py-3 border-t border-gray-200 ${collapsed ? 'flex justify-center' : ''}`}>
        {collapsed ? (
          <button onClick={onLogout} className="text-gray-400 hover:text-gray-700" title="Log out">
            <LogOut className="w-4 h-4" />
          </button>
        ) : (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-medium text-gray-700 truncate">{user?.display_name}</span>
            <button onClick={onLogout} className="text-gray-400 hover:text-gray-700" title="Log out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

export default function App() {
  const [screen, setScreen] = useState('loading') // loading | login | picker | history | settings | admin | workspace
  const [user, setUser] = useState(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [selectedInterview, setSelectedInterview] = useState(null)
  const [focusMode, setFocusMode] = useState(false)
  // Session-only, not persisted - resets to expanded on every app launch. If the user wants
  // this remembered across restarts, move it into settingsStore alongside the window/behavior
  // prefs (see SettingsScreen.jsx's opacity/alwaysOnTop/stealthMode for the existing pattern).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    window.clearpilot.getCurrentUser().then((res) => {
      if (res.success) {
        setUser(res.user)
        setScreen('picker')
      } else {
        setScreen('login')
      }
    })

    window.clearpilot.onLoggedIn((loggedInUser) => {
      setUser(loggedInUser)
      setWaiting(false)
      setError('')
      setScreen('picker')
    })
    window.clearpilot.onLoginFailed((message) => {
      setWaiting(false)
      setError(message || 'Sign-in failed')
    })
    return () => window.clearpilot.offAuthEvents()
  }, [])

  useEffect(() => {
    window.clearpilot.getSettings().then((res) => {
      if (res.success) applyStyles(res.settings.styles)
    })
  }, [])

  function handleSignIn() {
    setError('')
    setWaiting(true)
    window.clearpilot.openBrowserSignIn()
  }

  async function handleLogout() {
    await window.clearpilot.logout()
    setUser(null)
    setSelectedInterview(null)
    setScreen('login')
  }

  function handleNavigate(key) {
    setSelectedInterview(null)
    setScreen(key)
    setFocusMode(false) // leaving the workspace should never strand Sidebar/TitleBar hidden
  }

  function handleSelectInterview(interview) {
    setSelectedInterview(interview)
    setScreen('workspace')
  }

  if (screen === 'loading') {
    return (
      <div className="h-screen flex flex-col overflow-hidden font-sans">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center bg-white">
          <p className="text-gray-400 text-sm">Loading...</p>
        </div>
      </div>
    )
  }

  if (screen === 'login') {
    return (
      <div className="h-screen flex flex-col overflow-hidden font-sans">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center bg-white">
          <div className="w-80 text-center">
            <h1 className="text-lg font-semibold mb-2 flex items-center justify-center gap-2">
              <Compass className="text-purple-600 w-5 h-5" />ClearPilot
            </h1>
            <p className="text-sm text-gray-500 mb-5">Sign in with your ClearPilot account to continue.</p>
            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
            <button
              onClick={handleSignIn}
              disabled={waiting}
              className="w-full bg-purple-600 text-white rounded-lg px-3 py-2.5 text-sm disabled:opacity-60"
            >
              {waiting ? 'Waiting for browser sign-in...' : 'Sign in with Browser'}
            </button>
            {waiting && (
              <p className="text-xs text-gray-400 mt-3">
                Complete sign-in in the browser window that just opened, then come back here.
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden font-sans">
      {!focusMode && <TitleBar />}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {!focusMode && (
          <Sidebar
            user={user}
            activeScreen={screen}
            onNavigate={handleNavigate}
            onLogout={handleLogout}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          />
        )}

        {screen === 'workspace' && selectedInterview && (
          <InterviewWorkspace
            interview={selectedInterview}
            onBack={() => handleNavigate('picker')}
            focusMode={focusMode}
            onFocusModeChange={setFocusMode}
          />
        )}
        {screen === 'picker' && <PickerScreen onSelectInterview={handleSelectInterview} />}
        {screen === 'history' && <HistoryScreen onSelectInterview={handleSelectInterview} />}
        {screen === 'settings' && (
          <SettingsScreen
            user={user}
            onProfileUpdated={setUser}
            onAccountDeleted={() => {
              setUser(null)
              setScreen('login')
            }}
          />
        )}
        {screen === 'admin' && <AdminScreen />}
      </div>
    </div>
  )
}

// UPDATES LOG
// 2026-07-22 - Added Sidebar collapse/expand: NAV_ITEMS gained an `icon` field
//   (LayoutDashboard/HistoryIcon/SettingsIcon/Shield), Sidebar now accepts
//   `collapsed`/`onToggleCollapse` and switches between a w-16 icon-only strip and the
//   original w-56 icon+label layout, with a PanelLeftClose/PanelLeftOpen toggle button above
//   the logout footer. New `sidebarCollapsed` state in App, session-only (not persisted to
//   settingsStore) since the request didn't specify persistence across restarts.
