import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Mic, Volume2 } from 'lucide-react'

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

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))
}

// "Job Mode" — Speaker hears the interviewer and GPT suggests an answer.
// Mic hears the candidate's actual response and a judge compares it to the suggestion.
export default function JudgeTab({
  listenMode,
  listenError,
  onStartListening,
  onStopListening,
  speakerLevel,
  speakerDeviceName,
  micLevel,
  micDeviceName,
  jobCurrent,
  jobRounds
}) {
  const active = listenMode === 'both'

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Conversation area */}
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
        {/* In-progress round */}
        {active && (jobCurrent.question || jobCurrent.suggestion || jobCurrent.response) && (
          <div className="space-y-3 pb-5 border-b border-gray-100 opacity-80">
            {jobCurrent.question && (
              <div className="flex justify-end">
                <div className="rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] text-xs" style={QUESTION_STYLE}>
                  <span className="block text-[10px] opacity-60 mb-0.5">Interviewer</span>
                  {jobCurrent.question}
                </div>
              </div>
            )}
            {jobCurrent.suggestion && (
              <div>
                <p className="text-[10px] text-purple-400 pl-1 mb-1">Suggested answer</p>
                <div
                  className="border border-purple-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] answer-text"
                  style={ANSWER_STYLE}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(jobCurrent.suggestion) }}
                />
              </div>
            )}
            {jobCurrent.response && (
              <div className="flex justify-end">
                <div className="rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] text-xs bg-blue-50 text-blue-900 border border-blue-100">
                  <span className="block text-[10px] text-blue-400 mb-0.5">Your response</span>
                  {jobCurrent.response}
                </div>
              </div>
            )}
            {!jobCurrent.response && jobCurrent.suggestion && (
              <p className="text-xs text-gray-400 pl-1 animate-pulse">Listening for your response…</p>
            )}
            {jobCurrent.response && !jobCurrent.feedback && (
              <p className="text-xs text-gray-400 pl-1 animate-pulse">Analysing your response…</p>
            )}
          </div>
        )}

        {/* Empty state */}
        {!active && jobRounds.length === 0 && (
          <div className="text-center py-16 space-y-2">
            <p className="text-sm font-medium text-gray-600">Job Mode</p>
            <p className="text-xs text-gray-400 max-w-xs mx-auto">
              Runs Speaker and Mic together. GPT suggests an answer to the interviewer's question; your spoken
              response is compared to it and you receive feedback.
            </p>
          </div>
        )}

        {active && jobRounds.length === 0 && !jobCurrent.question && (
          <p className="text-sm text-gray-400 text-center py-12">
            Waiting for the interviewer to speak…
          </p>
        )}

        {/* Completed rounds */}
        {jobRounds.map((round, i) => (
          <div key={i} className="space-y-3 pb-5 border-b border-gray-100 last:border-0">
            {/* Interviewer question */}
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] text-xs" style={QUESTION_STYLE}>
                <span className="block text-[10px] opacity-60 mb-0.5">Interviewer</span>
                {round.question || '—'}
              </div>
            </div>

            {/* GPT suggestion */}
            {round.suggestion && (
              <div>
                <p className="text-[10px] text-purple-400 pl-1 mb-1">Suggested answer</p>
                <div
                  className="border border-purple-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] answer-text"
                  style={ANSWER_STYLE}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(round.suggestion) }}
                />
              </div>
            )}

            {/* Candidate's actual response */}
            {round.response && (
              <div className="flex justify-end">
                <div className="rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] text-xs bg-blue-50 text-blue-900 border border-blue-100">
                  <span className="block text-[10px] text-blue-400 mb-0.5">Your response</span>
                  {round.response}
                </div>
              </div>
            )}

            {/* Judge feedback */}
            {round.feedback && (
              <div>
                <p className="text-[10px] text-amber-500 pl-1 mb-1">Coach feedback</p>
                <div
                  className="border border-amber-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] answer-text bg-amber-50 text-amber-900"
                  style={{ fontSize: 'var(--style-answer-font-size, 14px)' }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(round.feedback) }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Controls bar */}
      <div className="border-t border-gray-200 px-8 py-4 shrink-0 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => (active ? onStopListening() : onStartListening('both'))}
            className={`text-sm px-4 py-2 rounded-lg border font-medium transition-colors ${
              active
                ? 'border-purple-500 bg-purple-50 text-purple-700 hover:bg-purple-100'
                : 'border-gray-300 text-gray-600 hover:border-purple-300 hover:text-purple-600'
            }`}
          >
            {active ? 'Stop Job Mode' : 'Start Job Mode'}
          </button>

          {active && (
            <div className="flex items-center gap-3">
              {/* Speaker level */}
              <div className="flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5 text-gray-400" />
                <div className="w-10 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-purple-500 transition-all" style={{ width: `${Math.min(100, speakerLevel)}%` }} />
                </div>
                <span className="text-xs text-gray-400 truncate max-w-[120px]">
                  {speakerDeviceName || 'System Audio'}
                </span>
              </div>
              {/* Mic level */}
              <div className="flex items-center gap-1.5">
                <Mic className="w-3.5 h-3.5 text-gray-400" />
                <div className="w-10 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-400 transition-all" style={{ width: `${Math.min(100, micLevel)}%` }} />
                </div>
                <span className="text-xs text-gray-400 truncate max-w-[120px]">
                  {micDeviceName || 'Microphone'}
                </span>
              </div>
            </div>
          )}
        </div>

        {listenError && <p className="text-xs text-red-600">{listenError}</p>}

        {!active && (
          <p className="text-xs text-gray-400">
            Requires mic permission and speaker (loopback) access. Only one mode can be active at a time.
          </p>
        )}
      </div>
    </div>
  )
}
