import { useEffect, useState } from 'react'
import InterviewCard from './InterviewCard'

const FILTERS = ['all', 'active', 'completed', 'archived']

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function bucketLabel(isoString) {
  const itemDay = startOfDay(new Date(isoString))
  const diffDays = Math.round((startOfDay(new Date()) - itemDay) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return itemDay.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

// Interviews already arrive newest-first from the API, so grouping in encounter order
// keeps Today first, then Yesterday, then descending calendar dates - no re-sort needed.
function groupByDate(interviews) {
  const groups = []
  for (const interview of interviews) {
    const label = bucketLabel(interview.created_at)
    let group = groups.find((g) => g.label === label)
    if (!group) {
      group = { label, items: [] }
      groups.push(group)
    }
    group.items.push(interview)
  }
  return groups
}

export default function HistoryScreen({ onSelectInterview }) {
  const [interviews, setInterviews] = useState([])
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setError('')
    const res = await window.clearpilot.listInterviews()
    if (res.success) setInterviews(res.interviews)
    else setError(res.error || 'Could not load interviews')
    setLoading(false)
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleDelete(interview) {
    if (!window.confirm(`Delete "${interview.title}"? This permanently removes its materials, Q&A, and history.`)) {
      return
    }
    const res = await window.clearpilot.deleteInterview(interview.id)
    if (res.success) refresh()
    else setError(res.error || 'Could not delete interview')
  }

  const filtered = filter === 'all' ? interviews : interviews.filter((i) => i.state === filter)
  const groups = groupByDate(filtered)

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-semibold tracking-tight mb-1">History</h1>
        <p className="text-sm text-gray-500 mb-6">
          Every interview you&apos;ve started. Click one to pick up exactly where you left off.
        </p>

        <div className="flex gap-1 mb-5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-lg capitalize ${
                filter === f ? 'bg-purple-50 text-purple-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        {!loading && filtered.length === 0 && <p className="text-sm text-gray-500">Nothing here yet.</p>}
        {groups.map((group) => (
          <div key={group.label} className="mb-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{group.label}</h2>
            <div className="space-y-3">
              {group.items.map((interview) => (
                <InterviewCard
                  key={interview.id}
                  interview={interview}
                  onClick={() => onSelectInterview(interview)}
                  onDelete={() => handleDelete(interview)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
