import { useEffect, useState } from 'react'

function formatDateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '—'
}

// Mirrors apps/web/pages/admin.html's loading/denied/content states and table layout so the
// two admin views stay consistent - access itself is enforced server-side by require_admin
// (routers/admin.py), this just reflects whatever that returns rather than gating locally.
export default function AdminScreen() {
  const [status, setStatus] = useState('loading') // loading | denied | error | ready
  const [users, setUsers] = useState([])
  const [entries, setEntries] = useState([])
  const [effortFilter, setEffortFilter] = useState('')

  useEffect(() => {
    ;(async () => {
      const usersRes = await window.clearpilot.getAdminUsers()
      if (!usersRes.success) {
        setStatus(usersRes.error === 'Admin access required' ? 'denied' : 'error')
        return
      }
      setUsers(usersRes.users)

      const historyRes = await window.clearpilot.getAdminHistory()
      if (historyRes.success) setEntries(historyRes.entries)

      setStatus('ready')
    })()
  }, [])

  const filteredEntries = !effortFilter
    ? entries
    : entries.filter((e) => (e.reasoning_effort || 'default') === effortFilter)

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Admin</h1>
        <p className="text-sm text-gray-500 mb-8">Internal - not linked from the public nav on web either.</p>

        {status === 'loading' && <p className="text-sm text-gray-500">Checking access...</p>}
        {status === 'error' && <p className="text-sm text-red-600">Could not load admin data.</p>}
        {status === 'denied' && (
          <p className="text-sm bg-red-50 text-red-700 border border-red-200 rounded-lg px-3 py-2">
            You don&apos;t have admin access on this account.
          </p>
        )}

        {status === 'ready' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-medium">Users</h2>
              <span className="text-sm text-gray-500">{users.length} total</span>
            </div>
            <div className="border border-gray-200 rounded-2xl overflow-x-auto mb-10">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Email</th>
                    <th className="px-4 py-2.5 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-2.5">{u.display_name}</td>
                      <td className="px-4 py-2.5 text-gray-500">{u.email}</td>
                      <td className="px-4 py-2.5 text-gray-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between mb-4">
              <h2 className="font-medium">AI Response Times</h2>
              <span className="text-sm text-gray-500">{filteredEntries.length} shown</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Only covers typed Copilot questions (web + desktop) - both go through the same
              backend endpoint that records timing. Voice-driven answers and Job Mode aren&apos;t
              logged here. "Effort" shows the reasoning_effort used for that run (default = unset)
              - admins/testers can override it per-question to A/B test speed vs. answer quality;
              hover "Words" to preview the actual answer text.
            </p>
            <div className="flex items-center gap-2 mb-4">
              <label className="text-xs text-gray-500">Filter by effort:</label>
              <select
                value={effortFilter}
                onChange={(e) => setEffortFilter(e.target.value)}
                className="field-input text-xs w-auto py-1"
              >
                <option value="">All</option>
                <option value="default">Default (unset)</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
            <div className="border border-gray-200 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">User</th>
                    <th className="px-4 py-2.5 font-medium">Interview</th>
                    <th className="px-4 py-2.5 font-medium">Question</th>
                    <th className="px-4 py-2.5 font-medium">Effort</th>
                    <th className="px-4 py-2.5 font-medium">Words</th>
                    <th className="px-4 py-2.5 font-medium">Asked at</th>
                    <th className="px-4 py-2.5 font-medium">First letter at</th>
                    <th className="px-4 py-2.5 font-medium">Ended at</th>
                    <th className="px-4 py-2.5 font-medium">First chunk</th>
                    <th className="px-4 py-2.5 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredEntries.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2.5">{e.user_display_name}</td>
                      <td className="px-4 py-2.5 text-gray-500 truncate max-w-[140px]">{e.interview_title}</td>
                      <td className="px-4 py-2.5 text-gray-500 truncate max-w-[220px]" title={e.question}>
                        {e.question}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                        {e.reasoning_effort ? (
                          <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full">
                            {e.reasoning_effort}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">default</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap" title={e.answer.slice(0, 800)}>
                        {e.word_count}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatDateTime(e.started_at)}</td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatDateTime(e.first_chunk_at)}</td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatDateTime(e.ended_at)}</td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                        {e.time_to_first_chunk_ms != null ? `${e.time_to_first_chunk_ms}ms` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                        {e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(2)}s` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
