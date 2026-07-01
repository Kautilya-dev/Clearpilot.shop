import { useEffect, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Compass, Mic, Volume2, Menu, X, Copy, ChevronDown, ChevronUp, ArrowLeft, Pin } from 'lucide-react'
import StylingTab from './StylingTab'
import BehaviourTab from './BehaviourTab'

const ANSWER_STYLE = {
  backgroundColor: 'var(--style-answer-bg, #f9fafb)',
  color: 'var(--style-answer-font, #111827)',
  fontSize: 'var(--style-answer-font-size, 14px)'
}

const DEVICES = [
  { key: 'mic', label: 'Mic', icon: Mic },
  { key: 'speaker', label: 'Speaker', icon: Volume2 }
]

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))
}

function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// One Job Mode round. `inProgress` rounds (the live jobCurrent, not yet in jobRounds) have no
// stable id yet so pin/collapse don't apply to them - they finalize into a pinnable card once
// the round completes.
function RoundCard({ round, pinned, onTogglePin, collapsed, onToggleCollapse, inProgress }) {
  const answerHtml = round.suggestion ? renderMarkdown(round.suggestion) : ''

  function handleCopy() {
    if (round.suggestion) navigator.clipboard.writeText(round.suggestion)
  }

  return (
    <div
      className={`border rounded-xl overflow-hidden ${inProgress ? 'border-purple-200 opacity-80' : 'border-gray-200'}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-600 truncate">
          &#128172; Question: {round.question || '—'}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {!inProgress && (
            <button
              type="button"
              onClick={onTogglePin}
              title={pinned ? 'Unpin' : 'Pin'}
              className={pinned ? 'text-purple-600' : 'text-gray-400 hover:text-gray-600'}
            >
              <Pin className="w-3.5 h-3.5" fill={pinned ? 'currentColor' : 'none'} />
            </button>
          )}
          <button type="button" onClick={handleCopy} title="Copy" className="text-gray-400 hover:text-gray-600">
            <Copy className="w-3.5 h-3.5" />
          </button>
          {!inProgress && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={collapsed ? 'Expand' : 'Collapse'}
              className="text-gray-400 hover:text-gray-600"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="px-3 py-3 space-y-2">
          <p className="text-xs font-semibold text-amber-500">&#9733; Answer:</p>
          <div className="answer-text text-sm" style={ANSWER_STYLE} dangerouslySetInnerHTML={{ __html: answerHtml }} />
          {round.response && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-[10px] text-blue-400 mb-1">Your response</p>
              <p className="text-xs text-blue-900">{round.response}</p>
            </div>
          )}
          {round.feedback && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-[10px] text-amber-500 mb-1">Coach feedback</p>
              <div
                className="answer-text text-sm text-amber-900"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(round.feedback) }}
              />
            </div>
          )}
          {inProgress && !round.response && round.suggestion && (
            <p className="text-xs text-gray-400 animate-pulse">Listening for your response…</p>
          )}
          {inProgress && round.response && !round.feedback && (
            <p className="text-xs text-gray-400 animate-pulse">Analysing your response…</p>
          )}
        </div>
      )}
    </div>
  )
}

// Compact floating widget shown in place of the normal tab UI while Focus Mode is active.
// The window itself has already been shrunk by the main process (window:enterFocusMode) -
// this component just renders the small-screen layout. Session start is gated behind an
// explicit button here rather than firing the instant a device is picked, unlike the normal
// Copilot/Job Mode device buttons.
export default function FocusWidget({
  source, // 'copilot' | 'judge'
  onExit,
  listenMode,
  listenError,
  onStartListening,
  onStopListening,
  speakerLevel,
  speakerDeviceName,
  micLevel,
  micDeviceName,
  streaming,
  history,
  speakerTranscript,
  jobCurrent,
  jobRounds,
  pinnedRoundIds,
  onToggleRoundPin
}) {
  const [sessionStarted, setSessionStarted] = useState(listenMode !== 'off')
  const [selectedDevice, setSelectedDevice] = useState('mic')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [qaCardCollapsed, setQaCardCollapsed] = useState(false)
  const [qaCardHidden, setQaCardHidden] = useState(false)
  const [panel, setPanel] = useState(null) // null | 'styling' | 'settings' - Styling/Behaviour tabs reused as-is
  const [menuOpen, setMenuOpen] = useState(false)
  // Per-round collapse state for the Job Mode feed - local only (unlike pins, not worth
  // preserving across a Focus Mode exit/re-entry).
  const [collapsedRoundIds, setCollapsedRoundIds] = useState(() => new Set())

  function toggleRoundCollapse(id) {
    setCollapsedRoundIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const listening = listenMode !== 'off'
  const label = source === 'judge' ? 'Job Mode' : 'Copilot'

  useEffect(() => {
    if (!sessionStarted) return
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [sessionStarted])

  // A session may already be running when Focus Mode is entered (re-opening the widget
  // without having stopped listening first) - reflect that instead of showing the picker again,
  // and sync which device the status text/level meter should read from.
  useEffect(() => {
    if (listening) {
      setSessionStarted(true)
      if (listenMode === 'mic' || listenMode === 'speaker') setSelectedDevice(listenMode)
    }
  }, [listening, listenMode])

  const copilotQa = source === 'copilot' ? streaming || history[0] || null : null
  const hasQa = !!copilotQa

  // Reappear on the next question after being dismissed, rather than staying hidden all session.
  useEffect(() => {
    setQaCardHidden(false)
  }, [copilotQa?.question])

  // Pinned rounds render in their own section above the feed so they stay visible regardless of
  // how many new rounds arrive above them; everything else renders newest-first (jobRounds is
  // already prepended-to in InterviewWorkspace, so array order already matches).
  const pinnedRounds = source === 'judge' ? jobRounds.filter((r) => pinnedRoundIds?.has(r.id)) : []
  const unpinnedRounds = source === 'judge' ? jobRounds.filter((r) => !pinnedRoundIds?.has(r.id)) : []

  async function handleStartSession() {
    setSessionStarted(true)
    await onStartListening(source === 'judge' ? 'both' : selectedDevice)
  }

  async function handleStopSession() {
    await onStopListening()
    setSessionStarted(false)
    setElapsedSeconds(0)
  }

  function handleCopilotCopy() {
    if (copilotQa?.question) navigator.clipboard.writeText(copilotQa.question)
  }

  const levelPct =
    source === 'judge' ? Math.max(speakerLevel, micLevel) : selectedDevice === 'speaker' ? speakerLevel : micLevel

  const statusText = source === 'judge'
    ? 'Listening…'
    : selectedDevice === 'speaker'
      ? `Listening : ${speakerDeviceName || 'System Audio'}`
      : `Listening : ${micDeviceName || 'Microphone'}`

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Draggable strip - same WebkitAppRegion trick as App.jsx's TitleBar, the only way to
          move this frameless window. */}
      <div
        className="h-9 shrink-0 flex items-center justify-between px-3 bg-white border-b border-gray-100 select-none"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Compass className="w-3.5 h-3.5 text-purple-500 shrink-0" />
          <span className="text-xs font-medium text-gray-600 truncate">{label}</span>
          {listening && <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse shrink-0" />}
          {sessionStarted && (
            <span className="text-xs text-gray-400 tabular-nums shrink-0">{formatElapsed(elapsedSeconds)}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0" style={{ WebkitAppRegion: 'no-drag' }}>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="Menu"
              className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100"
            >
              <Menu className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-7 z-10 w-32 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onExit()
                  }}
                  className="w-full text-left text-xs px-3 py-1.5 text-gray-600 hover:bg-gray-50"
                >
                  Dashboard
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPanel('styling')
                    setMenuOpen(false)
                  }}
                  className="w-full text-left text-xs px-3 py-1.5 text-gray-600 hover:bg-gray-50"
                >
                  Styling
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPanel('settings')
                    setMenuOpen(false)
                  }}
                  className="w-full text-left text-xs px-3 py-1.5 text-gray-600 hover:bg-gray-50"
                >
                  Settings
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => window.clearpilot.closeWindow()}
            title="Close"
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {panel && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to session
            </button>
            {panel === 'styling' ? <StylingTab /> : <BehaviourTab />}
          </div>
        )}

        {!panel && !sessionStarted && (
          <div className="space-y-3 py-4">
            {source === 'copilot' && (
              <div className="flex items-center gap-2 justify-center">
                {DEVICES.map((device) => {
                  const Icon = device.icon
                  const active = selectedDevice === device.key
                  return (
                    <button
                      key={device.key}
                      type="button"
                      onClick={() => setSelectedDevice(device.key)}
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border ${
                        active
                          ? 'border-purple-500 bg-purple-50 text-purple-700'
                          : 'border-gray-200 text-gray-500 hover:border-purple-300'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {device.label}
                    </button>
                  )
                })}
              </div>
            )}
            <button
              type="button"
              onClick={handleStartSession}
              className="w-full bg-purple-600 text-white rounded-lg px-3 py-2.5 text-sm font-medium"
            >
              Start Session
            </button>
            {listenError && <p className="text-xs text-red-600 text-center">{listenError}</p>}
          </div>
        )}

        {!panel && sessionStarted && (
          <>
            <div className="flex items-center gap-2 min-w-0 bg-gray-50 rounded-lg px-2.5 py-1.5">
              <div className="w-8 h-1 bg-gray-200 rounded-full overflow-hidden shrink-0">
                <div className="h-full bg-purple-500" style={{ width: `${Math.min(100, levelPct)}%` }} />
              </div>
              <span className="text-xs text-gray-400 truncate">
                {listening ? speakerTranscript || statusText : 'Listening…'}
              </span>
            </div>

            {listenError && <p className="text-xs text-red-600">{listenError}</p>}

            {source === 'copilot' && hasQa && !qaCardHidden && (
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
                  <span className="text-xs font-medium text-gray-600 truncate">
                    &#128172; Question: {copilotQa?.question}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={handleCopilotCopy}
                      title="Copy"
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setQaCardCollapsed((c) => !c)}
                      title={qaCardCollapsed ? 'Expand' : 'Collapse'}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      {qaCardCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setQaCardHidden(true)}
                      title="Close"
                      className="text-gray-400 hover:text-red-500"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {!qaCardCollapsed && (
                  <div className="px-3 py-3 space-y-2">
                    <p className="text-xs font-semibold text-amber-500">&#9733; Answer:</p>
                    <div
                      className="answer-text text-sm"
                      style={ANSWER_STYLE}
                      dangerouslySetInnerHTML={{ __html: copilotQa?.html || '' }}
                    />
                  </div>
                )}
              </div>
            )}

            {source === 'judge' && (
              <div className="space-y-2">
                {jobCurrent.question && <RoundCard round={jobCurrent} inProgress />}

                {pinnedRounds.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide px-0.5">
                      Pinned
                    </p>
                    {pinnedRounds.map((round) => (
                      <RoundCard
                        key={round.id}
                        round={round}
                        pinned
                        onTogglePin={() => onToggleRoundPin?.(round.id)}
                        collapsed={collapsedRoundIds.has(round.id)}
                        onToggleCollapse={() => toggleRoundCollapse(round.id)}
                      />
                    ))}
                  </div>
                )}

                {unpinnedRounds.map((round) => (
                  <RoundCard
                    key={round.id}
                    round={round}
                    pinned={false}
                    onTogglePin={() => onToggleRoundPin?.(round.id)}
                    collapsed={collapsedRoundIds.has(round.id)}
                    onToggleCollapse={() => toggleRoundCollapse(round.id)}
                  />
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={handleStopSession}
              className="w-full text-xs px-3 py-2 rounded-lg border border-gray-300 text-gray-500 hover:border-red-300 hover:text-red-500"
            >
              Stop Session
            </button>
          </>
        )}
      </div>
    </div>
  )
}
