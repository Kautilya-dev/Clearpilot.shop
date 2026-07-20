/* ABOUT THIS FILE
 * The desktop app's unified "Prompter" tab - replaces JudgeTab.jsx (Job Mode + Practice
 * Partner, merged into one). The Start/Stop Prompter button controls only the relay (Web
 * Prompter Transcription); the AI Generated Response checkbox independently starts/stops
 * the Speaker Realtime session (system audio -> suggested answer) - genuinely, not just a
 * display toggle, so disabling it actually stops listening and a missing/failing OpenAI key
 * can never block the relay. No AI judge, no mic listening, no comparison of anything the
 * candidate says - that entire feature was removed. Rendered by InterviewWorkspace.jsx,
 * which owns and passes down all the state here (listenMode, aiResponse, aiEnabled,
 * partnerTranscript, guestConnected) plus the start/stop/toggle handlers - aiEnabled is a
 * controlled prop, not local state, because InterviewWorkspace needs to know its value to
 * decide whether to start the Speaker session when Prompter itself starts.
 */
import { useState, useRef, useEffect } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Volume2 } from 'lucide-react'

const ANSWER_STYLE = {
  backgroundColor: 'var(--style-answer-bg, #f9fafb)',
  color: 'var(--style-answer-font, #111827)',
  fontSize: 'var(--style-answer-font-size, 14px)'
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))
}

const MIN_PANEL_PCT = 15
const MAX_PANEL_PCT = 85
const DEFAULT_SPLIT_PCT = 50

export default function PrompterTab({
  listenMode,
  listenError,
  onStartListening,
  onStopListening,
  speakerLevel,
  speakerDeviceName,
  aiResponse,
  aiEnabled,
  onToggleAiResponse,
  partnerTranscript,
  guestConnected
}) {
  const active = listenMode === 'prompter'
  const [splitPct, setSplitPct] = useState(DEFAULT_SPLIT_PCT) // Web Prompter panel's width %
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef(null)

  // Document-level listeners (not onMouseMove/onMouseUp on the panel itself) so the drag
  // keeps tracking even if the cursor briefly leaves the container bounds mid-drag - a
  // common failure mode of attaching resize handlers only to the element being dragged over.
  useEffect(() => {
    if (!isDragging) return
    function handleMove(e) {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setSplitPct(Math.min(MAX_PANEL_PCT, Math.max(MIN_PANEL_PCT, pct)))
    }
    function handleUp() {
      setIsDragging(false)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [isDragging])

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="border-b border-gray-200 px-8 py-4 shrink-0 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => (active ? onStopListening() : onStartListening('prompter'))}
            className={`text-sm px-4 py-2 rounded-lg border font-medium transition-colors ${
              active
                ? 'border-purple-500 bg-purple-50 text-purple-700 hover:bg-purple-100'
                : 'border-gray-300 text-gray-600 hover:border-purple-300 hover:text-purple-600'
            }`}
          >
            {active ? 'Stop Prompter' : 'Start Prompter'}
          </button>

          <label className="inline-flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(e) => onToggleAiResponse(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            AI Generated Response
          </label>

          {active && (
            <div className="flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5 text-gray-400" />
              <div className="w-10 h-1 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-purple-500 transition-all" style={{ width: `${Math.min(100, speakerLevel)}%` }} />
              </div>
              <span className="text-xs text-gray-400 truncate max-w-[120px]">
                {speakerDeviceName || 'System Audio'}
              </span>
            </div>
          )}
        </div>

        {listenError && <p className="text-xs text-red-600">{listenError}</p>}

        {!active && (
          <p className="text-xs text-gray-400">
            Requires speaker (loopback) access. Shows your practice partner's live transcript
            from the web app's Prompter tab, and - if enabled above - an AI-generated
            suggested answer from listening to system audio.
          </p>
        )}
      </div>

      <div ref={containerRef} className="flex-1 flex overflow-hidden min-h-0 relative">
        <div
          className="flex flex-col overflow-hidden border-r border-gray-200"
          style={{ width: aiEnabled ? `${splitPct}%` : '100%' }}
        >
          <div className="px-4 py-3 border-b border-gray-100 shrink-0">
            <p className="text-xs font-semibold text-gray-700">Web Prompter Transcription</p>
            <p className="text-[10px] mt-0.5 flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${guestConnected ? 'bg-green-500' : 'bg-gray-300'}`} />
              <span className={guestConnected ? 'text-green-700' : 'text-gray-400'}>
                {guestConnected ? 'Partner connected' : 'Waiting for partner…'}
              </span>
            </p>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
            {partnerTranscript ? (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{partnerTranscript}</p>
            ) : (
              <p className="text-xs text-gray-400">
                Have your partner open this interview's Prompter tab in the web app and hit Start speaking.
              </p>
            )}
          </div>
        </div>

        {aiEnabled && (
          <>
            <div
              onMouseDown={() => setIsDragging(true)}
              className={`w-1 shrink-0 cursor-col-resize transition-colors ${
                isDragging ? 'bg-purple-400' : 'bg-gray-100 hover:bg-purple-300'
              }`}
              title="Drag to resize"
            />
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              <div className="px-4 py-3 border-b border-gray-100 shrink-0 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-700">AI Generated Response</p>
                <button
                  type="button"
                  onClick={() => onToggleAiResponse(false)}
                  title="Disable - stops listening to system audio, not just hides the panel"
                  className="text-gray-400 hover:text-gray-600 text-xs"
                >
                  Disable
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0 space-y-3">
                {aiResponse.question && (
                  <p className="text-xs text-gray-500">
                    <span className="font-medium text-gray-600">Interviewer: </span>
                    {aiResponse.question}
                  </p>
                )}
                {aiResponse.answer ? (
                  <div
                    className="answer-text text-sm"
                    style={ANSWER_STYLE}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(aiResponse.answer) }}
                  />
                ) : (
                  <p className="text-xs text-gray-400">Waiting for the interviewer to speak…</p>
                )}
              </div>
            </div>
          </>
        )}

        {!aiEnabled && (
          <button
            type="button"
            onClick={() => onToggleAiResponse(true)}
            className="absolute right-2 top-2 text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:border-purple-300 hover:text-purple-600 bg-white shadow-sm"
          >
            Show AI Response
          </button>
        )}
      </div>
    </div>
  )
}

/* UPDATES LOG
 * 2026-07-20 - Created as the replacement for JudgeTab.jsx: merges the old "Start Job
 *   Mode" and "Practice with a partner" buttons into a single Start/Stop Prompter button,
 *   removes the AI judge entirely (no mic listening, no Coach feedback, no round history),
 *   and replaces the old single-slot jobCurrent.suggestion panel (Job Mode's AI suggestion
 *   and Practice Partner's relayed transcript were mutually exclusive) with two independent,
 *   simultaneous panels - Web Prompter Transcription and AI Generated Response - in a
 *   resizable split (drag the divider) with an explicit enable/disable checkbox for the AI
 *   panel. No Focus Mode entry point (Focus Mode is Copilot-only now).
 * 2026-07-20 - Fixed two real bugs found live: (1) disabling the AI panel didn't actually
 *   stop listening to system audio, just hid the display - aiEnabled is now a controlled
 *   prop InterviewWorkspace uses to genuinely start/stop the Speaker session; (2) starting
 *   Prompter could fail to fetch the Web Prompter Transcript at all if the Speaker session
 *   failed first (e.g. no OpenAI key set) - the relay and the AI session are now fully
 *   independent, so one's failure never blocks the other.
 */
