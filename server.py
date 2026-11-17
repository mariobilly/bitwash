"""Bitwash - local server (Python standard library only).

Serves the app in static/ and writes what the window exports. Every dither is rendered in the browser (JS + WebGL2),
so the server only handles files: PNG stills as they arrive, source videos kept for their audio, and MP4 exports
made by piping the window's raw RGBA frames into ffmpeg together with the source's audio. Nothing leaves this computer.
"""
import ctypes
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
APP_ID = "bitwash"
APP_NAME = "Bitwash"
PORT = int(os.environ.get("BITWASH_PORT") or 48217)
STATIC = os.path.join(APP_DIR, "static")
SAMPLES = os.path.join(APP_DIR, "samples")
DATA_DIR = os.environ.get("BITWASH_DATA") or os.path.join(os.environ.get("LOCALAPPDATA", APP_DIR), "Bitwash")
SOURCES = os.path.join(DATA_DIR, "sources")
PRESETS = os.path.join(DATA_DIR, "presets.json")
MAX_UPLOAD = 8 * 1024 ** 3
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
# Seconds without a heartbeat before an auto-exit server quits. Chrome slows timers in a minimised window to about
# one a minute, so this must stay well above 60 s.
IDLE_EXIT = 150
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def output_dir():
    """Pictures\\Bitwash in the user folder, or the folder set in the BITWASH_OUT environment variable."""
    env = os.environ.get("BITWASH_OUT")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), "Pictures", APP_NAME)


def find_tool(name):
    exe = shutil.which(name)
    if exe:
        return exe
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\WinGet\Packages")
    if os.path.isdir(root):
        for dirpath, _dirs, files in os.walk(root):
            if name + ".exe" in files:
                return os.path.join(dirpath, name + ".exe")
    return None


def no_throttle(pid=None):
    """Opt a process (default: this one) out of Windows power throttling (EcoQoS).

    Windows quietly slows busy processes that have no window of their own (pythonw, ffmpeg pipes) 8-10x after a few
    seconds; a 14 s clip export went from 62 to about 2 frames a second. Returns True when the setting was applied.
    """
    if os.name != "nt":
        return False
    try:
        from ctypes import wintypes as wt

        class PPT(ctypes.Structure):
            _fields_ = [("Version", wt.ULONG), ("ControlMask", wt.ULONG), ("StateMask", wt.ULONG)]

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetCurrentProcess.restype = wt.HANDLE
        k.OpenProcess.restype = wt.HANDLE
        k.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        k.SetProcessInformation.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
        k.SetProcessInformation.restype = wt.BOOL
        k.CloseHandle.argtypes = [wt.HANDLE]
        h = k.GetCurrentProcess() if pid is None else k.OpenProcess(0x0200 | 0x1000, False, pid)
        if not h:
            return False
        st = PPT(1, 0x1, 0x0)  # execution-speed throttling: controlled by us, and off
        ok = bool(k.SetProcessInformation(h, 4, ctypes.byref(st), ctypes.sizeof(st)))  # 4 = ProcessPowerThrottling
        if pid is not None:
            k.CloseHandle(h)
        return ok
    except Exception:
        return False


def safe_stem(name, fallback="dither"):
    """A file name stem that is safe on Windows: no path parts, no reserved characters, never empty."""
    name = os.path.basename(str(name or "").replace("\\", "/"))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip(" .")
    name = re.sub(r"\s+", " ", name)[:120].strip(" .")
    if name.upper() in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(r"(?i)(COM|LPT)\d", name or ""):
        name = "_" + name
    return name or fallback


def reserve(folder, stem, ext):
    """folder/stem.ext, or 'stem (2).ext'... created at once so two saves never pick the same name or overwrite."""
    os.makedirs(folder, exist_ok=True)
    n = 1
    while True:
        path = os.path.join(folder, f"{stem}.{ext}" if n == 1 else f"{stem} ({n}).{ext}")
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return path
        except FileExistsError:
            n += 1


