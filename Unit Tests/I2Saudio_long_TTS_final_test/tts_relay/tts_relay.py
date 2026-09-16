"""tts_relay.py v3 — GET /tts.mp3?text=... -> native edge-tts MP3 stream.
No dependency on the Docker container for the streaming path.
The Docker openai-edge-tts (POST, port 5050) remains the sketch's fallback."""
import edge_tts
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse

app = FastAPI()

@app.get("/tts.mp3")
async def tts(text: str = Query(...),
              voice: str = Query("en-GB-RyanNeural"),
              speed: float = Query(1.0),
              response_format: str = Query("mp3")):
    if not text.strip():
        raise HTTPException(400, "empty text")
    percent = int(round((speed - 1.0) * 100.0))
    comm = edge_tts.Communicate(text, voice, rate=f"{percent:+d}%")

    async def gen():
        try:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    yield chunk["data"]
        except Exception as e:
            # surface errors in the log instead of dying silently
            print(f"[relay] stream error: {e!r}", flush=True)

    return StreamingResponse(gen(), media_type="audio/mpeg",
                             headers={"Cache-Control": "no-store",
                                      "Connection": "close"})