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
              <span className="text-sm text-gray-500">{entries.length} shown</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Only covers typed Copilot questions (web + desktop) - both go through the same
              backend endpoint that records timing. Voice-driven answers and Job Mode aren&apos;t
              logged here.
            </p>
            <div className="border border-gray-200 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">User</th>
                    <th className="px-4 py-2.5 font-medium">Interview</th>
                    <th className="px-4 py-2.5 font-medium">Question</th>
                    <th className="px-4 py-2.5 font-medium">Asked at</th>
                    <th className="px-4 py-2.5 font-medium">First letter at</th>
                    <th className="px-4 py-2.5 font-medium">Ended at</th>
                    <th className="px-4 py-2.5 font-medium">First chunk</th>
                    <th className="px-4 py-2.5 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2.5">{e.user_display_name}</td>
                      <td className="px-4 py-2.5 text-gray-500 truncate max-w-[140px]">{e.interview_title}</td>
                      <td className="px-4 py-2.5 text-gray-500 truncate max-w-[220px]" title={e.question}>
                        {e.question}
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
