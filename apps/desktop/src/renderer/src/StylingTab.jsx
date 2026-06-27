import { useEffect, useState } from 'react'
import { applyStyles } from './applyStyles'

const DEFAULTS = {
  overallBg: '#ffffff',
  questionBg: '#7c3aed',
  questionFont: '#ffffff',
  questionFontSize: 14,
  answerBg: '#f9fafb',
  answerFont: '#111827',
  answerFontSize: 14
}

function ColorField({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-10 h-7 rounded border border-gray-200 cursor-pointer"
      />
    </label>
  )
}

function SizeField({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={12}
          max={32}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-32"
        />
        <span className="text-xs text-gray-400 w-8">{value}px</span>
      </div>
    </label>
  )
}

export default function StylingTab() {
  const [styles, setStyles] = useState(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  useEffect(() => {
    window.clearpilot.getSettings().then((res) => {
      if (res.success) setStyles(res.settings.styles)
      setLoading(false)
    })
  }, [])

  function update(key, value) {
    setStyles((s) => ({ ...s, [key]: value }))
    setMessage('')
  }

  async function handleSave() {
    const res = await window.clearpilot.saveSettings({ styles })
    if (res.success) {
      applyStyles(res.settings.styles)
      setMessage('Saved.')
    }
  }

  async function handleReset() {
    setStyles(DEFAULTS)
    const res = await window.clearpilot.saveSettings({ styles: DEFAULTS })
    if (res.success) {
      applyStyles(res.settings.styles)
      setMessage('Reset to defaults.')
    }
  }

  if (loading) return <p className="text-sm text-gray-400">Loading...</p>

  return (
    <div className="space-y-6">
      <section className="border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Overall</h2>
        <ColorField label="Background color" value={styles.overallBg} onChange={(v) => update('overallBg', v)} />
      </section>

      <section className="border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Question</h2>
        <ColorField label="Background color" value={styles.questionBg} onChange={(v) => update('questionBg', v)} />
        <ColorField label="Font color" value={styles.questionFont} onChange={(v) => update('questionFont', v)} />
        <SizeField
          label="Font size"
          value={styles.questionFontSize}
          onChange={(v) => update('questionFontSize', v)}
        />
      </section>

      <section className="border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Answer</h2>
        <ColorField label="Background color" value={styles.answerBg} onChange={(v) => update('answerBg', v)} />
        <ColorField label="Font color" value={styles.answerFont} onChange={(v) => update('answerFont', v)} />
        <SizeField label="Font size" value={styles.answerFontSize} onChange={(v) => update('answerFontSize', v)} />
      </section>

      <section className="border border-gray-200 rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">Preview</h2>
        <div className="rounded-2xl rounded-br-md px-4 py-2.5 inline-block max-w-full" style={{ backgroundColor: styles.questionBg, color: styles.questionFont, fontSize: `${styles.questionFontSize}px` }}>
          Sample question text
        </div>
        <div
          className="rounded-2xl rounded-bl-md px-4 py-3 border border-gray-100"
          style={{ backgroundColor: styles.answerBg, color: styles.answerFont, fontSize: `${styles.answerFontSize}px` }}
        >
          Sample answer text
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} className="text-xs bg-purple-600 text-white rounded-lg px-3 py-1.5">
          Save
        </button>
        <button onClick={handleReset} className="text-xs text-gray-500 hover:text-gray-700">
          Reset to defaults
        </button>
        {message && <p className="text-xs text-green-600">{message}</p>}
      </div>
    </div>
  )
}
