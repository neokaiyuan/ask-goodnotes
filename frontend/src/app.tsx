import { useState, useRef, useEffect } from "preact/hooks";
import "./app.css";

// Add type declaration for webkitAudioContext
declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

export function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [agentResponse, setAgentResponse] = useState<string>("");
  const [userInput, setUserInput] = useState<string>("");
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [clientId] = useState(() => Math.random().toString(36).substring(7));
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);
  const recordingStartedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const websocketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 3000; // 3 seconds
  const shouldStopRef = useRef(false);

  const connectWebSocket = () => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const ws = new WebSocket(`ws://localhost:8000/ws/${clientId}`);
    websocketRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        // Handle binary audio data
        const arrayBuffer = await event.data.arrayBuffer();
        const audioData = new Int16Array(arrayBuffer);

        // Create or reuse AudioContext
        const audioContext =
          audioContextRef.current ||
          new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = audioContext;

        // Create an AudioBuffer from the PCM data
        const audioBuffer = audioContext.createBuffer(
          1,
          audioData.length,
          24000
        );
        const channelData = audioBuffer.getChannelData(0);

        // Convert Int16 to Float32 (Web Audio API uses -1 to 1 range)
        for (let i = 0; i < audioData.length; i++) {
          channelData[i] = audioData[i] / 32768.0;
        }

        // Add to queue and play
        audioQueueRef.current.push(audioBuffer);
        playNextInQueue();
      } else {
        // Handle text data
        console.log("Received text data:", event.data);
        if (event.data.startsWith("INPUT:")) {
          setUserInput(event.data.substring(6)); // Remove "INPUT:" prefix
        } else if (event.data.startsWith("OUTPUT:")) {
          setAgentResponse(event.data.substring(7)); // Remove "OUTPUT:" prefix
        }
      }
    };

    ws.onclose = (event) => {
      console.log("WebSocket connection closed", event.code, event.reason);
      setIsConnected(false);
      setIsProcessing(false);

      // Attempt to reconnect if we haven't exceeded max attempts
      if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current++;
        console.log(
          `Attempting to reconnect (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`
        );

        // Clear any existing timeout
        if (reconnectTimeoutRef.current) {
          window.clearTimeout(reconnectTimeoutRef.current);
        }

        // Set new timeout for reconnection
        reconnectTimeoutRef.current = window.setTimeout(
          connectWebSocket,
          RECONNECT_DELAY
        );
      } else {
        console.error("Max reconnection attempts reached");
        alert("Connection lost. Please refresh the page to try again.");
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
      setIsProcessing(false);
    };
  };

  useEffect(() => {
    connectWebSocket();

    return () => {
      // Clean up WebSocket and any pending reconnection attempts
      if (websocketRef.current) {
        websocketRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [clientId]);

  const startRecording = async () => {
    try {
      // First, start the recording on the backend
      const startResponse = await fetch("http://localhost:8000/audio/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: clientId }),
      });

      if (!startResponse.ok) {
        throw new Error(`Failed to start recording: ${startResponse.status}`);
      }

      const startData = await startResponse.json();
      console.log("Recording started:", startData);

      // Then start recording on the frontend
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });

      mediaRecorderRef.current = mediaRecorder;
      chunkIndexRef.current = 0;
      recordingStartedRef.current = true;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && recordingStartedRef.current) {
          uploadChunk(event.data);
        }
      };

      mediaRecorder.start(1000); // Send chunks every second
      setIsRecording(true);
      setUserInput(""); // Clear previous user input
      setAgentResponse(""); // Clear previous response
    } catch (error) {
      console.error("Error starting recording:", error);
      alert(
        "Failed to start recording. Please ensure you have granted microphone permissions."
      );
      recordingStartedRef.current = false;
    }
  };

  const uploadChunk = async (chunk: Blob) => {
    if (!recordingStartedRef.current) {
      console.error("Cannot upload chunk: recording not started");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", chunk, "audio_chunk.webm");
      formData.append("client_id", clientId);
      formData.append("chunk_index", chunkIndexRef.current.toString());

      console.log("Uploading chunk:", {
        clientId,
        chunkIndex: chunkIndexRef.current,
        chunkSize: chunk.size,
      });

      const response = await fetch("http://localhost:8000/audio/chunk", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `HTTP error! status: ${response.status}, detail: ${errorData.detail}`
        );
      }

      chunkIndexRef.current++;
    } catch (error: unknown) {
      console.error("Error uploading chunk:", error);
      // If we get a 400 error, it might mean the recording wasn't properly started
      if (error instanceof Error && error.message.includes("400")) {
        recordingStartedRef.current = false;
        alert("Recording error: Please try starting the recording again.");
      }
    }
  };

  const stopRecording = async () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream
        .getTracks()
        .forEach((track) => track.stop());
      setIsRecording(false);
      recordingStartedRef.current = false;
      setIsProcessing(true);

      try {
        // Send stop signal to backend
        const response = await fetch("http://localhost:8000/audio/stop", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ client_id: clientId }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            `HTTP error! status: ${response.status}, detail: ${errorData.detail}`
          );
        }

        // Reset chunk index for next recording
        chunkIndexRef.current = 0;
      } catch (error: unknown) {
        console.error("Error stopping recording:", error);
        alert("Error stopping recording. Please try again.");
        setIsProcessing(false);
      }
    }
  };

  const playNextInQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;

    isPlayingRef.current = true;
    setIsPlayingAudio(true);
    shouldStopRef.current = false;
    const audioContext =
      audioContextRef.current ||
      new (window.AudioContext || window.webkitAudioContext)();
    audioContextRef.current = audioContext;

    while (audioQueueRef.current.length > 0 && !shouldStopRef.current) {
      const buffer = audioQueueRef.current.shift();
      if (!buffer) continue;

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start(0);
      activeSourcesRef.current.push(source);

      // Check stop flag more frequently
      if (shouldStopRef.current) {
        source.stop(0);
        source.disconnect();
        activeSourcesRef.current = activeSourcesRef.current.filter(
          (s) => s !== source
        );
        break;
      }

      // Wait for the audio to finish playing
      await new Promise<void>((resolve) => {
        source.onended = () => {
          activeSourcesRef.current = activeSourcesRef.current.filter(
            (s) => s !== source
          );
          resolve();
        };
      });
    }

    isPlayingRef.current = false;
    setIsPlayingAudio(false);
  };

  const stopProcessing = async () => {
    try {
      // Send stop signal to backend
      const response = await fetch(
        "http://localhost:8000/audio/stop-processing",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ client_id: clientId }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Error stopping processing:", errorData);
        // Even if the backend returns an error, we should still clean up the frontend state
        setIsProcessing(false);
        setIsPlayingAudio(false);
        throw new Error(
          `Failed to stop processing: ${
            errorData.detail || response.statusText
          }`
        );
      }
    } catch (error: unknown) {
      console.error("Error stopping processing:", error);
      // Ensure we clean up the frontend state even if there's an error
      setIsProcessing(false);
      setIsPlayingAudio(false);
    }
  };

  const stopAudio = async () => {
    shouldStopRef.current = true;
    setIsPlayingAudio(false); // Set this first to prevent new audio from starting

    // Stop all active audio sources immediately
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop(0);
        source.disconnect();
      } catch (e) {
        console.error("Error stopping audio source:", e);
      }
    });
    activeSourcesRef.current = [];

    // Close and reset the context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Clear the queue and reset states
    audioQueueRef.current = [];
    isPlayingRef.current = false;

    // If we're in processing state, stop the backend processing
    if (isProcessing) {
      try {
        await stopProcessing();
      } catch (error) {
        console.error("Error during stopAudio:", error);
        // Ensure we clean up the frontend state even if there's an error
        setIsProcessing(false);
        setIsPlayingAudio(false);
      }
    }

    // Add a small delay to ensure all audio has stopped
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  return (
    <div class="container">
      <h1>Ask Goodnotes</h1>
      <button
        onClick={
          isPlayingAudio
            ? stopAudio
            : isRecording
            ? stopRecording
            : startRecording
        }
        class={`stream-button ${isRecording || isPlayingAudio ? "active" : ""}`}
        disabled={isProcessing && !isPlayingAudio}
      >
        {isProcessing && !isPlayingAudio
          ? "Processing"
          : isPlayingAudio
          ? "Stop Audio"
          : isRecording
          ? "Stop Recording"
          : "Start Recording"}
      </button>
      <p class="status">
        Status:{" "}
        {!isConnected
          ? "Connecting..."
          : isRecording
          ? "Recording"
          : isProcessing
          ? "Processing..."
          : "Ready"}
      </p>
      {(userInput || agentResponse) && (
        <div class="conversation">
          {userInput && (
            <div class="message user-message">
              <div class="message-content">{userInput}</div>
            </div>
          )}
          {agentResponse && (
            <div class="message agent-message">
              <div class="message-content">{agentResponse}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
