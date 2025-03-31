# Voice-Enabled Ask Goodnotes

Demo for Goodnotes presentation

## Get Started

### Frontend

1. Navigate to `frontend` folder
2. Install packages with `bun install`
3. Run server with `bun run dev`

### Backend

1. Navigate to `backend` folder
2. Install packages with `uv pip sync`
3. Install `ffmpeg` on system to enable `pydub` to convert `webm` audio from client to `wav` for AI processing
4. Add `OPENAI_API_KEY` to `.env`
5. Run server with `uv run main.py`
