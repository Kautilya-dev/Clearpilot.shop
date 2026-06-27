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
    this.onAnswer = null    // GPT's text response → goes to answer area
    this.onQuestion = null  // input audio transcript → goes to question area
    this.onError = null
  }

  // GPT's generated answer text
  setAnswerCallback(callback) {
    this.onAnswer = callback
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
