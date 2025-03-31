import os
import asyncio
from typing import Dict, AsyncGenerator
from fastapi import FastAPI, UploadFile, File, HTTPException, Form, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import time
import tempfile
import shutil
from pydantic import BaseModel
from dotenv import load_dotenv
import numpy as np
import sounddevice as sd
import soundfile as sf
from pydub import AudioSegment
from agents.voice import (
    AudioInput,
)
from backend.agents import pipeline

# Load environment variables
load_dotenv()

# Create audio directory if it doesn't exist
AUDIO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
os.makedirs(AUDIO_DIR, exist_ok=True)


class StartRecordingRequest(BaseModel):
    client_id: str


class StopRecordingRequest(BaseModel):
    client_id: str


class AudioManager:
    def __init__(self):
        self.active_recordings: Dict[str, tuple[str, str, str]] = {}
        self.active_websockets: Dict[str, WebSocket] = {}

    def start_recording(self, client_id: str) -> str:
        if client_id in self.active_recordings:
            raise HTTPException(
                status_code=400, detail="Recording already in progress for this client"
            )

        # Create a temporary directory for this recording
        temp_dir = tempfile.mkdtemp()
        temp_webm = os.path.join(temp_dir, f"temp_audio_{client_id}.webm")
        temp_wav = os.path.join(temp_dir, f"temp_audio_{client_id}.wav")

        # Create an empty WebM file
        with open(temp_webm, "wb") as f:
            f.write(b"")

        # Store temp directory and file paths
        self.active_recordings[client_id] = (temp_dir, temp_webm, temp_wav)
        print(f"Started new recording for client {client_id} at {temp_webm}")
        return temp_webm

    def add_chunk(self, client_id: str, chunk: bytes):
        if client_id not in self.active_recordings:
            raise HTTPException(
                status_code=400, detail="No active recording found for this client"
            )

        try:
            temp_dir, temp_webm, _ = self.active_recordings[client_id]

            # Append the chunk to the WebM file
            with open(temp_webm, "ab") as f:
                f.write(chunk)
            print(f"Wrote chunk of size {len(chunk)} bytes for client {client_id}")
        except Exception as e:
            print(f"Error writing chunk for client {client_id}: {str(e)}")
            import traceback

            print(f"Traceback: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=str(e))

    async def connect_websocket(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_websockets[client_id] = websocket

    async def disconnect_websocket(self, client_id: str):
        if client_id in self.active_websockets:
            await self.active_websockets[client_id].close()
            del self.active_websockets[client_id]

    async def send_audio_chunk(self, client_id: str, audio_data: np.ndarray):
        if client_id in self.active_websockets:
            try:
                # Convert numpy array to bytes
                audio_bytes = audio_data.astype(np.int16).tobytes()
                await self.active_websockets[client_id].send_bytes(audio_bytes)
            except Exception as e:
                print(f"Error sending audio chunk: {str(e)}")
                await self.disconnect_websocket(client_id)

    async def send_text(self, client_id: str, text: str):
        if client_id in self.active_websockets:
            try:
                await self.active_websockets[client_id].send_text(text)
            except Exception as e:
                print(f"Error sending text: {str(e)}")
                await self.disconnect_websocket(client_id)

    async def process_audio_with_agent(
        self, audio_path: str, client_id: str
    ) -> AsyncGenerator[str, None]:
        try:
            # Get the temporary directory and WAV file path
            temp_dir, _, temp_wav = self.active_recordings[client_id]
            print(f"Processing audio for client {client_id}")
            print(f"Input file: {audio_path}")
            print(f"Output file: {temp_wav}")

            try:
                # Convert WebM to WAV using pydub
                audio = AudioSegment.from_file(audio_path, format="webm")
                audio.export(temp_wav, format="wav")
                print("Successfully converted WebM to WAV")
            except Exception as e:
                print(f"Error converting WebM to WAV: {str(e)}")
                import traceback

                print(f"Conversion traceback: {traceback.format_exc()}")
                raise

            # Read the WAV file using soundfile
            print(f"Reading audio file from: {temp_wav}")
            try:
                audio_array, sample_rate = sf.read(temp_wav, dtype=np.int16)
                print(f"Audio shape: {audio_array.shape}, Sample rate: {sample_rate}")
            except Exception as e:
                print(f"Error reading WAV file: {str(e)}")
                import traceback

                print(f"Reading traceback: {traceback.format_exc()}")
                raise

            # Create audio input for the pipeline with the original audio array
            print("Creating AudioInput object")
            audio_input = AudioInput(buffer=audio_array, frame_rate=sample_rate)

            # Run the pipeline
            print("Starting pipeline processing")
            result = await pipeline.run(audio_input)

            # Stream the results
            async for event in result.stream():
                if event.type == "voice_stream_event_text":
                    await self.send_text(client_id, event.data)
                elif event.type == "voice_stream_event_audio":
                    try:
                        if not isinstance(event.data, np.ndarray):
                            print("Error: event.data is not a numpy array")
                            continue
                        await self.send_audio_chunk(client_id, event.data)
                    except Exception as e:
                        print(f"Error sending audio chunk: {str(e)}")
                        import traceback

                        print(f"Traceback: {traceback.format_exc()}")

            # Clean up after processing is complete
            try:
                if os.path.exists(temp_dir):
                    shutil.rmtree(temp_dir)
                print(f"Cleaned up temporary files for client {client_id}")
                del self.active_recordings[client_id]
                print(f"Removed recording entry for client {client_id}")
                await self.disconnect_websocket(client_id)
            except Exception as e:
                print(f"Error during cleanup: {str(e)}")

        except Exception as e:
            print(f"Error processing audio with agent: {str(e)}")
            import traceback

            print(f"Full traceback: {traceback.format_exc()}")
            await self.send_text(client_id, f"Error processing audio: {str(e)}")
            # Clean up even if there was an error
            try:
                if client_id in self.active_recordings:
                    temp_dir, _, _ = self.active_recordings[client_id]
                    if os.path.exists(temp_dir):
                        shutil.rmtree(temp_dir)
                    del self.active_recordings[client_id]
                await self.disconnect_websocket(client_id)
            except Exception as cleanup_error:
                print(
                    f"Error during cleanup after processing error: {str(cleanup_error)}"
                )

    def stop_recording(self, client_id: str) -> str:
        if client_id not in self.active_recordings:
            print(f"No active recording found for client {client_id}")
            return None

        try:
            temp_dir, temp_webm, _ = self.active_recordings[client_id]

            # Create final filename with timestamp
            timestamp = int(time.time())
            final_filename = f"audio_{client_id}_{timestamp}.webm"
            final_path = os.path.join(AUDIO_DIR, final_filename)

            # Move the WebM file to the final location
            shutil.move(temp_webm, final_path)
            print(f"Moved recording to: {final_path}")

            # Don't clean up the recording entry yet - we need it for processing
            print(f"Stopped recording for client {client_id}")

            return final_path
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
):
    if not client_id:
        raise HTTPException(status_code=400, detail="client_id is required")

    chunk_data = await file.read()
    manager.add_chunk(client_id, chunk_data)

    return {
        "status": "success",
        "chunk_index": chunk_index,
    }


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect_websocket(client_id, websocket)
    try:
        while True:
            # Keep the connection alive and handle any incoming messages if needed
            data = await websocket.receive_text()
            print(f"Received message from client {client_id}: {data}")
    except Exception as e:
        print(f"WebSocket error for client {client_id}: {str(e)}")
    finally:
        await manager.disconnect_websocket(client_id)


@app.post("/audio/stop")
async def stop_recording(request: StopRecordingRequest):
    if not request.client_id:
        raise HTTPException(status_code=400, detail="client_id is required")

    final_path = manager.stop_recording(request.client_id)
    if not final_path:
        return {"status": "error", "message": "No recording found to stop"}

    # Start processing in the background
    asyncio.create_task(manager.process_audio_with_agent(final_path, request.client_id))
    return {"status": "success", "message": "Processing started"}
