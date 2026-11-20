#!/usr/bin/env python3
"""
sherpa-local-server —— 流式语音识别，OpenAI 兼容 + 增量流接口

- POST /v1/audio/transcriptions   OpenAI 兼容，接一整段 WAV（保持旧扩展可用）
- POST /v1/stream/feed?session=X  body = raw PCM16LE 16kHz 单声道，返回当前累计文本
- POST /v1/stream/reset?session=X 重置某个会话的流状态
"""
import io
import json
import os
import sys
import time
import wave
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(ROOT, "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06")
PORT = int(os.environ.get("PORT", "8000"))
SAMPLE_RATE = 16000
THREADS = int(os.environ.get("THREADS", "4"))

print("sherpa-local-server")
print("  model:", MODEL_DIR)

recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=os.path.join(MODEL_DIR, "tokens.txt"),
    encoder=os.path.join(MODEL_DIR, "encoder.onnx"),
    decoder=os.path.join(MODEL_DIR, "decoder.onnx"),
    joiner=os.path.join(MODEL_DIR, "joiner.onnx"),
    num_threads=THREADS,
    sample_rate=SAMPLE_RATE,
    feature_dim=80,
    decoding_method="greedy_search",
    max_active_paths=4,
    enable_endpoint_detection=True,
    rule1_min_trailing_silence=2.4,
    rule2_min_trailing_silence=1.2,
    rule3_min_utterance_length=20.0,
)
print("  recognizer ready")

_lock = threading.Lock()
_streams = {}   # session -> stream
_stats = {"feeds": 0, "samples": 0, "sessions": set(), "last_text": "", "last_at": 0.0, "prev_text": ""}


def new_stream():
    return recognizer.create_stream()


def feed(stream, samples):
    """喂 float32 音频，解码所有就绪帧，返回当前文本"""
    stream.accept_waveform(SAMPLE_RATE, samples)
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    return recognizer.get_result(stream)


def wav_to_float(data):
    with wave.open(io.BytesIO(data), "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError("only 16-bit PCM supported")
    arr = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if ch == 2:
        arr = arr.reshape(-1, 2).mean(axis=1)
    if sr != SAMPLE_RATE:
        # 线性重采样
        n = int(len(arr) * SAMPLE_RATE / sr)
        xi = np.linspace(0, len(arr) - 1, n)
        arr = np.interp(xi, np.arange(len(arr)), arr).astype(np.float32)
    return arr


def parse_multipart(body, boundary):
    parts = {}
    delim = b"--" + boundary
    idx = body.find(delim)
    while idx != -1:
        start = idx + len(delim)
        if body[start:start + 2] == b"--":
            break
        if body[start:start + 2] == b"\r\n":
            start += 2
        head_end = body.find(b"\r\n\r\n", start)
        if head_end == -1:
            break
        headers = body[start:head_end].decode("utf8", "ignore")
        body_start = head_end + 4
        nxt = body.find(delim, body_start)
        body_end = len(body) if nxt == -1 else max(body_start, nxt - 2)
        name = None
        for line in headers.split("\r\n"):
            if "name=" in line:
                seg = line.split("name=")[1]
                name = seg.split(";")[0].strip().strip('"')
                break
        if name:
            parts[name] = body[body_start:body_end]
        idx = nxt
    return parts


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/health"):
            body = b"ok"
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/v1/models":
            return self._json(200, {"object": "list", "data": [{"id": "sherpa-zipformer-en", "object": "model", "owned_by": "local"}]})
        if path == "/v1/stream/stats":
            with _lock:
                return self._json(200, {
                    "feeds": _stats["feeds"],
                    "seconds": round(_stats["samples"] / SAMPLE_RATE, 1),
                    "sessions": sorted(_stats["sessions"])[-5:],
                    "lastText": _stats["last_text"],
                    "lastAt": _stats["last_at"],
                    "lastRms": round(_stats.get("last_rms", 0.0), 4),
                    "peak": round(_stats.get("peak", 0.0), 3),
                    "clientRms": _stats.get("client_rms", ""),
                    "clientN": _stats.get("client_n", ""),
                    "rmsHist": _stats.get("rms_hist", []),
                })
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        path = u.path
        qs = parse_qs(u.query)
        n = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(n) if n else b""

        try:
            if path in ("/v1/audio/transcriptions", "/audio/transcriptions"):
                ctype = self.headers.get("Content-Type", "")
                boundary = None
                if "boundary=" in ctype:
                    boundary = ctype.split("boundary=")[1].strip().strip('"').encode()
                if not boundary:
                    return self._json(400, {"error": {"message": "need multipart boundary"}})
                parts = parse_multipart(body, boundary)
                if "file" not in parts:
                    return self._json(400, {"error": {"message": "missing file"}})
                t0 = time.time()
                samples = wav_to_float(parts["file"])
                with _lock:
                    st = new_stream()
                    text = feed(st, samples)
                    # 补 0.6 秒静音冲刷尾部
                    text = feed(st, np.zeros(int(SAMPLE_RATE * 0.6), dtype=np.float32))
                ms = int((time.time() - t0) * 1000)
                print(f"[{time.strftime('%H:%M:%S')}] chunk {len(samples)/SAMPLE_RATE:.1f}s -> {ms}ms \"{text[:50]}\"")
                return self._json(200, {"text": text})

            if path == "/v1/stream/feed":
                sid = (qs.get("session") or ["default"])[0]
                samples = np.frombuffer(body, dtype=np.int16).astype(np.float32) / 32768.0
                t0 = time.time()
                with _lock:
                    st = _streams.get(sid)
                    if st is None:
                        st = new_stream()
                        _streams[sid] = st
                    text = feed(st, samples)
                    endpoint = recognizer.is_endpoint(st)
                    if endpoint:
                        recognizer.reset(st)
                ms = int((time.time() - t0) * 1000)

                _stats["feeds"] += 1
                _stats["samples"] += int(len(samples))
                _stats["sessions"].add(sid)
                _stats["last_text"] = text
                _stats["last_at"] = time.time()
                rms = float(np.sqrt((samples ** 2).mean())) if len(samples) else 0.0
                _stats["last_rms"] = rms
                _stats["peak"] = float(np.abs(samples).max()) if len(samples) else 0.0
                _stats["client_rms"] = (qs.get("clientrms") or qs.get("rms") or [""])[0]
                _stats["client_n"] = (qs.get("n") or [""])[0]
                _stats.setdefault("rms_hist", []).append(round(rms, 4))
                _stats["rms_hist"] = _stats["rms_hist"][-20:]
                if text and text != _stats["prev_text"]:
                    _stats["prev_text"] = text
                    print(f"[{time.strftime('%H:%M:%S')}] stream {sid} {_stats['feeds']}次 {ms}ms \"{text[-70:]}\"", flush=True)
                elif _stats["feeds"] % 25 == 0:
                    print(f"[{time.strftime('%H:%M:%S')}] stream {sid} {_stats['feeds']}次 累计 {_stats['samples']/SAMPLE_RATE:.1f}秒 无文本", flush=True)

                return self._json(200, {"text": text, "endpoint": bool(endpoint), "ms": ms})

            if path == "/v1/stream/reset":
                sid = (qs.get("session") or ["default"])[0]
                with _lock:
                    st = _streams.pop(sid, None)
                return self._json(200, {"ok": True})

            self._json(404, {"error": {"message": "not found: " + path}})
        except Exception as e:  # noqa
            self._json(500, {"error": {"message": str(e)}})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ready -> http://127.0.0.1:{PORT}/v1")
    srv.serve_forever()
