const WebSocket = require('ws')

// Stripped-down port of HireGhost's src/modules/openaiRealtimeManager.js: this module's
// only job is "open a Realtime session, stream audio in, emit completed transcripts out."
// Unlike HireGhost's original (which doubled as a local answer-cascade + AI fallback for
// its own offline KB/BM25/cache system), ClearPilot already has its own better-architected
// equivalent server-side (qa_match_service.py + qa_judge_service.py via /chat/ask) - a
// transcribed question is just fed into that existing pipeline by the caller, so every
// answer-generation/local-matching concern from the original is intentionally dropped here.
const REALTIME_MODEL = 'gpt-4o-realtime-preview'
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`

class RealtimeSessionManager {
  constructor(clientSecret) {
    this.clientSecret = clientSecret
    this.ws = null
    this.isConnected = false
    this.pendingTranscript = ''
    this.onTranscript = null
    this.onError = null
  }

  setTranscriptCallback(callback) {
    this.onTranscript = callback
  }

  setErrorCallback(callback) {
    this.onError = callback
  }

  _openSocket() {
    return new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${this.clientSecret}`
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
        try {
          ws.close()
        } catch {
          // already closed
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      ws.on('open', () => {
        // input_audio_transcription must be explicitly enabled or .completed events never fire.
        // input_audio_format 'pcm16' = s16le at 24kHz (the only rate the Realtime API accepts).
        // modalities replaces the incorrect 'output_modalities' field name.
        // model/type do not belong in session.update - the model is already in the WebSocket URL.
        const sessionUpdate = {
          type: 'session.update',
          session: {
            instructions,
            modalities: ['text'],
            input_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            // Server VAD detects speech turns automatically — without this, the API
            // never fires conversation.item.input_audio_transcription.completed.
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800
            }
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

        if (!settled && (message.type === 'session.updated' || message.type === 'session.created')) {
          settled = true
          this.ws = ws
          this.isConnected = true
          console.log('OpenAI Realtime session ready')
          resolve()
        }

        if (message.type === 'error') {
          console.error('OpenAI Realtime session error:', message.error || message)
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
        console.log('OpenAI Realtime session closed:', reason?.toString() || code || 'unknown')
        const wasConnected = this.isConnected
        this.isConnected = false
        this.ws = null
        if (!settled) {
          fail(new Error(`Socket closed before session ready (code ${code})`))
        } else if (wasConnected && this.onError) {
          this.onError({ message: `Realtime session disconnected (code ${code})` })
        }
      })

      // Some accounts/regions may not emit session.updated explicitly - treat the socket
      // as ready shortly after open if no error arrived, matching HireGhost's fallback.
      setTimeout(() => {
        if (!settled) {
          settled = true
          this.ws = ws
          this.isConnected = true
          resolve()
        }
      }, 2000)
    })
  }

  _handleMessage(message) {
    switch (message.type) {
      case 'conversation.item.input_audio_transcription.delta':
        this.pendingTranscript += message.delta || ''
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (message.transcript || this.pendingTranscript).trim()
        this.pendingTranscript = ''
        if (text) this.onTranscript?.(text)
        break
      }
      default:
        // input_audio_buffer.speech_started/.speech_stopped and other VAD/lifecycle events
        // are informational only - .completed already only fires once a turn is finalized,
        // so no separate VAD wiring is needed to detect "the speaker/user finished talking."
        break
    }
  }

  sendAudioChunk(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !buffer?.length) {
      return { success: false, message: 'No active OpenAI Realtime session' }
    }
    try {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buffer.toString('base64') }))
      return { success: true }
    } catch (error) {
      console.error('Error sending audio chunk:', error)
      return { success: false, message: error.message }
    }
  }

  disconnect() {
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
    this.ws = null
    this.isConnected = false
  }
}

module.exports = RealtimeSessionManager
