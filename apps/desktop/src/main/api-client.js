// All HTTP calls to the ClearPilot web backend live here, in the main process - never in
// the renderer - so the bearer token never has to be readable by renderer JS. See
// src/main/auth-store.js for where the token itself is cached/persisted.

const BASE_URL = process.env.CLEARPILOT_API_BASE_URL || 'https://clearpilot.shop'

async function parseErrorDetail(res) {
  try {
    const data = await res.json()
    return data.detail || `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

// Exchanges the one-time code from the local callback server (minted by the browser right
// after a normal password login at /login?desktop=1) for a real JWT.
async function desktopExchange(code) {
  const res = await fetch(`${BASE_URL}/api/auth/desktop-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json() // { access_token, token_type }
}

async function getCurrentUser(token) {
  const res = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json() // { id, email, display_name }
}

async function listInterviews(token) {
  const res = await fetch(`${BASE_URL}/api/interviews`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function listSubjects(token) {
  const res = await fetch(`${BASE_URL}/api/subjects`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function createInterview(token, title, subjectIds) {
  const res = await fetch(`${BASE_URL}/api/interviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, subject_ids: subjectIds })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function updateInterview(token, interviewId, updates) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(updates)
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function deleteInterview(token, interviewId) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

async function getHistory(token, interviewId, limit) {
  const qs = limit ? `?limit=${limit}` : ''
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/history${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function deleteHistoryEntry(token, interviewId, entryId) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/history/${entryId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

async function clearHistory(token, interviewId) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/history`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

async function updateProfile(token, displayName) {
  const res = await fetch(`${BASE_URL}/api/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ display_name: displayName })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function updatePreferences(token, answerFormatMode, answerLength) {
  const res = await fetch(`${BASE_URL}/api/auth/me/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ answer_format_mode: answerFormatMode, answer_length: answerLength })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function changePassword(token, currentPassword, newPassword) {
  const res = await fetch(`${BASE_URL}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

async function deleteAccount(token) {
  const res = await fetch(`${BASE_URL}/api/auth/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

async function listMaterials(token, interviewId) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/materials`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function createMaterial(token, interviewId, type, name, text) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/materials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type, name, text })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function updateMaterial(token, interviewId, materialId, updates) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/materials/${materialId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(updates)
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function deleteMaterial(token, interviewId, materialId) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/materials/${materialId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

// fileBuffer is a Buffer reconstructed (in main/index.js) from bytes the renderer read via
// File.arrayBuffer() and sent over IPC - file content never needs to touch the renderer's
// network stack, matching the "auth/HTTP only happens in main" rule at the top of this file.
async function uploadMaterial(token, interviewId, type, fileName, fileBuffer) {
  const form = new FormData()
  form.append('type', type)
  form.append('file', new Blob([fileBuffer]), fileName)
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/materials/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function listQa(token, interviewId, { category, search } = {}) {
  const params = new URLSearchParams()
  if (category) params.set('category', category)
  if (search) params.set('search', search)
  const qs = params.toString()
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/qa${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function createQa(token, interviewId, question, answer) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question, answer })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function uploadQa(token, interviewId, fileName, fileBuffer) {
  const form = new FormData()
  form.append('file', new Blob([fileBuffer]), fileName)
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/qa/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function updateQa(token, interviewId, entryId, updates) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/qa/${entryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(updates)
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json()
}

async function deleteQa(token, interviewId, entryId) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/qa/${entryId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
}

async function mintRealtimeToken(token, interviewId, source) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/realtime-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ source })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))
  return res.json() // { client_secret, expires_at, model }
}

// Streams an answer from /chat/ask, calling onEvent(parsedEvent) once per SSE frame
// ({type:"start"|"chunk"|"error"|"done", ...}) as it arrives. Ported from the exact
// buffering/parsing algorithm in apps/web/pages/interview.html's submitQuestion() - fetch
// + getReader() + a manual indexOf('\n\n') loop, since EventSource can't do POST or a
// custom Authorization header.
async function askQuestion(token, interviewId, question, onEvent) {
  const res = await fetch(`${BASE_URL}/api/interviews/${interviewId}/chat/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question })
  })
  if (!res.ok) throw new Error(await parseErrorDetail(res))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sepIndex
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex)
      buffer = buffer.slice(sepIndex + 2)
      if (!rawEvent.startsWith('data: ')) continue
      onEvent(JSON.parse(rawEvent.slice(6)))
    }
  }
}

module.exports = {
  BASE_URL,
  desktopExchange,
  getCurrentUser,
  updateProfile,
  updatePreferences,
  changePassword,
  deleteAccount,
  listInterviews,
  listSubjects,
  createInterview,
  updateInterview,
  deleteInterview,
  getHistory,
  deleteHistoryEntry,
  clearHistory,
  listMaterials,
  createMaterial,
  uploadMaterial,
  updateMaterial,
  deleteMaterial,
  askQuestion,
  listQa,
  createQa,
  uploadQa,
  updateQa,
  deleteQa,
  mintRealtimeToken
}
