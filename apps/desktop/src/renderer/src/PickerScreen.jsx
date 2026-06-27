import { useEffect, useState } from 'react'
import InterviewCard from './InterviewCard'

export default function PickerScreen({ onSelectInterview }) {
  const [interviews, setInterviews] = useState([])
  const [interviewsError, setInterviewsError] = useState('')
  const [subjects, setSubjects] = useState([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [selectedSubjectIds, setSelectedSubjectIds] = useState([])
  const [createError, setCreateError] = useState('')
  const [busy, setBusy] = useState(false)

  async function refreshInterviews() {
    setInterviewsError('')
    const res = await window.clearpilot.listInterviews()
    if (res.success) setInterviews(res.interviews)
    else setInterviewsError(res.error || 'Could not load interviews')
  }

  useEffect(() => {
    refreshInterviews()
    window.clearpilot.listSubjects().then((res) => {
      if (res.success) setSubjects(res.subjects)
    })
  }, [])

  function toggleSubject(id) {
    setSelectedSubjectIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!title.trim() || selectedSubjectIds.length === 0) {
      setCreateError('Title and at least one subject are required.')
      return
    }
    setBusy(true)
    setCreateError('')
    const res = await window.clearpilot.createInterview(title.trim(), selectedSubjectIds)
    setBusy(false)
    if (res.success) {
      setTitle('')
      setSelectedSubjectIds([])
      setCreating(false)
      refreshInterviews()
    } else {
      setCreateError(res.error || 'Could not create interview')
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-semibold tracking-tight">My Interviews</h1>
          <button
            onClick={() => setCreating((c) => !c)}
            className="text-sm bg-purple-600 text-white rounded-lg px-3 py-1.5"
          >
            {creating ? 'Cancel' : 'New interview'}
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-6">Pick an interview to continue in Copilot.</p>

        {creating && (
          <form onSubmit={handleCreate} className="border border-gray-200 rounded-xl p-4 mb-6 space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. SAP CPI - Acme Corp"
              className="field-input"
            />
            <div className="grid grid-cols-3 gap-2">
              {subjects.map((s) => {
                const disabled = s.status !== 'available'
                const selected = selectedSubjectIds.includes(s.id)
                return (
                  <button
                    type="button"
                    key={s.id}
                    disabled={disabled}
                    onClick={() => toggleSubject(s.id)}
                    className={`text-xs border rounded-lg px-2 py-2 text-left ${
                      disabled
                        ? 'opacity-50 cursor-not-allowed border-gray-200'
                        : selected
                          ? 'border-purple-500 bg-purple-50 text-purple-700'
                          : 'border-gray-200 hover:border-purple-300'
                    }`}
                  >
                    {s.name}
                    {disabled && <span className="block text-gray-400">Coming soon</span>}
                  </button>
                )
              })}
            </div>
            {createError && <p className="text-xs text-red-600">{createError}</p>}
            <button
              type="submit"
              disabled={busy}
              className="text-sm bg-purple-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
            >
              Create interview
            </button>
          </form>
        )}

        <div className="space-y-3">
          {interviewsError && <p className="text-sm text-red-600">{interviewsError}</p>}
          {!interviewsError && interviews.length === 0 && (
            <p className="text-sm text-gray-500">No interviews yet - create one above.</p>
          )}
          {interviews.map((interview) => (
            <InterviewCard key={interview.id} interview={interview} onClick={() => onSelectInterview(interview)} />
          ))}
        </div>
      </div>
    </main>
  )
}
