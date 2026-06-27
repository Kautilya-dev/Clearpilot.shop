import { useEffect, useRef, useState } from 'react'
import { Send, Mic, Volume2 } from 'lucide-react'

const DEVICES = [
  { key: 'mic', label: 'Mic', icon: Mic },
  { key: 'speaker', label: 'Speaker', icon: Volume2 }
]

const QUESTION_STYLE = {
  backgroundColor: 'var(--style-question-bg, #7c3aed)',
  color: 'var(--style-question-font, #ffffff)',
  fontSize: 'var(--style-question-font-size, 14px)'
}
const ANSWER_STYLE = {
  backgroundColor: 'var(--style-answer-bg, #f9fafb)',
  color: 'var(--style-answer-font, #111827)',
  fontSize: 'var(--style-answer-font-size, 14px)'
}

function formatTiming(timing) {
  const startedClock = new Date(timing.started_at).toLocaleTimeString()
  const firstChunk = timing.time_to_first_chunk_ms != null ? `first word in ${timing.time_to_first_chunk_ms}ms · ` : ''
  return `${startedClock} · ${firstChunk}done in ${(timing.duration_ms / 1000).toFixed(2)}s`
}

// history/streaming/error are lifted to InterviewWorkspace.jsx so a voice-triggered
// question lands in the same conversation as a typed one. Mic/Speaker are alternative ways
// to ask the same Copilot - both ask AI and get an answer here - so their controls live
// in this tab. The combined "Both" mode (Job Mode) is a different interaction entirely
// (passive listening + comparison feedback) and lives in its own tab.
export default function CopilotScreen({
  history,
  historyLoading,
  streaming,
  error,
  onSubmit,
  listenMode,
  speakerLevel,
  speakerDeviceName,
  micLevel,
  micDeviceName,
  speakerTranscript,
  listenError,
  onStartListening,
  onStopListening
}) {
  const [input, setInput] = useState('')
  const conversationRef = useRef(null)

  useEffect(() => {
    conversationRef.current?.scrollTo({ top: 0 })
  }, [streaming, history])

  function handleSubmit(e) {
    e.preventDefault()
    const question = input.trim()
    if (!question) return
    setInput('')
    onSubmit(question)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div ref={conversationRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-5">
        {streaming && (
          <div className="space-y-3 pb-5 border-b border-gray-100">
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%]" style={QUESTION_STYLE}>
                {streaming.question}
              </div>
            </div>
            <div
              className="border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] answer-text"
              style={ANSWER_STYLE}
              dangerouslySetInnerHTML={{ __html: streaming.html }}
            />
          </div>
        )}

        {historyLoading && (
          <p className="text-sm text-gray-400 text-center py-16">Loading conversation…</p>
        )}
        {!historyLoading && history.length === 0 && !streaming && (
          <p className="text-sm text-gray-400 text-center py-16">
            Ask anything grounded in this interview&apos;s materials and Q&amp;A.
          </p>
        )}

        {history.map((exchange, i) => (
          <div key={i} className="space-y-3 pb-5 border-b border-gray-100 last:border-0">
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%]" style={QUESTION_STYLE}>
                {exchange.question}
              </div>
            </div>
            <div className="flex flex-col items-start gap-1">
              {exchange.badge && <span className="text-xs text-purple-600 pl-1">{exchange.badge}</span>}
              <div
                className="border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] answer-text"
                style={ANSWER_STYLE}
                dangerouslySetInnerHTML={{ __html: exchange.html }}
              />
            </div>
            {exchange.sources?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-1">
                {exchange.sources.slice(0, 3).map((s, j) => (
                  <span key={j} className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full">
                    {s.title}
                  </span>
                ))}
              </div>
            )}
            {exchange.timing && <p className="text-xs text-gray-400 pl-1">{formatTiming(exchange.timing)}</p>}
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 px-8 py-4 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          {DEVICES.map((device) => {
            // Only one device active at a time in Copilot; Job Mode (both) is a separate tab.
            const implemented = true
            const active = listenMode === device.key
            const blockedByOther = listenMode !== 'off' && !active
            const disabled = !implemented || blockedByOther
            const Icon = device.icon
            return (
              <button
                key={device.key}
                type="button"
                disabled={disabled}
                onClick={() => (active ? onStopListening() : onStartListening(device.key))}
                title={
                  !implemented
                    ? `${device.label} - coming soon`
                    : blockedByOther
                      ? 'Stop the active device first'
                      : `${active ? 'Stop' : 'Start'} ${device.label} listening`
                }
                className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border ${
                  disabled
                    ? 'opacity-50 cursor-not-allowed border-gray-200 text-gray-400'
                    : active
                      ? 'border-purple-500 bg-purple-50 text-purple-700'
                      : 'border-gray-200 text-gray-500 hover:border-purple-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {device.label}
              </button>
            )
          })}
          {listenMode !== 'off' && (
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <div className="w-12 h-1 bg-gray-100 rounded-full overflow-hidden shrink-0">
                <div
                  className="h-full bg-purple-500"
                  style={{ width: `${Math.min(100, listenMode === 'speaker' ? speakerLevel : micLevel)}%` }}
                />
              </div>
              <span className="text-xs text-gray-400 truncate">
                {speakerTranscript ||
                  (listenMode === 'speaker'
                    ? `Listening : ${speakerDeviceName || 'System Audio'}`
                    : `Listening : ${micDeviceName || 'Microphone'}`)}
              </span>
            </div>
          )}
        </div>
        {listenError && <p className="text-xs text-red-600">{listenError}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="field-input flex-1"
            placeholder="Ask an interview question..."
          />
          <button
            type="submit"
            disabled={!!streaming}
            className="bg-purple-600 text-white rounded-lg px-4 py-2.5 disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  )
}
