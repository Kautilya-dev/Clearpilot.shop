import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import MaterialsTab from './MaterialsTab'
import QATab from './QATab'
import CopilotScreen from './CopilotScreen'
import JudgeTab from './JudgeTab'
import FocusWidget from './FocusWidget'
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
// focusMode itself is owned by App.jsx (it also gates the Sidebar/TitleBar, which are
// siblings of this component) and passed down as a prop rather than duplicated in local state -
// two independent copies of the same boolean can desync (e.g. one side updates, the other
// doesn't), leaving Sidebar/TitleBar hidden while this component renders its normal tab UI.
export default function InterviewWorkspace({ interview, onBack, focusMode, onFocusModeChange }) {
  const [activeTab, setActiveTab] = useState('copilot')
  const [focusSource, setFocusSource] = useState(null)

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
  const [listenMode, setListenMode] = useState('off') // 'off' | 'speaker' | 'mic' | 'both' | 'partner'
  const [speakerTranscript, setSpeakerTranscript] = useState('')
  const [listenError, setListenError] = useState('')
  // Practice Partner mode - whether the web app's Prompter tab is currently connected to
  // this session's relay (see JudgeTab.jsx's TeleprompterPanel).
  const [guestConnected, setGuestConnected] = useState(false)

  // Job Mode round state — each round: { id, question, suggestion, response, feedback }
  const jobCurrentRef = useRef({ question: '', suggestion: '', response: '' })
  const [jobCurrent, setJobCurrent] = useState({ question: '', suggestion: '', response: '', feedback: '' })
  const [jobRounds, setJobRounds] = useState([])
  const roundIdRef = useRef(0) // stable ids so Focus Mode's pin feature survives new rounds shifting array positions
  // Which Job Mode rounds are pinned in the Focus Mode widget - lifted here (not local to
  // FocusWidget) so pins survive exiting and re-entering Focus Mode, not just remounts within it.
  const [pinnedRoundIds, setPinnedRoundIds] = useState(() => new Set())

  function toggleRoundPin(id) {
    setPinnedRoundIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Load past conversation so the user can continue exactly where they left off - re-runs
  // every time the Copilot tab itself is opened (not just on first mount), so a question
  // asked from the web app (or another device) while this one sat open on a different tab
  // shows up here without needing a restart. Entries arrive newest-first from the API.
  // Safe to just overwrite `history` even mid-stream - the in-progress exchange lives in the
  // separate `streaming` state until it finishes, so a refetch here can't clobber it.
  useEffect(() => {
    if (activeTab !== 'copilot') return
    window.clearpilot.getHistory(interview.id, 100).then((res) => {
      if (res.success && res.entries?.length) {
        // /history is shared with Practice Partner's saved rounds (see savePracticeRound
        // above, apps/web/routers/history.py) - exclude those here so a practice round
        // doesn't show up as a Copilot Q&A exchange.
        setHistory(
          res.entries
            .filter((entry) => !entry.question.startsWith('Practice session with partner'))
            .map((entry) => ({
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
  }, [interview.id, activeTab])

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
  // The Realtime API fires the mic's transcription-completed and response-done events as
  // two independent streams with no ordering guarantee - the judge's feedback can arrive
  // before the transcript of what the candidate actually said. Discovered from a real saved
  // Practice Partner round whose "Your response" came back empty even though the feedback
  // clearly reacted to real speech. These hold a feedback that arrived first until the
  // matching transcript catches up (or a short timeout elapses, so a round can't get stuck).
  const pendingMicFeedbackRef = useRef(null)
  const pendingMicFeedbackTimeoutRef = useRef(null)

  function finalizeMicRound(feedbackText) {
    const round = {
      id: ++roundIdRef.current,
      question: jobCurrentRef.current.question,
      suggestion: jobCurrentRef.current.suggestion,
      response: jobCurrentRef.current.response,
      feedback: feedbackText
    }
    const wasPartnerRound = listenModeRef.current === 'partner'
    jobCurrentRef.current = { question: '', suggestion: '', response: '' }
    setJobCurrent({ question: '', suggestion: '', response: '', feedback: '' })
    setJobRounds((r) => [round, ...r])
    // Regular AI-vs-candidate Job Mode rounds aren't persisted (matches existing behavior) -
    // only practice-partner rounds get saved to History.
    if (wasPartnerRound) {
      window.clearpilot.savePracticeRound(interview.id, round.suggestion, round.response, feedbackText)
    }
  }

  useEffect(() => {
    window.clearpilot.onListeningQuestion(({ source, text }) => {
      if (source === 'speaker') {
        speakerTranscriptRef.current = text
        setSpeakerTranscript(text)
        if (listenModeRef.current === 'both' || listenModeRef.current === 'partner') {
          jobCurrentRef.current.question = text
          setJobCurrent((c) => ({ ...c, question: text }))
        }
      } else if (source === 'mic' && (listenModeRef.current === 'both' || listenModeRef.current === 'partner')) {
        // What the candidate actually said in Job Mode
        jobCurrentRef.current.response = text
        setJobCurrent((c) => ({ ...c, response: text }))
        // The judge's feedback may already be waiting on this exact transcript - see the
        // pendingMicFeedbackRef comment above.
        if (pendingMicFeedbackRef.current !== null) {
          clearTimeout(pendingMicFeedbackTimeoutRef.current)
          const feedbackText = pendingMicFeedbackRef.current
          pendingMicFeedbackRef.current = null
          finalizeMicRound(feedbackText)
        }
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
        } else if (listenModeRef.current === 'partner') {
          // Practice Partner mode: the speaker session still transcribes the interviewer's
          // question (above), but its own generated answer goes unused here - the judge's
          // reference answer comes from the relayed partner transcript instead (see the
          // onPracticeTranscript effect below), not from this local AI-generated one.
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
        if (listenModeRef.current === 'both' || listenModeRef.current === 'partner') {
          // Job Mode: mic GPT answer is the judge's feedback. Usually the response transcript
          // (onListeningQuestion's mic branch above) has already arrived by now - finalize
          // right away. But the Realtime API doesn't guarantee that order, so if it hasn't,
          // hold this feedback and let the transcript's arrival finalize the round instead
          // (with a timeout fallback in case the transcript never shows up at all).
          if (jobCurrentRef.current.response) {
            finalizeMicRound(text)
          } else {
            pendingMicFeedbackRef.current = text
            pendingMicFeedbackTimeoutRef.current = setTimeout(() => {
              if (pendingMicFeedbackRef.current !== null) {
                const feedbackText = pendingMicFeedbackRef.current
                pendingMicFeedbackRef.current = null
                finalizeMicRound(feedbackText)
              }
            }, 2500)
          }
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

  // Practice Partner mode - the relayed transcript from the web app's Prompter tab (see
  // apps/web/routers/practice.py) populates jobCurrent.suggestion the same way the AI's
  // speaker-generated answer does in normal Job Mode, just from a different source. A
  // partner may speak across several pauses, so each arriving chunk appends rather than
  // replaces - jobCurrentRef.current resets naturally when a round finalizes above.
  useEffect(() => {
    window.clearpilot.onPracticeTranscript(({ text }) => {
      const accumulated = jobCurrentRef.current.suggestion ? `${jobCurrentRef.current.suggestion} ${text}` : text
      jobCurrentRef.current.suggestion = accumulated
      setJobCurrent((c) => ({ ...c, suggestion: accumulated }))
    })
    window.clearpilot.onPracticeGuestStatus(({ connected }) => setGuestConnected(connected))
    window.clearpilot.onPracticeError(({ message }) => setListenError(message))
    return () => window.clearpilot.offPracticeEvents()
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

  // Dismisses the in-progress answer so a new question can be asked immediately, without
  // waiting for streaming to finish. Client-side only - the backend keeps generating and
  // still saves the answer to History (it'll show up next time History refetches), this just
  // stops the renderer from displaying/waiting on it. Safe because the chat:event handler
  // above already guards every state update with "if (s)" checks against the CURRENT
  // streaming value, so late chunks/done events for the dismissed answer become no-ops
  // instead of reappearing or double-saving.
  function dismissStreaming() {
    isBusyRef.current = false
    setStreaming(null)
    setChatError('')
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
    } else if (source === 'both' || source === 'partner') {
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
    } else if (mode === 'both' || mode === 'partner') {
      await window.clearpilot.stopListening(mode)
      audioCapture.stopBothCapture()
    }
    listenModeRef.current = 'off'
    setListenMode('off')
    setSpeakerTranscript('')
    setGuestConnected(false)
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

  // Focus Mode shrinks the window into a floating widget rather than opening a second
  // BrowserWindow - InterviewWorkspace stays mounted underneath so the audio session above
  // is never interrupted, and onFocusModeChange bubbles the flag up to App.jsx so it can hide
  // the TitleBar/Sidebar, which are siblings of this component, not descendants.
  async function enterFocusMode(source) {
    setFocusSource(source)
    onFocusModeChange?.(true)
    await window.clearpilot.enterFocusMode()
  }

  async function exitFocusMode() {
    await window.clearpilot.exitFocusMode()
    onFocusModeChange?.(false)
    setFocusSource(null)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {!focusMode && (
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
      )}

      {/* Rendered together (not conditionally mounted) so switching tabs - or toggling Focus
          Mode - doesn't lose an in-progress Copilot conversation, a live listening session, or
          re-fetch Materials/Q&A lists every time. */}
      <div className={!focusMode && activeTab === 'materials' ? 'contents' : 'hidden'}>
        <MaterialsTab interviewId={interview.id} />
      </div>
      <div className={!focusMode && activeTab === 'qa' ? 'contents' : 'hidden'}>
        <QATab interviewId={interview.id} />
      </div>
      <div className={!focusMode && activeTab === 'copilot' ? 'contents' : 'hidden'}>
        <CopilotScreen
          history={history}
          historyLoading={historyLoading}
          streaming={streaming}
          error={chatError}
          onSubmit={submitQuestion}
          onDismiss={dismissStreaming}
          listenMode={listenMode}
          speakerLevel={audioCapture.speakerLevel}
          speakerDeviceName={audioCapture.speakerDeviceName}
          micLevel={audioCapture.micLevel}
          micDeviceName={audioCapture.micDeviceName}
          speakerTranscript={speakerTranscript}
          listenError={listenError}
          onStartListening={startListening}
          onStopListening={stopListening}
          onFocusMode={() => enterFocusMode('copilot')}
        />
      </div>
      <div className={!focusMode && activeTab === 'judge' ? 'contents' : 'hidden'}>
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
          guestConnected={guestConnected}
          onFocusMode={() => enterFocusMode('judge')}
        />
      </div>

      {focusMode && (
        <FocusWidget
          source={focusSource}
          onExit={exitFocusMode}
          listenMode={listenMode}
          listenError={listenError}
          onStartListening={startListening}
          onStopListening={stopListening}
          speakerLevel={audioCapture.speakerLevel}
          speakerDeviceName={audioCapture.speakerDeviceName}
          micLevel={audioCapture.micLevel}
          micDeviceName={audioCapture.micDeviceName}
          streaming={streaming}
          history={history}
          speakerTranscript={speakerTranscript}
          jobCurrent={jobCurrent}
          jobRounds={jobRounds}
          pinnedRoundIds={pinnedRoundIds}
          onToggleRoundPin={toggleRoundPin}
          guestConnected={guestConnected}
        />
      )}
    </div>
  )
}
