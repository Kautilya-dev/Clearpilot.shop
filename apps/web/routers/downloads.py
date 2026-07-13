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
