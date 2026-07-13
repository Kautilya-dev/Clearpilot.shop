from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, RedirectResponse

router = APIRouter()

_PAGES_DIR = Path(__file__).resolve().parent.parent / "pages"

_ROUTES = {
    "/": "index.html",
    "/about": "about.html",
    "/download": "download.html",
    "/data": "data.html",
    "/login": "login.html",
    "/register": "register.html",
    "/admin": "admin.html",
    "/dashboard": "dashboard.html",
    "/history": "history.html",
    "/settings": "settings.html",
}

# Without an explicit Cache-Control, browsers apply heuristic caching to these
# FileResponses (based on Last-Modified) and can serve a stale page shell straight
# from disk with no network request at all - a deploy becomes invisible to a
# returning visitor until the heuristic freshness window expires. no-cache forces
# a revalidation (cheap conditional GET via ETag) on every load instead.
_NO_CACHE_HEADERS = {"Cache-Control": "no-cache"}

for path, filename in _ROUTES.items():
    file_path = _PAGES_DIR / filename

    def _make_handler(fp: Path):
        async def _handler():
            return FileResponse(fp, headers=_NO_CACHE_HEADERS)
        return _handler

    router.add_api_route(path, _make_handler(file_path), methods=["GET"], include_in_schema=False)


# Single static shell for any interview - the workspace JS reads the id from the URL
# path itself, so one file serves every /interviews/{interview_id}.
_INTERVIEW_PAGE = _PAGES_DIR / "interview.html"


@router.get("/interviews/{interview_id}", include_in_schema=False)
async def interview_workspace(interview_id: str):
    return FileResponse(_INTERVIEW_PAGE, headers=_NO_CACHE_HEADERS)


@router.get("/account", include_in_schema=False)
async def account_redirect():
    # /account's old profile view is now the Profile section of /settings - redirect
    # rather than maintain two overlapping pages.
    return RedirectResponse(url="/settings")
