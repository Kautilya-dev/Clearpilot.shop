import { useState, useRef, useCallback, useEffect } from 'react'

const SAMPLE_RATE = 24000
const BUFFER_SIZE = 4096
const CHUNK_DURATION = 0.1 // seconds -> 2400 samples per chunk, matching the Realtime API's expected cadence

function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16Array
}

function arrayBufferToBase64(buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function makeStreamState() {
  return { stream: null, audioContext: null, processor: null }
}

function teardownStream(ref) {
  const s = ref.current
  try {
    s.processor?.disconnect()
  } catch {
    // already disconnected
  }
  try {
    s.audioContext?.close()
  } catch {
    // already closed
  }
  s.stream?.getTracks().forEach((t) => t.stop())
  ref.current = makeStreamState()
}

// Web Audio's ScriptProcessorNode is deprecated in favor of AudioWorkletNode, but this is
// a direct, proven port from HireGhost's working speaker-capture pipeline - modernizing it
// is a separate future cleanup, not a blocker here.
function buildProcessor(stream, audioContext, setLevel, onChunk) {
  const source = audioContext.createMediaStreamSource(stream)
  const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1)
  const samplesPerChunk = SAMPLE_RATE * CHUNK_DURATION
  const buffer = []

  processor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0)

    let sum = 0
    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i]
    setLevel(Math.min(100, Math.round(Math.sqrt(sum / inputData.length) * 400)))

    for (let i = 0; i < inputData.length; i++) buffer.push(inputData[i])
    while (buffer.length >= samplesPerChunk) {
      const chunk = buffer.splice(0, samplesPerChunk)
      const pcmData = float32ToInt16(new Float32Array(chunk))
      onChunk(arrayBufferToBase64(pcmData.buffer))
    }
  }

  source.connect(processor)
  processor.connect(audioContext.destination)
  return processor
}

export function useAudioCapture() {
  const [speakerCapturing, setSpeakerCapturing] = useState(false)
  const [speakerLevel, setSpeakerLevel] = useState(0)
  const [error, setError] = useState(null)

  const speakerRef = useRef(makeStreamState())

  // getDisplayMedia always requires a video constraint even when only audio is wanted -
  // the 1x1/1fps track is a deliberately negligible throwaway, not a real video feed.
  const startSpeakerCapture = useCallback(async () => {
    if (speakerRef.current.stream) return { success: true }
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: { ideal: 1 }, height: { ideal: 1 } },
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
      const processor = buildProcessor(stream, audioContext, setSpeakerLevel, (base64) =>
        window.clearpilot.sendAudioChunk('speaker', base64)
      )
      speakerRef.current = { stream, audioContext, processor }
      stream.getTracks().forEach((t) => t.addEventListener('ended', () => stopSpeakerCapture()))
      setSpeakerCapturing(true)
      return { success: true }
    } catch (e) {
      setError(e.message)
      return { success: false, message: e.message }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopSpeakerCapture = useCallback(() => {
    teardownStream(speakerRef)
    setSpeakerCapturing(false)
    setSpeakerLevel(0)
  }, [])

  useEffect(() => {
    return () => teardownStream(speakerRef)
  }, [])

  return {
    speakerCapturing,
    speakerLevel,
    error,
    startSpeakerCapture,
    stopSpeakerCapture
  }
}