def probe(path, ffprobe=None):
    """Size, fps, duration and audio of a media file (None values when ffprobe is missing or fails)."""
    ffprobe = ffprobe or find_tool("ffprobe")
    info = {"width": None, "height": None, "fps": None, "duration": None, "frames": None, "audio": False}
    if not ffprobe:
        return info
    r = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                        "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames",
                        "-of", "json", path], capture_output=True, text=True, creationflags=NO_WINDOW)
    try:
        data = json.loads(r.stdout or "{}")
    except ValueError:
        return info
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    info["audio"] = any(s.get("codec_type") == "audio" for s in streams)
    try:
        info["duration"] = round(float(data.get("format", {}).get("duration")), 3)
    except (TypeError, ValueError):
        pass
    if v:
        info["width"], info["height"], info["codec"] = v.get("width"), v.get("height"), v.get("codec_name")
        for key in ("avg_frame_rate", "r_frame_rate"):
            try:
                a, b = (v.get(key) or "0/0").split("/")
                if float(b) > 0 and float(a) > 0:
                    info["fps"] = round(float(a) / float(b), 3)
                    break
            except ValueError:
                pass
        try:
            info["frames"] = int(v.get("nb_frames"))
        except (TypeError, ValueError):
            if info["fps"] and info["duration"]:
                info["frames"] = int(round(info["fps"] * info["duration"]))
    return info


class Export:
    """An ffmpeg process fed raw RGBA frames by the window (one POST per frame), muxed with the source's audio."""

    def __init__(self, ffmpeg, w, h, fps, frames, name, audio=None, start=0.0):
        self.w, self.h, self.fps, self.frames = int(w), int(h), float(fps), int(frames)
        if not (16 <= self.w <= 8192 and 16 <= self.h <= 8192):
            raise ValueError("frame size out of range")
        if not (1 <= self.fps <= 120) or not (1 <= self.frames <= 200000):
            raise ValueError("bad fps or frame count")
        self.duration = self.frames / self.fps
        self.final = reserve(output_dir(), safe_stem(name), "mp4")
        self.tmp = self.final[:-4] + ".part.mp4"
        self.errlog = os.path.join(DATA_DIR, "ffmpeg-export.log")
        self.received = 0
        self.id = uuid.uuid4().hex[:12]
        self.lock = threading.Lock()
        self.touched = time.time()
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{self.w}x{self.h}", "-r", f"{self.fps:g}", "-i", "-"]
        if audio:
            cmd += ["-ss", f"{max(0.0, float(start)):.3f}", "-i", audio]
        cmd += ["-map", "0:v"]
        if audio:
            cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
        # H.264 4:2:0 needs even sizes: drop the odd last row/column rather than resample the crisp cells
        cmd += ["-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0",
                "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", "-t", f"{self.duration:.3f}", "-f", "mp4", self.tmp]
        self.err = open(self.errlog, "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=self.err,
                                     creationflags=NO_WINDOW)
        no_throttle(self.proc.pid)

    def write(self, data):
        if len(data) != self.w * self.h * 4:
            raise ValueError(f"frame has {len(data)} bytes, expected {self.w * self.h * 4}")
        with self.lock:
            self.touched = time.time()
            if self.proc.poll() is not None:
                raise RuntimeError("ffmpeg stopped: " + self.error_text())
            self.proc.stdin.write(data)
            self.received += 1

    def error_text(self):
        try:
            self.err.flush()
            with open(self.errlog, encoding="utf-8", errors="replace") as fh:
                return fh.read()[-600:].strip()
        except OSError:
            return ""

    def finish(self):
        with self.lock:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            code = self.proc.wait(timeout=900)
            self.err.close()
        if code != 0 or not os.path.exists(self.tmp):
            self._cleanup()
            raise RuntimeError("ffmpeg failed: " + self.error_text())
        os.replace(self.tmp, self.final)
        return {"path": self.final, "frames": self.received, **probe(self.final)}

    def cancel(self):
        with self.lock:
            for step in (self.proc.kill, self.proc.stdin.close):
                try:
                    step()
                except OSError:
                    pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            self.err.close()
        self._cleanup()

    def _cleanup(self):
        for p in (self.tmp, self.final):
            try:
                if os.path.exists(p) and (p == self.tmp or os.path.getsize(p) == 0):
                    os.remove(p)
            except OSError:
                pass


