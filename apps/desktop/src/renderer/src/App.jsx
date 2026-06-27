import { useEffect, useState } from 'react'
import { Compass, LogOut } from 'lucide-react'
import InterviewWorkspace from './InterviewWorkspace'
import PickerScreen from './PickerScreen'
import HistoryScreen from './HistoryScreen'
import SettingsScreen from './SettingsScreen'

const NAV_ITEMS = [
  { key: 'picker', label: 'My Interviews' },
  { key: 'history', label: 'History' },
  { key: 'settings', label: 'Settings' }
]

function Sidebar({ user, activeScreen, onNavigate, onLogout }) {
  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 flex flex-col bg-white">
      <div className="h-16 flex items-center px-5 border-b border-gray-200">
        <span className="flex items-center gap-2 font-semibold">
          <Compass className="text-purple-600 w-5 h-5" />ClearPilot
        </span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            onClick={() => onNavigate(item.key)}
            className={`sidebar-link w-full text-left ${activeScreen === item.key ? 'active' : ''}`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="px-3 py-3 border-t border-gray-200">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium text-gray-700 truncate">{user?.display_name}</span>
          <button onClick={onLogout} className="text-gray-400 hover:text-gray-700" title="Log out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}

export default function App() {
  const [screen, setScreen] = useState('loading') // loading | login | picker | history | settings | workspace
  const [user, setUser] = useState(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [selectedInterview, setSelectedInterview] = useState(null)

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
  }

  function handleSelectInterview(interview) {
    setSelectedInterview(interview)
    setScreen('workspace')
  }

  if (screen === 'loading') {
    return (
      <div className="h-screen flex items-center justify-center bg-white">
        <p className="text-gray-400 text-sm">Loading...</p>
      </div>
    )
  }

  if (screen === 'login') {
    return (
      <div className="h-screen flex items-center justify-center bg-white font-sans">
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
    )
  }

  return (
    <div className="h-screen flex overflow-hidden font-sans">
      <Sidebar user={user} activeScreen={screen} onNavigate={handleNavigate} onLogout={handleLogout} />

      {screen === 'workspace' && selectedInterview && (
        <InterviewWorkspace interview={selectedInterview} onBack={() => handleNavigate('picker')} />
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
    </div>
  )
}
