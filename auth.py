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
<html lang="en" data-bs-theme="dark"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClearPilot - Login</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="d-flex align-items-center justify-content-center" style="height:100vh;">
  <form method="post" action="/login" class="card bg-body-tertiary border-secondary-subtle p-4" style="width:300px;">
    <h1 class="h5 mb-3">ClearPilot</h1>
    {error_html}
    <input type="password" name="password" class="form-control mb-3" placeholder="Password" autofocus />
    <button type="submit" class="btn btn-primary w-100">Unlock</button>
  </form>
</body></html>
"""


def login_page_html(error=False):
    error_html = '<div class="alert alert-danger py-2 mb-3">Wrong password</div>' if error else ""
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