class Decoder:
    """ffmpeg decoding a source in order at the export frame rate, already scaled down to the dither grid.

    Seeking a <video> frame by frame is slow on phone and social-media clips (keyframes seconds apart) and is not
    frame-exact on variable frame rate video; reading the frames in order from ffmpeg is both fast and exact.
    """

    def __init__(self, ffmpeg, src, w, h, fps):
        self.w, self.h, fps = int(w), int(h), float(fps)
        if not (1 <= self.w <= 8192 and 1 <= self.h <= 8192 and 1 <= fps <= 120):
            raise ValueError("bad decode size or fps")
        self.size = self.w * self.h * 4
        self.id = uuid.uuid4().hex[:12]
        self.lock = threading.Lock()
        self.touched = time.time()
        self.count = 0
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v:0", "-an", "-sn",
               "-vf", f"fps={fps:g},scale={self.w}:{self.h}:flags=area,format=rgba",
               "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     creationflags=NO_WINDOW, bufsize=0)
        no_throttle(self.proc.pid)

    def next(self):
        """The next frame as RGBA bytes, or None at the end of the video."""
        with self.lock:
            self.touched = time.time()
            chunks, left = [], self.size
            while left > 0:
                c = self.proc.stdout.read(left)
                if not c:
                    return None
                chunks.append(c)
                left -= len(c)
            self.count += 1
            return b"".join(chunks)

    def close(self):
        try:
            self.proc.kill()
        except OSError:
            pass
        try:
            self.proc.stdout.close()
            self.proc.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass


