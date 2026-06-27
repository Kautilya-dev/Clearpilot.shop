import { useEffect, useRef, useState } from 'react'

const SECTIONS = [
  { type: 'resume', label: 'Resume' },
  { type: 'job_description', label: 'Job Description' },
  { type: 'real_time_scenario', label: 'Real-time Scenarios' }
]

export default function MaterialsTab({ interviewId }) {
  const [materials, setMaterials] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function refresh() {
    setError('')
    const res = await window.clearpilot.listMaterials(interviewId)
    if (res.success) setMaterials(res.materials)
    else setError(res.error || 'Could not load materials')
    setLoading(false)
  }

  useEffect(() => {
    refresh()
  }, [interviewId])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 space-y-8">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {SECTIONS.map((section) => (
        <MaterialSection
          key={section.type}
          interviewId={interviewId}
          type={section.type}
          label={section.label}
          items={materials.filter((m) => m.type === section.type)}
          onChange={refresh}
        />
      ))}
    </div>
  )
}

function MaterialSection({ interviewId, type, label, items, onChange }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sectionError, setSectionError] = useState('')
  const fileInputRef = useRef(null)

  async function handleAddText(e) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setSectionError('')
    const res = await window.clearpilot.createMaterial(interviewId, type, name.trim() || label, text.trim())
    setBusy(false)
    if (res.success) {
      setName('')
      setText('')
      setAdding(false)
      onChange()
    } else {
      setSectionError(res.error || 'Could not save')
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setSectionError('')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const res = await window.clearpilot.uploadMaterial(interviewId, type, file.name, bytes)
    setBusy(false)
    if (res.success) onChange()
    else setSectionError(res.error || 'Upload failed')
  }

  async function handleToggleActive(material) {
    const res = await window.clearpilot.updateMaterial(interviewId, material.id, { active: !material.active })
    if (res.success) onChange()
  }

  async function handleDelete(material) {
    const res = await window.clearpilot.deleteMaterial(interviewId, material.id)
    if (res.success) onChange()
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">{label}</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50"
          >
            Upload file
          </button>
          <button onClick={() => setAdding((a) => !a)} className="text-xs text-purple-600 hover:text-purple-800">
            {adding ? 'Cancel' : 'Add text'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      {sectionError && <p className="text-xs text-red-600 mb-2">{sectionError}</p>}

      {adding && (
        <form onSubmit={handleAddText} className="border border-gray-200 rounded-xl p-3 mb-3 space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className="field-input"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste text..."
            rows={4}
            className="field-input"
          />
          <button
            type="submit"
            disabled={busy}
            className="text-xs bg-purple-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
          >
            Save
          </button>
        </form>
      )}

      {items.length === 0 && !adding && <p className="text-sm text-gray-400">Nothing added yet.</p>}

      <div className="space-y-2">
        {items.map((m) => (
          <div key={m.id} className="border border-gray-200 rounded-xl p-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{m.name}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {m.text.slice(0, 120)}
                {m.text.length > 120 ? '...' : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={m.active} onChange={() => handleToggleActive(m)} />
                Active
              </label>
              <button onClick={() => handleDelete(m)} className="text-xs text-gray-400 hover:text-red-600">
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
