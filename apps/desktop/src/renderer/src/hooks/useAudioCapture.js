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
  const [speakerDeviceName, setSpeakerDeviceName] = useState(null)
  const [micCapturing, setMicCapturing] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [micDeviceName, setMicDeviceName] = useState(null)
  const [error, setError] = useState(null)

  const speakerRef = useRef(makeStreamState())
  const micRef = useRef(makeStreamState())

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

      // WASAPI loopback track label is always a generic string. Enumerate audiooutput
      // devices to get the real name shown in Windows Sound settings instead.
      let deviceName = stream.getAudioTracks()[0]?.label || 'System Audio'
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        // Windows enumerates: "Default - Speakers (...)", "Communications - Speakers (...)", "Speakers (...)"
        // The bare entry without a role prefix is the actual device name.
        const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.label)
        const bare = outputs.find((d) => !d.label.startsWith('Default') && !d.label.startsWith('Communications'))
        if (bare) deviceName = bare.label
      } catch {
        // enumerateDevices failed — keep the track label fallback
      }
      setSpeakerDeviceName(deviceName)
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
    setSpeakerDeviceName(null)
  }, [])

  const startMicCapture = useCallback(async () => {
    if (micRef.current.stream) return { success: true }
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
      const processor = buildProcessor(stream, audioContext, setMicLevel, (base64) =>
        window.clearpilot.sendAudioChunk('mic', base64)
      )
      micRef.current = { stream, audioContext, processor }
      stream.getTracks().forEach((t) => t.addEventListener('ended', () => stopMicCapture()))
      const deviceName = stream.getAudioTracks()[0]?.label || 'Microphone'
      setMicDeviceName(deviceName)
      setMicCapturing(true)
      return { success: true }
    } catch (e) {
      setError(e.message)
      return { success: false, message: e.message }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopMicCapture = useCallback(() => {
    teardownStream(micRef)
    setMicCapturing(false)
    setMicLevel(0)
    setMicDeviceName(null)
  }, [])

  useEffect(() => {
    return () => {
      teardownStream(speakerRef)
      teardownStream(micRef)
    }
  }, [])

  return {
    speakerCapturing,
    speakerLevel,
    speakerDeviceName,
    micCapturing,
    micLevel,
    micDeviceName,
    error,
    startSpeakerCapture,
    stopSpeakerCapture,
    startMicCapture,
    stopMicCapture
  }
}