def log(*parts):
    """One line in DATA_DIR/server.log."""
    line = time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(os.path.join(DATA_DIR, "server.log"), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


class State:
    last_beat = time.time()
    beaten = False
    busy = 0
    lock = threading.Lock()
    exports = {}
    decoders = {}


def load_presets():
    try:
        with open(PRESETS, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


class Handler(BaseHTTPRequestHandler):
    server_version = "Bitwash/1.0"
    # Keep-alive: a video export makes two requests per frame. With HTTP/1.0 every one of them was a new TCP
    # connection, and after a few hundred Chrome's requests started failing at random ("Failed to fetch").
    protocol_version = "HTTP/1.1"
    timeout = 300  # an idle kept-alive connection is dropped after this many seconds

    def log_message(self, fmt, *args):  # keep the console and log quiet
        pass

    def log_error(self, fmt, *args):  # protocol errors (bad requests, timeouts) are worth keeping
        log("http error:", self.address_string(), fmt % args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, full, ctype=None):
        size = os.path.getsize(full)
        ctype = ctype or mimetypes.guess_type(full)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        m = rng and re.match(r"bytes=(\d*)-(\d*)", rng)
        if m and (m.group(1) or m.group(2)):  # videos seek with range requests
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(full, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = fh.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (ConnectionError, OSError):
                self.close_connection = True  # the video element cancels range requests all the time

    def drain(self):
        """Read whatever is left of the request body, so the next request on this kept-alive connection starts clean."""
        if getattr(self, "consumed", True):
            return
        self.consumed = True
        n = int(self.headers.get("Content-Length") or 0)
        if n > 64 * 1024 ** 2:  # not worth reading: just close this connection
            self.close_connection = True
            return
        while n > 0:
            c = self.rfile.read(min(n, 1 << 20))
            if not c:
                break
            n -= len(c)

    def read_body(self, limit=MAX_UPLOAD):
        self.consumed = True
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            raise ValueError("empty or too large")
        chunks, left = [], n
        while left > 0:
            c = self.rfile.read(min(left, 1 << 20))
            if not c:
                raise ValueError("connection closed during upload")
            chunks.append(c)
            left -= len(c)
        return b"".join(chunks)

    def read_json(self):
        return json.loads(self.read_body(1 << 20) or b"{}")

    # ---- routes --------------------------------------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/api/ping":
            return self.send_json({"app": APP_ID, "ffmpeg": bool(self.server.ffmpeg), "outDir": output_dir()})
        if path == "/api/presets":
            return self.send_json(load_presets())
        if path == "/api/samples":
            names = sorted(n for n in os.listdir(SAMPLES) if n.lower().endswith((".jpg", ".jpeg", ".png"))) \
                if os.path.isdir(SAMPLES) else []
            return self.send_json(names)
        if path.startswith("/samples/"):
            return self.serve_from(SAMPLES, path[len("/samples/"):])
        if path.startswith("/source/"):
            return self.serve_from(SOURCES, path[len("/source/"):])
        return self.serve_from(STATIC, path.lstrip("/") or "index.html")

    def serve_from(self, root, rel):
        full = os.path.normpath(os.path.join(root, rel))
        if not full.startswith(os.path.normpath(root) + os.sep) or not os.path.isfile(full):
            return self.send_error(HTTPStatus.NOT_FOUND)
        return self.send_file(full)

    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        self.consumed = not int(self.headers.get("Content-Length") or 0)
        try:
            with State.lock:
                State.busy += 1
            if url.path == "/api/heartbeat":
                State.last_beat, State.beaten = time.time(), True
                return self.send_json({"ok": True})
            if url.path == "/api/save":
                return self.save(q)
            if url.path == "/api/source":
                return self.upload_source(q)
            if url.path == "/api/proxy":
                return self.make_proxy(self.read_json())
            if url.path == "/api/presets":
                return self.save_presets(self.read_json())
            if url.path == "/api/export/start":
                return self.export_start(self.read_json())
            m = re.fullmatch(r"/api/export/(frame|finish|cancel)/([0-9a-f]{12})", url.path)
            if m:
                return self.export_step(m.group(1), m.group(2))
            if url.path == "/api/decode/start":
                return self.decode_start(self.read_json())
            m = re.fullmatch(r"/api/decode/(next|close)/([0-9a-f]{12})", url.path)
            if m:
                return self.decode_step(m.group(1), m.group(2))
            if url.path == "/api/reveal-dir":
                os.makedirs(output_dir(), exist_ok=True)
                subprocess.Popen(["explorer", os.path.normpath(output_dir())])
                return self.send_json({"ok": True})
            if url.path == "/api/reveal":
                path = os.path.normpath(str(self.read_json().get("path", "")))
                out = os.path.normpath(output_dir())
                if not path.startswith(out + os.sep) or not os.path.exists(path):
                    return self.send_json({"error": "not an export of this app"}, 400)
                subprocess.Popen(["explorer", "/select,", path])
                return self.send_json({"ok": True})
            return self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            log("400", url.path, repr(e))
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 - report every failure to the window
            log("500", url.path, traceback.format_exc())
            return self.send_json({"error": str(e)}, 500)
        finally:
            with State.lock:
                State.busy -= 1
            try:
                self.drain()
            except OSError:
                self.close_connection = True

    def save(self, q):
        ext = (q.get("ext") or "png").lower().lstrip(".")
        if ext == "jpeg":
            ext = "jpg"
        if ext not in {"png", "jpg", "json", "gpl", "hex"}:
            raise ValueError(f"unsupported file type: {ext}")
        data = self.read_body(512 * 1024 ** 2)
        path = reserve(output_dir(), safe_stem(q.get("name")), ext)
        with open(path, "wb") as fh:
            fh.write(data)
        return self.send_json({"path": path, "bytes": len(data)})

    def upload_source(self, q):
        """Keeps a copy of an opened video so the export can take its audio (and make a proxy if Chrome can't play it)."""
        name = os.path.basename(str(q.get("name") or "video.mp4"))
        ext = os.path.splitext(name)[1].lower()
        if ext not in VIDEO_EXTS:
            raise ValueError(f"not a video file: {name}")
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_UPLOAD:
            raise ValueError("empty or too large")
        self.consumed = True
        os.makedirs(SOURCES, exist_ok=True)
        self.prune_sources()
        sid = uuid.uuid4().hex[:12]
        path = os.path.join(SOURCES, sid + ext)
        try:
            with open(path, "wb") as fh:  # stream to disk: phone videos can be gigabytes
                left = n
                while left > 0:
                    c = self.rfile.read(min(left, 1 << 20))
                    if not c:
                        raise ValueError("connection closed during upload")
                    fh.write(c)
                    left -= len(c)
        except Exception:
            try:
                os.remove(path)
            except OSError:
                pass
            raise
        return self.send_json({"id": sid + ext, "url": f"/source/{sid}{ext}", **probe(path, self.server.ffprobe)})

    @staticmethod
    def prune_sources(keep_hours=24):
        cutoff = time.time() - keep_hours * 3600
        for n in os.listdir(SOURCES):
            p = os.path.join(SOURCES, n)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass

    def source_path(self, sid):
        sid = os.path.basename(str(sid or ""))
        path = os.path.join(SOURCES, sid)
        if not sid or not os.path.isfile(path):
            raise ValueError("source video not found (open it again)")
        return path

    def make_proxy(self, data):
        """H.264 copy of a video Chrome cannot decode (HEVC .mov from phones, ProRes...)."""
        if not self.server.ffmpeg:
            raise ValueError("this video needs ffmpeg, which was not found")
        src = self.source_path(data.get("id"))
        dst = os.path.splitext(src)[0] + ".proxy.mp4"
        if not os.path.exists(dst):
            r = subprocess.run([self.server.ffmpeg, "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
                                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dst],
                               capture_output=True, text=True, creationflags=NO_WINDOW)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or "ffmpeg failed").strip()[-600:])
        name = os.path.basename(dst)
        return self.send_json({"id": name, "url": f"/source/{name}", **probe(dst, self.server.ffprobe)})

    def save_presets(self, data):
        if not isinstance(data, list) or len(data) > 500:
            raise ValueError("presets must be a list")
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = PRESETS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
        os.replace(tmp, PRESETS)
        return self.send_json({"ok": True, "count": len(data)})

    def export_start(self, data):
        if not self.server.ffmpeg:
            raise ValueError("MP4 export needs ffmpeg, which was not found")
        audio = None
        if data.get("source") and data.get("audio", True):
            audio = self.source_path(data["source"])
            if not probe(audio, self.server.ffprobe)["audio"]:
                audio = None
        job = Export(self.server.ffmpeg, data.get("width"), data.get("height"), data.get("fps"), data.get("frames"),
                     data.get("name"), audio, data.get("start", 0))
        with State.lock:
            State.exports[job.id] = job
        return self.send_json({"id": job.id, "path": job.final, "audio": bool(audio)})

    def decode_start(self, data):
        if not self.server.ffmpeg:
            raise ValueError("video export needs ffmpeg, which was not found")
        dec = Decoder(self.server.ffmpeg, self.source_path(data.get("source")), data.get("width"), data.get("height"),
                      data.get("fps"))
        with State.lock:
            for old in [d for d in State.decoders.values() if time.time() - d.touched > 600]:  # abandoned ones
                State.decoders.pop(old.id, None)
                old.close()
            State.decoders[dec.id] = dec
        return self.send_json({"id": dec.id, "width": dec.w, "height": dec.h})

    def decode_step(self, step, did):
        dec = State.decoders.get(did)
        if not dec:
            raise ValueError("decoder not found")
        if step == "next":
            frame = dec.next()
            if frame is not None:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(frame)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(frame)
                return
            self.send_response(204)  # end of the video
            self.send_header("Content-Length", "0")
            self.end_headers()
        with State.lock:
            State.decoders.pop(did, None)
        dec.close()
        if step == "close":
            return self.send_json({"ok": True, "frames": dec.count})

    def export_step(self, step, jid):
        job = State.exports.get(jid)
        if not job:
            raise ValueError("export not found")
        if step == "frame":
            job.write(self.read_body(8192 * 8192 * 4))
            return self.send_json({"received": job.received})
        with State.lock:
            State.exports.pop(jid, None)
        if step == "cancel":
            job.cancel()
            return self.send_json({"ok": True})
        return self.send_json(job.finish())


class ExclusiveServer(ThreadingHTTPServer):
    request_queue_size = 64
    # On Windows SO_REUSEADDR lets a second server bind a port that another app already listens on, silently
    # splitting its traffic. Bind exclusively instead, so a taken port fails loudly.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server(port=PORT):
    os.makedirs(DATA_DIR, exist_ok=True)
    srv = ExclusiveServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    srv.ffmpeg = find_tool("ffmpeg")
    srv.ffprobe = find_tool("ffprobe")
    return srv


def serve(auto_exit=False, port=PORT):
    no_throttle()  # the launcher runs this server windowless (pythonw): keep Windows from slowing it down
    srv = make_server(port)
    if auto_exit:  # started by the Desktop launcher: quit a little after the window closes
        def watchdog():
            while True:
                time.sleep(2)
                idle = time.time() - State.last_beat
                if State.beaten and idle > IDLE_EXIT and State.busy == 0 and not State.exports:
                    srv.shutdown()
                    return
                if not State.beaten and idle > 120:  # the window never opened
                    srv.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()
    print(f"{APP_NAME} on http://127.0.0.1:{port}/  ->  saving to {output_dir()}")
    srv.serve_forever()


if __name__ == "__main__":
    if sys.stdout is None or sys.stderr is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        sys.stdout = sys.stderr = open(os.path.join(DATA_DIR, "app.log"), "a", buffering=1, encoding="utf-8")
    serve(auto_exit="--auto-exit" in sys.argv)
