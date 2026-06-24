from pathlib import Path

from pydantic_settings import BaseSettings

# Absolute path, not relative ".env" - pydantic-settings resolves a relative path
# against the process's cwd, which differs from this file's location when launched
# with --app-dir from elsewhere (e.g. local preview tooling).
_ENV_FILE = Path(__file__).resolve().parent / ".env"


class Settings(BaseSettings):
    database_url: str = ""
    redis_url: str = ""
    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 30  # 30 days, matches desktop's "stay signed in" expectation
    admin_emails: str = ""  # comma-separated allowlist - "promoting" an admin is just editing this env var

    @property
    def admin_emails_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    class Config:
        env_file = _ENV_FILE


settings = Settings()
