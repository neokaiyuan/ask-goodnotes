import os
from typing import Dict
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
import time
import tempfile
import shutil
from pydantic import BaseModel

# Create audio directory if it doesn't exist
AUDIO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
os.makedirs(AUDIO_DIR, exist_ok=True)


class StartRecordingRequest(BaseModel):
    client_id: str


class StopRecordingRequest(BaseModel):
    client_id: str


class AudioManager:
    def __init__(self):
        self.active_recordings: Dict[str, tuple[str, str]] = {}

    def start_recording(self, client_id: str) -> str:
        if client_id in self.active_recordings:
            raise HTTPException(
                status_code=400, detail="Recording already in progress for this client"
            )

        # Create a temporary directory for this recording
        temp_dir = tempfile.mkdtemp()
        temp_webm = os.path.join(temp_dir, f"temp_audio_{client_id}.webm")

        # Store both the temp directory and webm file path
        self.active_recordings[client_id] = (temp_dir, temp_webm)
        print(f"Started new recording for client {client_id} at {temp_webm}")
        return temp_webm

    def add_chunk(self, client_id: str, chunk: bytes):
        if client_id not in self.active_recordings:
            raise HTTPException(
                status_code=400, detail="No active recording found for this client"
            )

        try:
            _, temp_webm = self.active_recordings[client_id]
            # Append the chunk to the WebM file
            with open(temp_webm, "ab") as f:
                f.write(chunk)
            print(f"Wrote chunk of size {len(chunk)} bytes for client {client_id}")
        except Exception as e:
            print(f"Error writing chunk for client {client_id}: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))

    def stop_recording(self, client_id: str):
        if client_id not in self.active_recordings:
            print(f"No active recording found for client {client_id}")
            return

        try:
            temp_dir, temp_webm = self.active_recordings[client_id]

            # Create final filename with timestamp
            timestamp = int(time.time())
            final_filename = f"audio_{client_id}_{timestamp}.webm"
            final_path = os.path.join(AUDIO_DIR, final_filename)

            # Move the WebM file to the final location
            shutil.move(temp_webm, final_path)
            print(f"Moved recording to: {final_path}")

            # Clean up temporary directory
            shutil.rmtree(temp_dir)
            print(f"Cleaned up temporary files for client {client_id}")

            # Clean up the active recording entry
            del self.active_recordings[client_id]
            print(f"Stopped recording for client {client_id}")
        except Exception as e:
            print(f"Error stopping recording for client {client_id}: {str(e)}")
            # Try to clean up the temporary directory if it exists
            try:
                if os.path.exists(temp_dir):
                    shutil.rmtree(temp_dir)
            except:
                pass
            raise HTTPException(status_code=500, detail=str(e))


manager = AudioManager()

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/audio/start")
async def start_recording(request: StartRecordingRequest):
    if not request.client_id:
        raise HTTPException(status_code=400, detail="client_id is required")

    audio_path = manager.start_recording(request.client_id)
    return {
        "status": "success",
        "message": "Recording started",
        "file_path": audio_path,
    }


@app.post("/audio/chunk")
async def upload_audio_chunk(
    file: UploadFile = File(...),
    client_id: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
):
    if not client_id:
        raise HTTPException(status_code=400, detail="client_id is required")

    chunk_data = await file.read()
    manager.add_chunk(client_id, chunk_data)

    return {
        "status": "success",
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,
    }


@app.post("/audio/stop")
async def stop_recording(request: StopRecordingRequest):
    if not request.client_id:
        raise HTTPException(status_code=400, detail="client_id is required")

    manager.stop_recording(request.client_id)
    return {"status": "success", "message": "Recording stopped and saved"}
