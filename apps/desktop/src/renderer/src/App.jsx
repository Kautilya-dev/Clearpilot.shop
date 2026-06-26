import { useEffect, useState } from 'react'
import { Compass, LogOut } from 'lucide-react'

const STATE_STYLES = {
  active: 'bg-purple-50 text-purple-700',
  completed: 'bg-green-50 text-green-700',
  archived: 'bg-gray-100 text-gray-500'
}

function Sidebar({ user, onLogout }) {
  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 flex flex-col bg-white">
      <div className="h-16 flex items-center px-5 border-b border-gray-200">
        <span className="flex items-center gap-2 font-semibold">
          <Compass className="text-purple-600 w-5 h-5" />ClearPilot
        </span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        <button className="sidebar-link active">My Interviews</button>
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
  const [screen, setScreen] = useState('loading') // loading | login | picker | workspace
  const [user, setUser] = useState(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [interviews, setInterviews] = useState([])
  const [interviewsError, setInterviewsError] = useState('')
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

  useEffect(() => {
    if (screen !== 'picker') return
    setInterviewsError('')
    window.clearpilot.listInterviews().then((res) => {
      if (res.success) setInterviews(res.interviews)
      else setInterviewsError(res.error || 'Could not load interviews')
    })
  }, [screen])

  function handleSignIn() {
    setError('')
    setWaiting(true)
    window.clearpilot.openBrowserSignIn()
  }

  async function handleLogout() {
    await window.clearpilot.logout()
    setUser(null)
    setInterviews([])
    setSelectedInterview(null)
    setScreen('login')
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
      <Sidebar user={user} onLogout={handleLogout} />

      {screen === 'workspace' && selectedInterview ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b border-gray-200 px-8 py-4 shrink-0">
            <button
              onClick={() => { setSelectedInterview(null); setScreen('picker') }}
              className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1 mb-2"
            >
              &larr; All interviews
            </button>
            <h1 className="text-xl font-semibold tracking-tight">{selectedInterview.title}</h1>
          </div>
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-gray-400">Copilot view coming in the next step.</p>
          </div>
        </div>
      ) : (
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-10">
            <h1 className="text-2xl font-semibold tracking-tight mb-1">My Interviews</h1>
            <p className="text-sm text-gray-500 mb-6">Pick an interview to continue in Copilot.</p>

            <div className="space-y-3">
              {interviewsError && <p className="text-sm text-red-600">{interviewsError}</p>}
              {!interviewsError && interviews.length === 0 && (
                <p className="text-sm text-gray-500">No interviews yet - create one on the ClearPilot web app first.</p>
              )}
              {interviews.map((interview) => (
                <button
                  key={interview.id}
                  onClick={() => { setSelectedInterview(interview); setScreen('workspace') }}
                  className="w-full text-left border border-gray-200 rounded-xl p-4 hover:border-purple-300 transition"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="text-sm font-medium">{interview.title}</p>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATE_STYLES[interview.state] || 'bg-gray-100 text-gray-500'}`}
                    >
                      {interview.state}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {interview.subjects.map((s) => (
                      <span key={s.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {s.name}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </main>
      )}
    </div>
  )
}
