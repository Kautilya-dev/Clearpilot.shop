import { useEffect, useState } from 'react'
import InterviewCard from './InterviewCard'

// Turns ["Python", "React"] into "Python & React Interview", ["Python"] into "Python Interview",
// and 3+ into "Python, React & Graphic Designing Interview".
function generateInterviewTitle(subjectNames) {
  if (subjectNames.length === 0) return ''
  if (subjectNames.length === 1) return `${subjectNames[0]} Interview`
  const last = subjectNames[subjectNames.length - 1]
  const rest = subjectNames.slice(0, -1)
  return `${rest.join(', ')} & ${last} Interview`
}

export default function PickerScreen({ onSelectInterview }) {
  const [interviews, setInterviews] = useState([])
  const [interviewsError, setInterviewsError] = useState('')
  const [subjects, setSubjects] = useState([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  // True once the user has typed their own text - auto-fill from selected subjects stops
  // touching the field after that, and resumes if they clear it back to empty.
  const [titleTouched, setTitleTouched] = useState(false)
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

  // Keeps the title in sync with the current subject selection until the user types their
  // own text (titleTouched) - stays in sync, not just a one-time fill, so changing subjects
  // before writing anything updates the suggestion each time.
  useEffect(() => {
    if (titleTouched) return
    const names = subjects.filter((s) => selectedSubjectIds.includes(s.id)).map((s) => s.name)
    setTitle(generateInterviewTitle(names))
  }, [selectedSubjectIds, subjects, titleTouched])

  function handleTitleChange(value) {
    setTitle(value)
    setTitleTouched(value.trim().length > 0)
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
      setTitleTouched(false)
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
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="e.g. SAP CPI - Acme Corp"
              className="field-input"
              list="subject-name-suggestions"
            />
            {/* Native browser typeahead - suggests subject names as the user types, no custom
                dropdown widget needed. */}
            <datalist id="subject-name-suggestions">
              {subjects.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
            <div className="grid grid-cols-3 gap-2">
              {/* All subjects are selectable, including ones with no ingested grounding corpus
                  yet (status !== 'available') - those just get a caution instead of being
                  blocked, since answers for them still work fine (general model knowledge +
                  this interview's own materials/Q&A), they just aren't grounded in a shared
                  document corpus like sap-integration-suite is. */}
              {subjects.map((s) => {
                const needsMaterials = s.status !== 'available'
                const selected = selectedSubjectIds.includes(s.id)
                return (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => toggleSubject(s.id)}
                    className={`text-xs border rounded-lg px-2 py-2 text-left ${
                      selected
                        ? needsMaterials
                          ? 'border-amber-400 bg-amber-50 text-amber-800'
                          : 'border-purple-500 bg-purple-50 text-purple-700'
                        : 'border-gray-200 hover:border-purple-300'
                    }`}
                  >
                    {s.name}
                    {needsMaterials && <span className="block text-amber-500">⚠ No materials</span>}
                  </button>
                )
              })}
            </div>
            {selectedSubjectIds.some((id) => subjects.find((s) => s.id === id)?.status !== 'available') && (
              <p className="text-xs text-amber-600">
                No context available based on your materials for:{' '}
                {subjects
                  .filter((s) => selectedSubjectIds.includes(s.id) && s.status !== 'available')
                  .map((s) => s.name)
                  .join(', ')}
                . Answers will rely on general knowledge and this interview's own materials and Q&amp;A.
              </p>
            )}
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
