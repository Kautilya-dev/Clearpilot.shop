"""ABOUT THIS FILE
Serves the Desktop app installer and version info from a private Tigris (S3-compatible)
bucket, mounted at the site root (no /api prefix - see server.py's include_router call), so
these are plain unauthenticated GETs like /download/windows and /download/latest-version.

Linked from:
- apps/web/pages/download.html: the "Download .exe installer" button links to /download/windows.
- apps/desktop/src/main/api-client.js: fetchLatestVersion() and downloadInstaller() call
  /download/latest-version and /download/windows respectively, for the Settings -> Update
  tab's auto-update flow (checks the version, then reuses the same installer download).

Release process (manual, see this session's ClearPilot Desktop v0.3.1 release): build the
installer (`npm run build` in apps/desktop), then upload it to the Tigris bucket at key
"ClearPilot-Setup.exe" (overwriting the previous release) and upload a plain-text
"latest-version.txt" containing just the new version number - both via boto3, reusing the
same TIGRIS_* credentials this file reads from Railway service variables.
"""
import boto3
from botocore.config import Config
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import RedirectResponse

from config import settings

router = APIRouter(tags=["downloads"])

# Presigned URL, not a public bucket - keeps the bucket itself private while still giving
# out a real, time-limited download link. 10 minutes is plenty for a browser to start the
# download; the download itself continues past expiry once started (the URL is only
# re-checked at connection time).
_PRESIGN_TTL_SECONDS = 600


def _s3_client():
    if not settings.tigris_endpoint or not settings.tigris_bucket_name:
        return None
    return boto3.client(
        "s3",
        endpoint_url=settings.tigris_endpoint,
        aws_access_key_id=settings.tigris_access_key_id,
        aws_secret_access_key=settings.tigris_secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


@router.get("/download/windows")
async def download_windows_installer():
    """Redirects to a freshly presigned URL for the Desktop app's NSIS installer, hosted
    in a private Tigris bucket - self-hosted so the download never depends on GitHub
    Releases being reachable/configured correctly."""
    s3 = _s3_client()
    if s3 is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Download storage not configured")
    url = s3.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.tigris_bucket_name,
            "Key": "ClearPilot-Setup.exe",
            "ResponseContentDisposition": 'attachment; filename="ClearPilot-Setup.exe"',
        },
        ExpiresIn=_PRESIGN_TTL_SECONDS,
    )
    return RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/download/latest-version")
async def latest_desktop_version():
    """Returns the current Desktop release's version string, read directly from the tiny
    latest-version.txt object in the same private bucket - fetched server-side (rather than
    handing the Desktop app a second presigned URL) since it's a few bytes and isn't
    sensitive. The Desktop app's Settings -> Update tab compares this against app.getVersion()
    to decide whether to show "update available"."""
    s3 = _s3_client()
    if s3 is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Download storage not configured")
    try:
        obj = s3.get_object(Bucket=settings.tigris_bucket_name, Key="latest-version.txt")
        version = obj["Body"].read().decode("utf-8").strip()
    except s3.exceptions.NoSuchKey:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No release version published yet")
    return {"version": version}


# UPDATES LOG
# 2026-07-20 - Added GET /download/latest-version for the Desktop app's new Settings ->
#   Update tab auto-update feature - reuses this file's existing presigned-download
#   infrastructure instead of standing up a dedicated update-manifest host.
