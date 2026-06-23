import hashlib
import hmac
import os
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse

SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days
COOKIE_NAME = "session"

PUBLIC_PATHS = {"/login"}


def _secret():
    secret = os.environ.get("SESSION_SECRET")
    if not secret:
        raise RuntimeError("SESSION_SECRET is not set in the environment")
    return secret.encode()


def make_session_token():
    expiry = str(int(time.time()) + SESSION_MAX_AGE)
    sig = hmac.new(_secret(), expiry.encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{sig}"


def verify_session_token(token):
    try:
        expiry_str, sig = token.split(".", 1)
        expected_sig = hmac.new(_secret(), expiry_str.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return False
        return int(expiry_str) > time.time()
    except Exception:
        return False


LOGIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClearPilot - Login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: { extend: { fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui'] },
      colors: { brand: { 50:'#f5f3ff',100:'#ede9fe',200:'#ddd6fe',300:'#c4b5fd',400:'#a78bfa',500:'#7c5cff',600:'#6d3bf2',700:'#5b21d6',800:'#4c1d95',900:'#3b0f80' } } } }
  }
</script>
<style>
  body { font-family: "Inter", ui-sans-serif, system-ui, sans-serif; }
  .brand-panel { background: radial-gradient(120% 120% at 0% 0%, #6d3bf2 0%, #4c1d95 60%, #1e1b4b 100%); }
  .btn-primary { background: linear-gradient(90deg, #6d3bf2, #7c5cff); color: #fff; transition: filter .15s ease; }
  .btn-primary:hover { filter: brightness(1.08); }
</style>
</head>
<body class="brand-panel min-h-screen flex items-center justify-center px-4">
  <div class="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8">
    <div class="flex items-center gap-2.5 mb-6">
      <span class="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-600 to-brand-400 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">CP</span>
      <div>
        <div class="font-extrabold text-lg leading-tight">ClearPilot</div>
        <div class="text-xs text-slate-400 leading-tight">SAP CPI Study Assistant</div>
      </div>
    </div>
    __ERROR_HTML__
    <form method="post" action="/login">
      <label class="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
      <input type="password" name="password" autofocus placeholder="Enter password"
        class="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500">
      <button type="submit" class="btn-primary w-full rounded-lg py-2.5 text-sm font-semibold">Unlock</button>
    </form>
  </div>
</body>
</html>
"""


def login_page_html(error=False):
    error_html = (
        '<div class="text-sm bg-red-50 text-red-600 border border-red-100 rounded-lg px-3 py-2 mb-4">Wrong password</div>'
        if error else ""
    )
    return LOGIN_HTML.replace("__ERROR_HTML__", error_html)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        token = request.cookies.get(COOKIE_NAME)
        if token and verify_session_token(token):
            return await call_next(request)

        if request.url.path.startswith("/api/"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return RedirectResponse("/login")


def login_get():
    return HTMLResponse(login_page_html())


def login_post(password: str):
    app_password = os.environ.get("APP_PASSWORD")
    if not app_password:
        raise RuntimeError("APP_PASSWORD is not set in the environment")

    if hmac.compare_digest(password, app_password):
        resp = RedirectResponse("/", status_code=302)
        resp.set_cookie(
            COOKIE_NAME,
            make_session_token(),
            httponly=True,
            max_age=SESSION_MAX_AGE,
            samesite="lax",
            secure=os.environ.get("COOKIE_SECURE", "false").lower() == "true",
        )
        return resp
    return HTMLResponse(login_page_html(error=True), status_code=401)


def logout():
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie(COOKIE_NAME)
    return resp
