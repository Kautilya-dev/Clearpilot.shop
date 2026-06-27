import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import MaterialsTab from './MaterialsTab'
import QATab from './QATab'
import CopilotScreen from './CopilotScreen'
import JudgeTab from './JudgeTab'
import { useAudioCapture } from './hooks/useAudioCapture'

const TABS = [
  { key: 'materials', label: 'Materials' },
  { key: 'qa', label: 'Q&A' },
  { key: 'copilot', label: 'Copilot' },
  { key: 'judge', label: 'Job Mode' }
]

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))
}

// Chat exchange state (history/streaming) and the audio-capture hook are lifted up here,
// shared between CopilotScreen and JudgeTab - both need to react to the same chat:event
// stream and drive the same mic/speaker sessions, and only one place should own the
// window.clearpilot.onChatEvent subscription (two independent subscribers would both have
// to call offChatEvent's removeAllListeners on cleanup, which would silently kill the other).
export default function InterviewWorkspace({ interview, onBack }) {
  const [activeTab, setActiveTab] = useState('copilot')

  const [history, setHistory] = useState([])
  const [streaming, setStreaming] = useState(null)
  const [chatError, setChatError] = useState('')
  const rawTextRef = useRef('')
  const pendingRenderRef = useRef(false)
  const isBusyRef = useRef(false) // mirrors "streaming !== null" without closure-staleness risk

  const audioCapture = useAudioCapture()
  const [listenMode, setListenMode] = useState('off') // 'off' | 'speaker' (mic/both arrive in later phases)
  const [speakerTranscript, setSpeakerTranscript] = useState('')
  const [listenError, setListenError] = useState('')

  useEffect(() => {
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
        isBusyRef.current = false
        setChatError(event.detail || 'Something went wrong')
        setStreaming(null)
      } else if (event.type === 'done') {
        isBusyRef.current = false
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
    window.clearpilot.onListeningTranscript(({ source, text }) => {
      if (source === 'speaker') {
        setSpeakerTranscript(text)
        submitQuestion(text)
      }
    })
    window.clearpilot.onListeningError(({ message }) => setListenError(message))
    return () => window.clearpilot.offListeningEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submitQuestion(question) {
    const trimmed = question.trim()
    if (!trimmed || isBusyRef.current) return
    isBusyRef.current = true
    setChatError('')
    rawTextRef.current = ''
    setStreaming({ question: trimmed, html: '' })

    const res = await window.clearpilot.askQuestion(interview.id, trimmed)
    if (!res.success) {
      isBusyRef.current = false
      setChatError(res.error || 'Could not reach ClearPilot')
      setStreaming(null)
    }
  }

  async function startListening(source) {
    setListenError('')
    const res = await window.clearpilot.startListening(interview.id, source)
    if (!res.success) {
      setListenError(res.error)
      return
    }
    if (source === 'speaker') {
      const captureRes = await audioCapture.startSpeakerCapture()
      if (!captureRes.success) {
        setListenError(captureRes.message)
        await window.clearpilot.stopListening('speaker')
        return
      }
    }
    setListenMode(source)
  }

  async function stopListening() {
    if (listenMode === 'speaker') {
      await window.clearpilot.stopListening('speaker')
      audioCapture.stopSpeakerCapture()
    }
    setListenMode('off')
    setSpeakerTranscript('')
  }

  useEffect(() => {
    return () => {
      window.clearpilot.stopListening('speaker')
      audioCapture.stopSpeakerCapture()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-gray-200 px-8 pt-4 shrink-0">
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1 mb-2">
          &larr; All interviews
        </button>
        <h1 className="text-xl font-semibold tracking-tight">{interview.title}</h1>
        <div className="flex items-center gap-1.5 flex-wrap mt-2 mb-3">
          {interview.subjects.map((s) => (
            <span key={s.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
              {s.name}
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`text-sm px-3 py-1.5 rounded-lg ${
                activeTab === tab.key ? 'bg-purple-50 text-purple-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rendered together (not conditionally mounted) so switching tabs doesn't lose an
          in-progress Copilot conversation, a live listening session, or re-fetch Materials/Q&A lists every time. */}
      <div className={activeTab === 'materials' ? 'contents' : 'hidden'}>
        <MaterialsTab interviewId={interview.id} />
      </div>
      <div className={activeTab === 'qa' ? 'contents' : 'hidden'}>
        <QATab interviewId={interview.id} />
      </div>
      <div className={activeTab === 'copilot' ? 'contents' : 'hidden'}>
        <CopilotScreen
          history={history}
          streaming={streaming}
          error={chatError}
          onSubmit={submitQuestion}
          listenMode={listenMode}
          speakerLevel={audioCapture.speakerLevel}
          speakerDeviceName={audioCapture.speakerDeviceName}
          speakerTranscript={speakerTranscript}
          listenError={listenError}
          onStartListening={startListening}
          onStopListening={stopListening}
        />
      </div>
      <div className={activeTab === 'judge' ? 'contents' : 'hidden'}>
        <JudgeTab listenMode={listenMode} listenError={listenError} onStartListening={startListening} onStopListening={stopListening} />
      </div>
    </div>
  )
}
