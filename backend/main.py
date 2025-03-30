from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]

    async def send_message(self, message: dict, client_id: str):
        if client_id in self.active_connections:
            await self.active_connections[client_id].send_json(message)


manager = ConnectionManager()

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_json()

            # Handle different types of WebRTC messages
            if data["type"] == "offer":
                # Process the offer and create answer
                # For now, we'll just echo back the offer
                await manager.send_message(
                    {"type": "answer", "sdp": data["sdp"]}, client_id
                )

            elif data["type"] == "ice-candidate":
                # Handle ICE candidates
                await manager.send_message(
                    {"type": "ice-candidate", "candidate": data["candidate"]}, client_id
                )

            elif data["type"] == "audio":
                # Process audio data
                # Here you would integrate with your existing audio processing pipeline
                pass

    except WebSocketDisconnect:
        manager.disconnect(client_id)
