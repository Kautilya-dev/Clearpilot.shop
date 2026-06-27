import { useEffect, useRef, useState } from 'react'

export default function QATab({ interviewId }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const fileInputRef = useRef(null)

  async function refresh(searchValue) {
    setError('')
    const res = await window.clearpilot.listQa(interviewId, searchValue ? { search: searchValue } : {})
    if (res.success) setEntries(res.entries)
    else setError(res.error || 'Could not load Q&A')
    setLoading(false)
  }

  // Instant on mount/clear, debounced while actively typing a search - same 300ms the web
  // app uses, just skipped when there's nothing to debounce.
  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => refresh(search), search ? 300 : 0)
    return () => clearTimeout(timer)
  }, [interviewId, search])

  async function handleAdd(e) {
    e.preventDefault()
    if (!question.trim() || !answer.trim()) return
    setBusy(true)
    setError('')
    const res = await window.clearpilot.createQa(interviewId, question.trim(), answer.trim())
    setBusy(false)
    if (res.success) {
      setQuestion('')
      setAnswer('')
      setAdding(false)
      refresh(search)
    } else {
      setError(res.error || 'Could not save')
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    setUploadMessage('')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const res = await window.clearpilot.uploadQa(interviewId, file.name, bytes)
    setBusy(false)
    if (res.success) {
      setUploadMessage(`Added ${res.entries.length} Q&A pair${res.entries.length === 1 ? '' : 's'}.`)
      refresh(search)
    } else {
      setError(res.error || 'Upload failed')
    }
  }

  async function handleDelete(entry) {
    const res = await window.clearpilot.deleteQa(interviewId, entry.id)
    if (res.success) refresh(search)
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
      <p className="text-xs text-gray-400">Category and tags are generated automatically by AI.</p>

      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search questions..."
          className="field-input flex-1"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50 whitespace-nowrap"
        >
          Upload file
        </button>
        <button onClick={() => setAdding((a) => !a)} className="text-xs text-purple-600 hover:text-purple-800 whitespace-nowrap">
          {adding ? 'Cancel' : 'Add Q&A'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {uploadMessage && <p className="text-xs text-green-600">{uploadMessage}</p>}

      {adding && (
        <form onSubmit={handleAdd} className="border border-gray-200 rounded-xl p-3 space-y-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Question"
            className="field-input"
          />
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Answer"
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

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-400">No Q&A entries yet.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <div key={e.id} className="border border-gray-200 rounded-xl p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{e.question}</p>
                  <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{e.answer}</p>
                </div>
                <button onClick={() => handleDelete(e)} className="text-xs text-gray-400 hover:text-red-600 shrink-0">
                  Delete
                </button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mt-2">
                {e.category && (
                  <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">{e.category}</span>
                )}
                {e.tags &&
                  e.tags
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .map((t) => (
                      <span key={t} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {t}
                      </span>
                    ))}
                {e.use_count > 0 && <span className="text-xs text-gray-400">used {e.use_count}x</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
