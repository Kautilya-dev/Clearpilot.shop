/* ABOUT THIS FILE
Wraps a single OpenAI Realtime API WebSocket session (gpt-realtime-2): sends captured audio
chunks in, listens for input-audio transcription (the question) and generated text response
(the answer) coming back, and surfaces both through callbacks. One instance per active
Speaker or Mic session - main/index.js's startSingleSession() creates it, wires the three
callbacks below to IPC events the renderer listens for, and calls sendAudioChunk()/disconnect()
as audio arrives / the session ends. Used by both Copilot's standalone Speaker/Mic modes and
the Prompter tab's AI Generated Response panel (InterviewWorkspace.jsx routes events to one
display or the other based on which mode is active when they arrive - this class itself has
no notion of "Copilot" vs "Prompter", it just reports what it heard/generated).
*/
const WebSocket = require('ws')

// gpt-realtime-2: hears audio, understands it, responds in text.
// This eliminates the transcribe-then-ask two-step — the model does both in one shot.
const REALTIME_MODEL = 'gpt-realtime-2'
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`

class RealtimeSessionManager {
  constructor(apiKey) {
    this.apiKey = apiKey
    this.ws = null
    this.isConnected = false
    this.pendingText = ''
    this.pendingQuestion = ''
    this.onAnswer = null      // GPT's full text response, once done → goes to answer area
    this.onAnswerChunk = null // GPT's answer so far, as it's still generating → live streaming display
    this.onQuestion = null    // input audio transcript → goes to question area
    this.onError = null
  }

  // GPT's generated answer text - fires once, when the response is fully done
  setAnswerCallback(callback) {
    this.onAnswer = callback
  }

  // GPT's answer text as it streams in - fires repeatedly with the full text accumulated
  // SO FAR (not just the new delta), so the caller never needs its own accumulation logic -
  // this class is the single source of truth for that (see the Web Prompter Transcription
  // duplication bug this session's earlier fix was about, for why that distinction matters).
  setAnswerChunkCallback(callback) {
    this.onAnswerChunk = callback
  }

  // What was heard (input audio transcription)
  setQuestionCallback(callback) {
    this.onQuestion = callback
  }

  setErrorCallback(callback) {
    this.onError = callback
  }

  _openSocket() {
    return new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    })
  }

  connect(instructions) {
    return new Promise((resolve, reject) => {
      const ws = this._openSocket()
      let settled = false

      const fail = (err) => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* already closed */ }
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      ws.on('open', () => {
        // GA format per docs:
        // - session.type = "realtime" for voice-agent sessions
        // - output_modalities = ["text"] so GPT answers in text, not speech
        // - audio.input.format specifies PCM16 at 24kHz
        // - audio.input.turn_detection = semantic_vad (GA replacement for server_vad)
        const sessionUpdate = {
          type: 'session.update',
          session: {
            type: 'realtime',
            model: REALTIME_MODEL,
            output_modalities: ['text'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                // Transcribe the input audio so we can show the question text in the UI
                transcription: { model: 'gpt-realtime-whisper' },
                turn_detection: { type: 'semantic_vad' }
              }
            },
            instructions
          }
        }
        try {
          ws.send(JSON.stringify(sessionUpdate))
        } catch (err) {
          fail(err)
        }
      })

      ws.on('message', (raw) => {
        let message
        try {
          message = JSON.parse(raw.toString())
        } catch {
          return
        }

        console.log('[Realtime]', message.type)

        if (!settled && (message.type === 'session.updated' || message.type === 'session.created')) {
          settled = true
          this.ws = ws
          this.isConnected = true
          console.log('OpenAI Realtime session ready (gpt-realtime-2)')
          resolve()
        }

        if (message.type === 'error') {
          console.error('OpenAI Realtime error:', JSON.stringify(message.error || message))
          if (!settled) fail(new Error(message.error?.message || 'Realtime session error'))
          return
        }

        this._handleMessage(message)
      })

      ws.on('error', (err) => {
        console.error('OpenAI Realtime socket error:', err.message)
        fail(err)
      })

      ws.on('close', (code, reason) => {
        const detail = reason?.toString() || String(code) || 'unknown'
        console.log('OpenAI Realtime session closed:', detail)
        const wasConnected = this.isConnected
        this.isConnected = false
        this.ws = null
        if (!settled) {
          fail(new Error(`Socket closed before session ready (code ${code})`))
        } else if (wasConnected && this.onError) {
          this.onError({ message: `Realtime session disconnected (code ${code})` })
        }
      })

      // Fallback: if session.created/updated never arrives but no error either,
      // treat as ready after 3s so audio can still flow.
      setTimeout(() => {
        if (!settled) {
          settled = true
          this.ws = ws
          this.isConnected = true
          console.log('OpenAI Realtime session assumed ready (timeout fallback)')
          resolve()
        }
      }, 3000)
    })
  }

  _handleMessage(message) {
    switch (message.type) {
      // Input audio transcript (what was heard) — show in question area
      case 'conversation.item.input_audio_transcription.delta':
        this.pendingQuestion += message.delta || message.transcript || ''
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const q = (message.transcript || this.pendingQuestion).trim()
        this.pendingQuestion = ''
        if (q) this.onQuestion?.(q)
        break
      }

      // GPT's answer — stream partial text for responsiveness
      case 'response.output_text.delta':
        this.pendingText += message.delta || ''
        this.onAnswerChunk?.(this.pendingText)
        break

      // GPT's answer fully done — emit to answer area
      case 'response.output_text.done': {
        const text = (message.text || this.pendingText).trim()
        this.pendingText = ''
        if (text) this.onAnswer?.(text)
        break
      }

      // Safety net: extract from response.done if output_text.done never fired
      case 'response.done': {
        if (this.pendingText) {
          const text = this.pendingText.trim()
          this.pendingText = ''
          if (text) this.onAnswer?.(text)
          break
        }
        const outputs = message.response?.output || []
        for (const item of outputs) {
          for (const part of item.content || []) {
            if (part.type === 'text' && part.text?.trim()) {
              this.onAnswer?.(part.text.trim())
            }
          }
        }
        break
      }

      default:
        break
    }
  }

  // Dynamically update session instructions mid-session (e.g. inject latest suggestion into judge prompt).
  updateInstructions(instructions) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({ type: 'session.update', session: { instructions } }))
    } catch (err) {
      console.error('Failed to update instructions:', err)
    }
  }

  sendAudioChunk(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !buffer?.length) {
      return { success: false, message: 'No active OpenAI Realtime session' }
    }
    try {
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: buffer.toString('base64')
      }))
      return { success: true }
    } catch (error) {
      console.error('Error sending audio chunk:', error)
      return { success: false, message: error.message }
    }
  }

  disconnect() {
    try { this.ws?.close() } catch { /* already closed */ }
    this.ws = null
    this.isConnected = false
  }
}

module.exports = RealtimeSessionManager

// UPDATES LOG
// 2026-07-22 - Added onAnswerChunk/setAnswerChunkCallback: response.output_text.delta was
//   already being accumulated into this.pendingText, but nothing was ever done with it until
//   the full answer was done - the Prompter tab's AI Generated Response panel just showed a
//   static "Generating a suggested answer…" placeholder with no visible progress the entire
//   time GPT was responding. Now onAnswerChunk fires on every delta with the full text
//   accumulated so far (not just the new fragment), so main/index.js can relay it over IPC
//   and InterviewWorkspace.jsx can render it live - see main/index.js and
//   InterviewWorkspace.jsx's same-day entries.
