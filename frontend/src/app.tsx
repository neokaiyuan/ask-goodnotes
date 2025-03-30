import { useState, useRef } from "preact/hooks";
import "./app.css";

export function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [clientId] = useState(() => Math.random().toString(36).substring(7));
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const chunkIndexRef = useRef(0);
  const recordingStartedRef = useRef(false);

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
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      chunkIndexRef.current = 0;
      recordingStartedRef.current = true;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && recordingStartedRef.current) {
          audioChunksRef.current.push(event.data);
          uploadChunk(event.data);
        }
      };

      mediaRecorder.start(1000); // Send chunks every second
      setIsRecording(true);
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
      formData.append("file", chunk, "audio_chunk.wav");
      formData.append("client_id", clientId);
      formData.append("chunk_index", chunkIndexRef.current.toString());
      formData.append("total_chunks", "-1"); // We don't know total chunks yet

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
      }
    }
  };

  return (
    <div class="container">
      <h1>Audio Recording App</h1>
      <button
        onClick={isRecording ? stopRecording : startRecording}
        class={`stream-button ${isRecording ? "active" : ""}`}
      >
        {isRecording ? "Stop Recording" : "Start Recording"}
      </button>
      <p class="status">Status: {isRecording ? "Recording" : "Stopped"}</p>
    </div>
  );
}
