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
  { key: 'copilot', label: 'Copilot' }
  // Job Mode tab hidden until full release — feature is built but not exposed
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
  const [historyLoading, setHistoryLoading] = useState(true)
  const [streaming, setStreaming] = useState(null)
  const [chatError, setChatError] = useState('')
  const rawTextRef = useRef('')
  const pendingRenderRef = useRef(false)
  const isBusyRef = useRef(false) // mirrors "streaming !== null" without closure-staleness risk

  const audioCapture = useAudioCapture()
  // listenModeRef mirrors listenMode without closure-staleness in IPC callbacks
  const listenModeRef = useRef('off')
  const [listenMode, setListenMode] = useState('off') // 'off' | 'speaker' | 'mic' | 'both'
  const [speakerTranscript, setSpeakerTranscript] = useState('')
  const [listenError, setListenError] = useState('')

  // Job Mode round state — each round: { question, suggestion, response, feedback }
  const jobCurrentRef = useRef({ question: '', suggestion: '', response: '' })
  const [jobCurrent, setJobCurrent] = useState({ question: '', suggestion: '', response: '', feedback: '' })
  const [jobRounds, setJobRounds] = useState([])

  // Load past conversation when entering the workspace so the user can continue
  // exactly where they left off. Entries arrive newest-first from the API.
  useEffect(() => {
    window.clearpilot.getHistory(interview.id, 100).then((res) => {
      if (res.success && res.entries?.length) {
        setHistory(
          res.entries.map((entry) => ({
            question: entry.question,
            html: renderMarkdown(entry.answer || ''),
            sources: entry.sources || [],
            badge: entry.from_qa_bank ? 'From your Q&A' : null,
            timing: entry.started_at
              ? { started_at: entry.started_at, time_to_first_chunk_ms: entry.time_to_first_chunk_ms, duration_ms: entry.duration_ms }
              : null
          }))
        )
      }
      setHistoryLoading(false)
    })
  }, [interview.id])

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

  const speakerTranscriptRef = useRef('')

  useEffect(() => {
    window.clearpilot.onListeningQuestion(({ source, text }) => {
      if (source === 'speaker') {
        speakerTranscriptRef.current = text
        setSpeakerTranscript(text)
        if (listenModeRef.current === 'both') {
          jobCurrentRef.current.question = text
          setJobCurrent((c) => ({ ...c, question: text }))
        }
      } else if (source === 'mic' && listenModeRef.current === 'both') {
        // What the candidate actually said in Job Mode
        jobCurrentRef.current.response = text
        setJobCurrent((c) => ({ ...c, response: text }))
      }
    })

    window.clearpilot.onListeningAnswer(({ source, text }) => {
      if (source === 'speaker') {
        if (listenModeRef.current === 'both') {
          // Job Mode: speaker GPT answer is the suggestion — don't push to copilot history
          jobCurrentRef.current.suggestion = text
          setJobCurrent((c) => ({ ...c, suggestion: text }))
          speakerTranscriptRef.current = ''
          setSpeakerTranscript('')
        } else {
          // Copilot mode: push speaker answer directly into conversation history
          const question = speakerTranscriptRef.current || '🎤 Speaker'
          speakerTranscriptRef.current = ''
          setSpeakerTranscript('')
          const html = renderMarkdown(text)
          setHistory((h) => [{ question, html, sources: [], badge: '🎤 Live audio', timing: null }, ...h])
        }
      } else if (source === 'mic') {
        if (listenModeRef.current === 'both') {
          // Job Mode: mic GPT answer is the judge's feedback — finalize the round
          const round = {
            question: jobCurrentRef.current.question,
            suggestion: jobCurrentRef.current.suggestion,
            response: jobCurrentRef.current.response,
            feedback: text
          }
          jobCurrentRef.current = { question: '', suggestion: '', response: '' }
          setJobCurrent({ question: '', suggestion: '', response: '', feedback: '' })
          setJobRounds((r) => [round, ...r])
        } else {
          // Copilot mode: push mic answer directly into conversation history
          const question = speakerTranscriptRef.current || '🎤 Mic'
          speakerTranscriptRef.current = ''
          setSpeakerTranscript('')
          const html = renderMarkdown(text)
          setHistory((h) => [{ question, html, sources: [], badge: '🎤 Live audio', timing: null }, ...h])
        }
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
    // Capture audio first so device names appear immediately, independent of WS connect time.
    if (source === 'speaker') {
      const captureRes = await audioCapture.startSpeakerCapture()
      if (!captureRes.success) { setListenError(captureRes.message); return }
    } else if (source === 'mic') {
      const captureRes = await audioCapture.startMicCapture()
      if (!captureRes.success) { setListenError(captureRes.message); return }
    } else if (source === 'both') {
      const captureRes = await audioCapture.startBothCapture()
      if (!captureRes.success) { setListenError(captureRes.message); return }
    }
    listenModeRef.current = source
    setListenMode(source)
    const res = await window.clearpilot.startListening(interview.id, source)
    if (!res.success) setListenError(res.error)
  }

  async function stopListening() {
    const mode = listenModeRef.current
    if (mode === 'speaker') {
      await window.clearpilot.stopListening('speaker')
      audioCapture.stopSpeakerCapture()
    } else if (mode === 'mic') {
      await window.clearpilot.stopListening('mic')
      audioCapture.stopMicCapture()
    } else if (mode === 'both') {
      await window.clearpilot.stopListening('both')
      audioCapture.stopBothCapture()
    }
    listenModeRef.current = 'off'
    setListenMode('off')
    setSpeakerTranscript('')
  }

  useEffect(() => {
    return () => {
      window.clearpilot.stopListening('speaker')
      window.clearpilot.stopListening('mic')
      audioCapture.stopSpeakerCapture()
      audioCapture.stopMicCapture()
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
          historyLoading={historyLoading}
          streaming={streaming}
          error={chatError}
          onSubmit={submitQuestion}
          listenMode={listenMode}
          speakerLevel={audioCapture.speakerLevel}
          speakerDeviceName={audioCapture.speakerDeviceName}
          micLevel={audioCapture.micLevel}
          micDeviceName={audioCapture.micDeviceName}
          speakerTranscript={speakerTranscript}
          listenError={listenError}
          onStartListening={startListening}
          onStopListening={stopListening}
        />
      </div>
      <div className={activeTab === 'judge' ? 'contents' : 'hidden'}>
        <JudgeTab
          listenMode={listenMode}
          listenError={listenError}
          onStartListening={startListening}
          onStopListening={stopListening}
          speakerLevel={audioCapture.speakerLevel}
          speakerDeviceName={audioCapture.speakerDeviceName}
          micLevel={audioCapture.micLevel}
          micDeviceName={audioCapture.micDeviceName}
          jobCurrent={jobCurrent}
          jobRounds={jobRounds}
        />
      </div>
    </div>
  )
}
