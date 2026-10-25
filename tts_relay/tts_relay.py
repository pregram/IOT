"""TTS relay for the SnapRiddle room speaker: GET /tts.mp3?text=... -> edge-tts MP3 stream.

The board starts playing while audio is still arriving, which is why this streams
instead of returning a finished file. Run on the host PC:
    uvicorn tts_relay:app --host 0.0.0.0 --port 5051
"""
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