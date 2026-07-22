/* ABOUT THIS FILE
 * Owns all state shared between the Copilot tab (CopilotScreen.jsx) and the Prompter tab
 * (PrompterTab.jsx) - the chat/history state, the audio-capture hook, and the Realtime
 * listening-session state machine (listenMode) - since both tabs render simultaneously
 * (hidden via CSS, not unmounted, so switching tabs doesn't kill an in-progress session or
 * conversation) and only one place should own the window.clearpilot IPC event subscriptions.
 * Rendered by App.jsx once an interview is selected; renders MaterialsTab, QATab,
 * CopilotScreen, PrompterTab, and (only for Copilot's Focus Mode - Prompter no longer has
 * one) FocusWidget as children.
 */
import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import MaterialsTab from './MaterialsTab'
import QATab from './QATab'
import CopilotScreen from './CopilotScreen'
import PrompterTab from './PrompterTab'
import FocusWidget from './FocusWidget'
import { useAudioCapture } from './hooks/useAudioCapture'

const TABS = [
  { key: 'materials', label: 'Materials' },
  { key: 'qa', label: 'Q&A' },
  { key: 'copilot', label: 'Copilot' },
  { key: 'prompter', label: 'Prompter' }
]

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { breaks: true }))
}

// Chat exchange state (history/streaming) and the audio-capture hook are lifted up here,
// shared between CopilotScreen and PrompterTab - both need to react to the same chat:event
// stream and drive the same mic/speaker sessions, and only one place should own the
// window.clearpilot.onChatEvent subscription (two independent subscribers would both have
// to call offChatEvent's removeAllListeners on cleanup, which would silently kill the other).
// focusMode itself is owned by App.jsx (it also gates the Sidebar/TitleBar, which are
// siblings of this component) and passed down as a prop rather than duplicated in local state -
// two independent copies of the same boolean can desync (e.g. one side updates, the other
// doesn't), leaving Sidebar/TitleBar hidden while this component renders its normal tab UI.
export default function InterviewWorkspace({ interview, onBack, focusMode, onFocusModeChange }) {
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
  const [listenMode, setListenMode] = useState('off') // 'off' | 'speaker' | 'mic' | 'prompter'
  const [speakerTranscript, setSpeakerTranscript] = useState('')
  const [listenError, setListenError] = useState('')
  // Prompter tab - whether the web app's Prompter tab is currently connected to this
  // session's relay (see PrompterTab.jsx's Web Prompter Transcription panel).
  const [guestConnected, setGuestConnected] = useState(false)

  // Prompter tab's AI Generated Response panel - what the Speaker session heard/generated
  // from system audio. No judging/comparison of anything the candidate says - removed
  // entirely along with Job Mode's AI judge (see PrompterTab.jsx, formerly JudgeTab.jsx).
  // Mirrors Copilot's streaming/history split: RealtimeSessionManager (realtimeSessionManager.js)
  // emits onQuestion/onAnswer exactly ONCE per finalized question/answer (not chunked), so a
  // NEW listening:question event always means a genuinely new exchange started, not a
  // continuation - pendingAiQuestion holds a heard-but-not-yet-answered question (like
  // Copilot's `streaming` with no html yet), and once the answer arrives the completed pair
  // is prepended to aiResponseHistory (newest first, like Copilot's `history`) instead of
  // overwriting a single slot - so multiple interviewer questions during one Prompter session
  // all stay visible instead of each one erasing the last.
  const aiResponseHistoryRef = useRef([])
  const [aiResponseHistory, setAiResponseHistory] = useState([])
  const pendingAiQuestionRef = useRef('')
  const [pendingAiQuestion, setPendingAiQuestion] = useState('')
  // Prompter tab's Web Prompter Transcription panel - the live relay from the web app's
  // Prompter tab, independent of aiResponseHistory above (both panels run simultaneously now,
  // unlike the old Job Mode/Practice Partner split where only one suggestion source was
  // ever active at a time). An array of segments (message cards, matching the web
  // Prompter's own display) rather than one flat string - see onPracticeTranscript below
  // for why that distinction matters. Newest segment first (index 0), matching Copilot's
  // newest-first history so the latest transcript is always visible without scrolling.
  const partnerTranscriptRef = useRef([])
  const [partnerTranscript, setPartnerTranscript] = useState([])
  // Whether the AI Generated Response panel is enabled - lifted here (not local to
  // PrompterTab) because toggling it must actually start/stop the underlying Speaker
  // session (see toggleAiResponse below), not just hide the panel - the Prompter tab's own
  // Start/Stop button only ever controls the relay (Web Prompter Transcription), so this is
  // the only thing that starts/stops the Speaker session while Prompter is active.
  const aiEnabledRef = useRef(true)
  const [aiEnabled, setAiEnabledState] = useState(true)

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
        // /history is shared with Prompter's saved sessions (see savePrompterSession
        // above, apps/web/routers/history.py) - exclude those here so a Prompter session
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

  useEffect(() => {
    window.clearpilot.onListeningQuestion(({ source, text }) => {
      if (source !== 'speaker') return // 'mic' question events are unused now - no judge to feed them to
      speakerTranscriptRef.current = text
      setSpeakerTranscript(text)
      if (listenModeRef.current === 'prompter') {
        pendingAiQuestionRef.current = text
        setPendingAiQuestion(text)
      }
    })

    window.clearpilot.onListeningAnswer(({ source, text }) => {
      if (source === 'speaker') {
        if (listenModeRef.current === 'prompter') {
          // Prompter tab: speaker GPT answer feeds the AI Generated Response panel - don't
          // push to Copilot history, that panel has its own display (see PrompterTab.jsx).
          // The answer arrives once, fully formed (see realtimeSessionManager.js's onAnswer),
          // so as soon as it's here the exchange is complete - prepend it to history
          // (newest first) and clear the pending question rather than overwriting one slot.
          const question = pendingAiQuestionRef.current
          const updated = [{ question, answer: text }, ...aiResponseHistoryRef.current]
          aiResponseHistoryRef.current = updated
          setAiResponseHistory(updated)
          pendingAiQuestionRef.current = ''
          setPendingAiQuestion('')
        } else {
          // Copilot mode: push speaker answer directly into conversation history
          const question = speakerTranscriptRef.current || '🎤 Speaker'
          const html = renderMarkdown(text)
          setHistory((h) => [{ question, html, sources: [], badge: '🎤 Live audio', timing: null }, ...h])
        }
        speakerTranscriptRef.current = ''
        setSpeakerTranscript('')
      } else if (source === 'mic') {
        // Copilot mode only now - the Prompter tab never starts a mic session (no AI judge/
        // comparison of the candidate's spoken response anymore).
        const question = speakerTranscriptRef.current || '🎤 Mic'
        speakerTranscriptRef.current = ''
        setSpeakerTranscript('')
        const html = renderMarkdown(text)
        setHistory((h) => [{ question, html, sources: [], badge: '🎤 Live audio', timing: null }, ...h])
      }
    })

    window.clearpilot.onListeningError(({ message }) => setListenError(message))
    return () => window.clearpilot.offListeningEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Prompter tab's Web Prompter Transcription panel - the relayed transcript from the web
  // app's Prompter tab (see apps/web/routers/practice.py), independent of aiResponseHistory
  // above. A partner may speak across several pauses, so a genuinely new segment (card)
  // prepends rather than replaces - partnerTranscriptRef resets when the Prompter session stops (see
  // stopListening below). The web Prompter's speech engine re-fires isFinal multiple times
  // for what is really the same growing utterance ("hi", then "hi my name", then "hi my
  // name is Krishna", each sent over the relay as its own transcript_final) rather than
  // settling once. Comparing an arriving fragment against the ENTIRE accumulated session
  // text (a single flat string) only correctly merges revisions of the FIRST card ever -
  // every card after that starts a fresh utterance that doesn't extend the whole prior
  // history, so it got appended piecemeal fragment-by-fragment instead of merged in place,
  // producing a garbled run-on (confirmed live: "tell tell me tell me about SAP as as well
  // as..."). Tracking segments as an array and comparing only against the most recently
  // added one - not the whole history - mirrors what the web Prompter's own
  // appendPrompterLine() already does correctly, and is also what lets the desktop render
  // these as separate message cards instead of one flowing paragraph (see PrompterTab.jsx).
  // The most recent segment lives at index 0 (not the end) so it displays newest-first, like
  // Copilot's history - growing revisions of the current utterance still merge correctly,
  // just compared against segments[0] instead of the last index.
  useEffect(() => {
    window.clearpilot.onPracticeTranscript(({ text }) => {
      const segments = partnerTranscriptRef.current
      const mostRecent = segments[0]
      const updated = mostRecent && text.startsWith(mostRecent) ? [text, ...segments.slice(1)] : [text, ...segments]
      partnerTranscriptRef.current = updated
      setPartnerTranscript(updated)
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
    if (source === 'prompter') {
      // Base Prompter session - just the relay (Web Prompter Transcription). No audio
      // capture needed for that at all; the AI Generated Response panel is a separate
      // session started right after, only if currently enabled, so its own failure (e.g.
      // no OpenAI key set) can't prevent the relay itself from connecting.
      listenModeRef.current = 'prompter'
      setListenMode('prompter')
      const res = await window.clearpilot.startListening(interview.id, 'prompter')
      if (!res.success) {
        setListenError(res.error)
        listenModeRef.current = 'off'
        setListenMode('off')
        return
      }
      if (aiEnabledRef.current) await startAiResponse()
      return
    }
    // Copilot mode: Speaker and Mic are alternative ways to ASK the same Copilot a question.
    if (source === 'speaker') {
      const captureRes = await audioCapture.startSpeakerCapture()
      if (!captureRes.success) { setListenError(captureRes.message); return }
    } else if (source === 'mic') {
      const captureRes = await audioCapture.startMicCapture()
      if (!captureRes.success) { setListenError(captureRes.message); return }
    }
    listenModeRef.current = source
    setListenMode(source)
    const res = await window.clearpilot.startListening(interview.id, source)
    if (!res.success) setListenError(res.error)
  }

  // AI Generated Response panel's own start/stop - independent of the Prompter tab's
  // Start/Stop button, which only ever controls the relay. Reuses the same 'speaker' IPC
  // channel Copilot's standalone Speaker mode uses; onListeningQuestion/onListeningAnswer
  // above route its events to aiResponseHistory instead of Copilot history based on
  // listenModeRef.current being 'prompter' at the moment each event arrives, regardless of
  // which function started the underlying session.
  async function startAiResponse() {
    const captureRes = await audioCapture.startSpeakerCapture()
    if (!captureRes.success) { setListenError(captureRes.message); return }
    const res = await window.clearpilot.startListening(interview.id, 'speaker')
    if (!res.success) {
      setListenError(res.error)
      audioCapture.stopSpeakerCapture()
    }
  }

  async function stopAiResponse() {
    await window.clearpilot.stopListening('speaker')
    audioCapture.stopSpeakerCapture()
  }

  // Called when the AI Generated Response checkbox changes (see PrompterTab.jsx). Only
  // actually starts/stops the Speaker session while Prompter is running - if it isn't yet,
  // this just remembers the preference for the next time Start Prompter is clicked.
  async function toggleAiResponse(enabled) {
    aiEnabledRef.current = enabled
    setAiEnabledState(enabled)
    if (listenModeRef.current !== 'prompter') return
    if (enabled) await startAiResponse()
    else await stopAiResponse()
  }

  async function stopListening() {
    const mode = listenModeRef.current
    if (mode === 'prompter') {
      await window.clearpilot.stopListening('prompter')
      await stopAiResponse() // no-op if the AI panel wasn't running
    } else if (mode === 'speaker') {
      await window.clearpilot.stopListening('speaker')
      audioCapture.stopSpeakerCapture()
    } else if (mode === 'mic') {
      await window.clearpilot.stopListening('mic')
      audioCapture.stopMicCapture()
    }
    // Save whatever the Prompter session captured (either panel, or both) to the shared
    // History so it can be reviewed later regardless of which side was live - see
    // apps/web/routers/history.py's save_prompter_session. Nothing to save if neither
    // panel ever got any content (e.g. session was started and immediately stopped).
    // Both refs are newest-first (for on-screen display) - reverse back to chronological
    // order here so the saved transcript reads top-to-bottom in the order things were
    // actually said, not most-recent-first. aiResponseHistory now holds every Q&A exchange
    // heard this session, not just the last one, so all of them get saved, not just the
    // final answer.
    if (mode === 'prompter' && (aiResponseHistoryRef.current.length > 0 || partnerTranscriptRef.current.length > 0)) {
      const aiText = [...aiResponseHistoryRef.current]
        .reverse()
        .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
        .join('\n\n')
      window.clearpilot.savePrompterSession(
        interview.id,
        [...partnerTranscriptRef.current].reverse().join('\n\n'),
        aiText
      )
    }
    aiResponseHistoryRef.current = []
    setAiResponseHistory([])
    pendingAiQuestionRef.current = ''
    setPendingAiQuestion('')
    partnerTranscriptRef.current = []
    setPartnerTranscript([])
    listenModeRef.current = 'off'
    setListenMode('off')
    setSpeakerTranscript('')
    setGuestConnected(false)
  }

  useEffect(() => {
    return () => {
      window.clearpilot.stopListening('speaker')
      window.clearpilot.stopListening('mic')
      window.clearpilot.stopListening('prompter')
      audioCapture.stopSpeakerCapture()
      audioCapture.stopMicCapture()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus Mode shrinks the window into a floating widget rather than opening a second
  // BrowserWindow - InterviewWorkspace stays mounted underneath so the audio session above
  // is never interrupted, and onFocusModeChange bubbles the flag up to App.jsx so it can hide
  // the TitleBar/Sidebar, which are siblings of this component, not descendants. Copilot-only
  // now (the Prompter tab has no entry point into it - see PrompterTab.jsx), so there's no
  // longer a "source" to track.
  async function enterFocusMode() {
    onFocusModeChange?.(true)
    await window.clearpilot.enterFocusMode()
  }

  async function exitFocusMode() {
    await window.clearpilot.exitFocusMode()
    onFocusModeChange?.(false)
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
          onFocusMode={enterFocusMode}
        />
      </div>
      <div className={!focusMode && activeTab === 'prompter' ? 'contents' : 'hidden'}>
        <PrompterTab
          listenMode={listenMode}
          listenError={listenError}
          onStartListening={startListening}
          onStopListening={stopListening}
          speakerLevel={audioCapture.speakerLevel}
          speakerDeviceName={audioCapture.speakerDeviceName}
          aiResponseHistory={aiResponseHistory}
          pendingAiQuestion={pendingAiQuestion}
          aiEnabled={aiEnabled}
          onToggleAiResponse={toggleAiResponse}
          partnerTranscript={partnerTranscript}
          guestConnected={guestConnected}
        />
      </div>

      {/* Focus Mode is Copilot-only now - the Prompter tab has no entry point into it (see
          PrompterTab.jsx), so focusSource is always 'copilot' whenever focusMode is true. */}
      {focusMode && (
        <FocusWidget
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
        />
      )}
    </div>
  )
}

/* UPDATES LOG
 * 2026-07-20 - Merged Job Mode ('both') and Practice Partner ('partner') listen modes into
 *   a single 'prompter' mode, and removed the AI judge entirely: jobCurrentRef/jobCurrent/
 *   jobRounds/roundIdRef/pinnedRoundIds/toggleRoundPin/pendingMicFeedbackRef/
 *   finalizeMicRound are all gone, replaced by two independent, judge-free state slots -
 *   aiResponse (Speaker session's question+answer, was jobCurrent.suggestion in 'both' mode)
 *   and partnerTranscript (the web relay, was jobCurrent.suggestion in 'partner' mode) - both
 *   now render simultaneously instead of being mutually exclusive. stopListening saves a
 *   Prompter session to History (see savePrompterSession) instead of finalizeMicRound doing
 *   it per-round. JudgeTab -> PrompterTab, tab key/label 'judge'/'Job Mode' -> 'prompter'/
 *   'Prompter'. Focus Mode is Copilot-only now (removed the Prompter tab's entry point and
 *   the now-dead focusSource state/source param, since there's only ever one source left).
 * 2026-07-20 (later same day) - Fixed two bugs found live: starting Prompter previously
 *   started the Speaker session FIRST and only connected the relay if that succeeded, so a
 *   missing/failing OpenAI key silently broke the Web Prompter Transcription panel too, and
 *   there was no way to actually stop the Speaker session independently of the whole
 *   Prompter session, so disabling the AI panel never stopped listening. Split them fully:
 *   startListening('prompter') now only connects the relay (via IPC source 'prompter', which
 *   the main process no longer bundles with the speaker session - see main/index.js's same-day
 *   entry); the AI panel's own start/stop (startAiResponse/stopAiResponse/toggleAiResponse,
 *   lifted aiEnabled/aiEnabledRef state) independently controls the Speaker session via the
 *   existing 'speaker' IPC channel, whether or not Prompter's relay is connected.
 * 2026-07-20 (later same day) - Fixed partnerTranscript garbling on real multi-utterance
 *   sessions: comparing each arriving relay fragment against the ENTIRE accumulated session
 *   text (a flat string) only correctly merged growing/duplicate revisions of the FIRST
 *   utterance ever - every utterance after that starts fresh and doesn't extend the whole
 *   prior history, so it got appended piecemeal fragment-by-fragment instead of merged in
 *   place, producing a garbled run-on (confirmed live: "tell tell me tell me about SAP as
 *   as well as..."). partnerTranscript is now an array of segments, comparing new arrivals
 *   only against the LAST segment (matching the web Prompter's own appendPrompterLine()
 *   logic) - also lets PrompterTab.jsx render these as separate message cards instead of
 *   one flowing paragraph.
 * 2026-07-22 - Both Prompter panels now behave like Copilot's conversation: newest content
 *   at the top instead of growing downward with no auto-scroll. partnerTranscript's newest
 *   segment moved from the end of the array to index 0 (onPracticeTranscript compares
 *   against segments[0] now, not the last index) so a new relayed line is prepended, not
 *   appended. aiResponse (single {question, answer} slot that a new interviewer question
 *   silently overwrote) is replaced by aiResponseHistory (array, newest first) +
 *   pendingAiQuestion (a heard-but-not-yet-answered question, like Copilot's `streaming`) -
 *   RealtimeSessionManager's onQuestion/onAnswer each fire once per finalized exchange, not
 *   chunked, so onListeningAnswer now prepends the completed {question, answer} pair to
 *   aiResponseHistory instead of overwriting the one slot, meaning every question the
 *   interviewer asks during a session stays visible instead of erasing the last one.
 *   stopListening's savePrompterSession call now reverses both back to chronological order
 *   before saving (History should read top-to-bottom in the order things were said, not
 *   newest-first) and saves every aiResponseHistory exchange, not just the last answer.
 */
