const TOKEN_KEY = 'clearpilot_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function logout() {
  clearToken();
  window.location.href = '/';
}

async function fetchCurrentUser() {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      clearToken();
      return null;
    }
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function renderNavAuth() {
  const slot = document.getElementById('nav-auth');
  if (!slot) return;

  const user = await fetchCurrentUser();
  if (user) {
    slot.innerHTML = `
      <a href="/dashboard" class="text-sm font-medium text-gray-600 hover:text-gray-900">${user.display_name}</a>
      <button onclick="logout()" class="btn-secondary text-sm">Log out</button>
    `;
  } else {
    slot.innerHTML = `
      <a href="/login" class="text-sm font-medium text-gray-600 hover:text-gray-900">Log in</a>
      <a href="/register" class="btn-primary text-sm">Get started</a>
    `;
  }
}

function requireAuthOrRedirect() {
  if (!getToken()) {
    window.location.href = '/login';
    return false;
  }
  return true;
}

async function renderSidebarUser() {
  const slot = document.getElementById('sidebar-user');
  if (!slot) return;

  const user = await fetchCurrentUser();
  if (!user) {
    window.location.href = '/login';
    return;
  }
  slot.innerHTML = `
    <div class="flex items-center justify-between px-3 py-2">
      <span class="text-sm font-medium text-gray-700 truncate">${user.display_name}</span>
      <button onclick="logout()" class="text-gray-400 hover:text-gray-700" title="Log out">
        <i data-lucide="log-out" class="w-4 h-4"></i>
      </button>
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', () => {
  renderNavAuth();
  renderSidebarUser();
  if (window.lucide) lucide.createIcons();
});
