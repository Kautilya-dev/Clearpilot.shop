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

// Exchanges the one-time code from a clearpilot://auth-callback?code=... redirect (minted
// by the browser right after a normal password login at /login?desktop=1) for a real JWT.
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

module.exports = { BASE_URL, desktopExchange, getCurrentUser, listInterviews }
