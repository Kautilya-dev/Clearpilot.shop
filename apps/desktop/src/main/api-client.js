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

module.exports = { BASE_URL, desktopExchange, getCurrentUser, listInterviews, askQuestion }
