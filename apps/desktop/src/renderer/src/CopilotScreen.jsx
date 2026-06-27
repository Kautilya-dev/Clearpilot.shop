import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Send } from 'lucide-react'

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))
}

function formatTiming(timing) {
  const startedClock = new Date(timing.started_at).toLocaleTimeString()
  const firstChunk = timing.time_to_first_chunk_ms != null ? `first word in ${timing.time_to_first_chunk_ms}ms · ` : ''
  return `${startedClock} · ${firstChunk}done in ${(timing.duration_ms / 1000).toFixed(2)}s`
}

export default function CopilotScreen({ interview, onBack }) {
  const [history, setHistory] = useState([]) // completed exchanges, newest first
  const [streaming, setStreaming] = useState(null) // { question, html } | null
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const rawTextRef = useRef('')
  const pendingRenderRef = useRef(false)
  const conversationRef = useRef(null)

  useEffect(() => {
    // Re-parsing the *entire* accumulated markdown on every single chunk gets
    // progressively more expensive as the answer grows (a long answer can be 100+
    // chunks), and visibly lags behind the server's actual chunk-arrival rate by the
    // end of a long response even though the network/IPC side is fast. Throttling the
    // expensive parse+sanitize to once per animation frame - while still accumulating
    // every chunk's text immediately and cheaply - keeps rendering visually real-time
    // regardless of answer length, since 60fps updates read as instant to the eye.
    function flushRender() {
      pendingRenderRef.current = false
      setStreaming((s) => (s ? { ...s, html: renderMarkdown(rawTextRef.current) } : s))
    }

    window.clearpilot.onChatEvent((event) => {
      if (event.type === 'chunk') {
        rawTextRef.current += event.text
        if (!pendingRenderRef.current) {
          pendingRenderRef.current = true
          requestAnimationFrame(flushRender)
        }
      } else if (event.type === 'error') {
        setError(event.detail || 'Something went wrong')
        setStreaming(null)
      } else if (event.type === 'done') {
        // Compute directly from rawTextRef rather than trusting the last rendered
        // `s.html` - a throttled frame may still be pending when `done` arrives.
        const finalHtml = renderMarkdown(rawTextRef.current)
        setStreaming((s) => {
          if (s) {
            setHistory((h) => [
              {
                question: s.question,
                html: finalHtml,
                sources: event.sources,
                badge: event.from_qa_bank ? 'From your Q&A' : null,
                timing: event
              },
              ...h
            ])
          }
          return null
        })
      }
    })
    return () => window.clearpilot.offChatEvent()
  }, [])

  useEffect(() => {
    conversationRef.current?.scrollTo({ top: 0 })
  }, [streaming, history])

  async function handleSubmit(e) {
    e.preventDefault()
    const question = input.trim()
    if (!question || streaming) return
    setInput('')
    setError('')
    rawTextRef.current = ''
    setStreaming({ question, html: '' })

    const res = await window.clearpilot.askQuestion(interview.id, question)
    if (!res.success) {
      setError(res.error || 'Could not reach ClearPilot')
      setStreaming(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-gray-200 px-8 py-4 shrink-0">
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1 mb-2">
          &larr; All interviews
        </button>
        <h1 className="text-xl font-semibold tracking-tight">{interview.title}</h1>
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {interview.subjects.map((s) => (
            <span key={s.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
              {s.name}
            </span>
          ))}
        </div>
      </div>

      <div ref={conversationRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-5">
        {streaming && (
          <div className="space-y-3 pb-5 border-b border-gray-100">
            <div className="flex justify-end">
              <div className="bg-purple-600 text-white rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] text-sm">
                {streaming.question}
              </div>
            </div>
            <div
              className="bg-gray-50 border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] text-sm answer-text"
              dangerouslySetInnerHTML={{ __html: streaming.html }}
            />
          </div>
        )}

        {history.length === 0 && !streaming && (
          <p className="text-sm text-gray-400 text-center py-16">
            Ask anything grounded in this interview&apos;s materials and Q&amp;A.
          </p>
        )}

        {history.map((exchange, i) => (
          <div key={i} className="space-y-3 pb-5 border-b border-gray-100 last:border-0">
            <div className="flex justify-end">
              <div className="bg-purple-600 text-white rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] text-sm">
                {exchange.question}
              </div>
            </div>
            <div className="flex flex-col items-start gap-1">
              {exchange.badge && <span className="text-xs text-purple-600 pl-1">{exchange.badge}</span>}
              <div
                className="bg-gray-50 border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] text-sm answer-text"
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
            <p className="text-xs text-gray-400 pl-1">{formatTiming(exchange.timing)}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 px-8 py-4 shrink-0">
        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
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
