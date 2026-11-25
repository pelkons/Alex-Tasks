#!/usr/bin/env python3
"""Speech-to-text worker for voice messages in Hebrew or Russian (faster-whisper, CPU, int8).
A small multilingual model first decides between Hebrew and Russian (only those two probabilities are compared). Hebrew is then transcribed
by the ivrit.ai model with language "he", Russian by the multilingual model with language "ru". Both models load lazily and stay warm;
jobs run one at a time.
Protocol: one JSON per line on stdin {"id":..,"path":".../audio.wav"}; one JSON per line on stdout {"id":..,"text":..,"language":"he|ru",...}."""
import json, os, sys, time, wave
import numpy as np

HE_MODEL = os.environ.get("MESIMOT_WHISPER_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
MULTI_MODEL = os.environ.get("MESIMOT_WHISPER_MULTI_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
DETECT_MODEL = os.environ.get("MESIMOT_WHISPER_DETECT_MODEL", "Systran/faster-whisper-small")  # small and fast: only he vs ru is decided here
CACHE = os.environ.get("MESIMOT_WHISPER_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "whisper"))
THREADS = int(os.environ.get("MESIMOT_WHISPER_THREADS", "4"))
_models = {}

def get(name):
    if name not in _models:
        from faster_whisper import WhisperModel
        t = time.time()
        _models[name] = WhisperModel(name, device="cpu", compute_type="int8", download_root=CACHE, cpu_threads=THREADS)
        print(json.dumps({"event": "loaded", "model": name, "seconds": round(time.time() - t, 1)}), flush=True)
    return _models[name]

def read_wav(path):
    # 16 kHz mono 16-bit wav (prepared with ffmpeg); read directly to avoid extra decoders
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

def detect(audio):
    """Hebrew or Russian: compare only those two probabilities of the multilingual model."""
    m = get(DETECT_MODEL)
    _, _, probs = m.detect_language(audio=audio[: 16000 * 30], vad_filter=False)
    p = dict(probs)
    he, ru = p.get("he", 0.0), p.get("ru", 0.0)
    return ("he" if he >= ru else "ru"), he, ru

def transcribe(audio, lang):
    m = get(HE_MODEL if lang == "he" else MULTI_MODEL)
    segs, info = m.transcribe(audio, language=lang, beam_size=1, vad_filter=True, condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segs).strip(), info.duration

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    try:
        t0 = time.time()
        audio = read_wav(req["path"])
        lang, he, ru = detect(audio)
        t1 = time.time()
        text, duration = transcribe(audio, lang)
        print(json.dumps({"id": req["id"], "text": text, "language": lang, "p_he": round(he, 3), "p_ru": round(ru, 3),
                          "detect_seconds": round(t1 - t0, 1), "seconds": round(time.time() - t0, 1), "duration": round(duration, 1)}, ensure_ascii=False), flush=True)
    except Exception as e:  # keep the worker alive
        print(json.dumps({"id": req["id"], "error": str(e)}), flush=True)
