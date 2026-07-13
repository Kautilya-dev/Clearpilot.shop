import { useEffect, useState } from 'react'

const FORMAT_OPTIONS = [
  { value: 'bullets', label: 'Bullets' },
  { value: 'star', label: 'STAR (Situation/Task/Action/Result)' },
  { value: 'concise', label: 'Concise (one-liner)' },
  { value: 'detailed', label: 'Detailed (with examples)' }
]

const LENGTH_OPTIONS = [
  { value: 'short', label: 'Short' },
  { value: 'medium', label: 'Medium' },
  { value: 'one_minute', label: '1 Minute' },
  { value: 'long', label: 'Long' }
]

// Account-level preference (shared with the web app, not a local per-device setting like
// StylingTab/BehaviourTab) - server-backed the same way AccountTab is, via the `user` prop
// lifted from App.jsx rather than window.clearpilot.getSettings()/saveSettings().
export default function AnswerTemplateTab({ user, onProfileUpdated }) {
  const [answerFormatMode, setAnswerFormatMode] = useState(user?.answer_format_mode || 'bullets')
  const [answerLength, setAnswerLength] = useState(user?.answer_length || 'medium')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setAnswerFormatMode(user?.answer_format_mode || 'bullets')
    setAnswerLength(user?.answer_length || 'medium')
  }, [user])

  async function handleSave(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    const res = await window.clearpilot.updatePreferences(answerFormatMode, answerLength)
    setBusy(false)
    if (res.success) {
      setMessage('Saved.')
      onProfileUpdated(res.user)
    } else {
      setError(res.error || 'Could not save')
    }
  }

  return (
    <div className="space-y-8">
      <section className="border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Answer Template</h2>
        <p className="text-xs text-gray-500">
          Shapes every AI-generated interview answer, on the web and in this app (Copilot and Job Mode's suggested
          answer).
        </p>
        <form onSubmit={handleSave} className="space-y-2">
          <label className="block">
            <span className="text-xs text-gray-500">Format</span>
            <select
              value={answerFormatMode}
              onChange={(e) => setAnswerFormatMode(e.target.value)}
              className="field-input mt-1"
            >
              {FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">Length</span>
            <select
              value={answerLength}
              onChange={(e) => setAnswerLength(e.target.value)}
              className="field-input mt-1"
            >
              {LENGTH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {message && <p className="text-xs text-green-600">{message}</p>}
          <button
            type="submit"
            disabled={busy}
            className="text-xs bg-purple-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
          >
            Save
          </button>
        </form>
      </section>
    </div>
  )
}
