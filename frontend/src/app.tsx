import { useState, useEffect } from "preact/hooks";
import "./app.css";

export function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peerConnection, setPeerConnection] =
    useState<RTCPeerConnection | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [clientId] = useState(() => Math.random().toString(36).substring(7));

  useEffect(() => {
    // Initialize WebSocket connection
    const websocket = new WebSocket(`ws://localhost:8000/ws/${clientId}`);

    websocket.onopen = () => {
      console.log("WebSocket connected");
    };

    websocket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (!peerConnection) return;

      switch (data.type) {
        case "answer":
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(data)
          );
          break;
        case "ice-candidate":
          await peerConnection.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
          break;
      }
    };

    websocket.onerror = (error) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
    };

    websocket.onclose = () => {
      console.log("WebSocket disconnected");
      setIsConnected(false);
    };

    setWs(websocket);

    return () => {
      websocket.close();
    };
  }, [clientId]);

  const startAudioStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setLocalStream(stream);

      // Create WebRTC connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // Add audio track to connection
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Handle incoming audio
      pc.ontrack = (event) => {
        const remoteAudio = new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play();
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: event.candidate,
            })
          );
        }
      };

      setPeerConnection(pc);
      setIsConnected(true);

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer through WebSocket
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "offer",
            sdp: offer,
          })
        );
      }
    } catch (error) {
      console.error("Error accessing microphone:", error);
      alert(
        "Failed to access microphone. Please ensure you have granted microphone permissions."
      );
    }
  };

  const stopAudioStream = () => {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    if (peerConnection) {
      peerConnection.close();
      setPeerConnection(null);
    }
    setIsConnected(false);
  };

  return (
    <div class="container">
      <h1>Audio Streaming App</h1>
      <button
        onClick={isConnected ? stopAudioStream : startAudioStream}
        class={`stream-button ${isConnected ? "active" : ""}`}
      >
        {isConnected ? "Stop Streaming" : "Start Streaming"}
      </button>
      <p class="status">Status: {isConnected ? "Connected" : "Disconnected"}</p>
    </div>
  );
}
