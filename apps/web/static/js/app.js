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

// Fills every matching slot (not just one id) so the same user info + logout control can
// appear in both the desktop sidebar (#sidebar-user) and the mobile menu (#sidebar-user-mobile)
// on pages that have both, without duplicating this fetch/render logic per page.
async function renderSidebarUser() {
  const slots = document.querySelectorAll('#sidebar-user, #sidebar-user-mobile');
  if (slots.length === 0) return;

  const user = await fetchCurrentUser();
  if (!user) {
    window.location.href = '/login';
    return;
  }
  // Admin link is server-driven (user.is_admin, computed in auth.py from ADMIN_EMAILS) -
  // /admin itself still enforces the real access check either way, this just saves an
  // admin from having to know/type the URL.
  const adminLink = user.is_admin
    ? `<a href="/admin" class="sidebar-link"><i data-lucide="shield" class="w-4 h-4"></i>Admin</a>`
    : '';
  slots.forEach((slot) => {
    slot.innerHTML = `
      ${adminLink}
      <div class="flex items-center justify-between px-3 py-2">
        <span class="text-sm font-medium text-gray-700 truncate">${user.display_name}</span>
        <button onclick="logout()" class="text-gray-400 hover:text-gray-700" title="Log out">
          <i data-lucide="log-out" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  });
  if (window.lucide) lucide.createIcons();
}

// Opt-in per page: pages with a sidebar (dashboard/history/settings) include a mobile-only
// top bar with a hamburger button (#mobile-menu-btn) that toggles a slide-down nav
// (#mobile-menu) - the sidebar itself is desktop-only (hidden below the md breakpoint), so
// this is the only way to move between Dashboard/History/Settings on a phone. Interview.html
// deliberately doesn't have this - its "All interviews" back-link already covers navigation
// for that page.
function initMobileMenu() {
  const btn = document.getElementById('mobile-menu-btn');
  const menu = document.getElementById('mobile-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', () => menu.classList.toggle('hidden'));
}

document.addEventListener('DOMContentLoaded', () => {
  renderNavAuth();
  renderSidebarUser();
  initMobileMenu();
  if (window.lucide) lucide.createIcons();
});
