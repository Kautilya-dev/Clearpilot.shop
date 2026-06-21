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
<html><head><title>CPI Study Assistant - Login</title>
<style>
  body {{ background:#0f1117; color:#e6e8ee; font-family:-apple-system,Segoe UI,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }}
  form {{ background:#171a23; padding:32px; border-radius:12px; border:1px solid #2a2e3a; width:280px; }}
  h1 {{ font-size:1.1rem; margin:0 0 16px; }}
  input {{ width:100%; padding:10px; margin-bottom:12px; border-radius:8px; border:1px solid #2a2e3a;
           background:#0f1117; color:#e6e8ee; box-sizing:border-box; }}
  button {{ width:100%; padding:10px; border-radius:8px; border:none; background:#4f8cff; color:white; cursor:pointer; }}
  .error {{ color:#ff5d5d; font-size:0.85rem; margin-bottom:12px; }}
</style></head>
<body>
  <form method="post" action="/login">
    <h1>SAP CPI Study Assistant</h1>
    {error_html}
    <input type="password" name="password" placeholder="Password" autofocus />
    <button type="submit">Unlock</button>
  </form>
</body></html>
"""


def login_page_html(error=False):
    error_html = '<div class="error">Wrong password</div>' if error else ""
    return LOGIN_HTML.format(error_html=error_html)


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
