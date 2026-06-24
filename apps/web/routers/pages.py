from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter()

_PAGES_DIR = Path(__file__).resolve().parent.parent / "pages"

_ROUTES = {
    "/": "index.html",
    "/about": "about.html",
    "/download": "download.html",
    "/data": "data.html",
    "/login": "login.html",
    "/register": "register.html",
    "/account": "account.html",
    "/admin": "admin.html",
}

for path, filename in _ROUTES.items():
    file_path = _PAGES_DIR / filename

    def _make_handler(fp: Path):
        async def _handler():
            return FileResponse(fp)
        return _handler

    router.add_api_route(path, _make_handler(file_path), methods=["GET"], include_in_schema=False)
