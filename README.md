# ClearPilot

A personal SAP CPI study assistant. Ask a technical CPI question by voice or text and get a fast, grounded answer pulled from your own notes and the CPI handbook - plus a practice mode built from real interview question patterns.

## Setup

```
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY, APP_PASSWORD, SESSION_SECRET
python build_index.py  # builds index_cache.pkl, questions_bank.json, answer_cache.json
uvicorn server:app --reload
```

Open `http://localhost:8000` in Chrome (required for the microphone feature).
