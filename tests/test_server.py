"""Server tests: python -m unittest discover -s tests  (needs ffmpeg/ffprobe on PATH for the video tests)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

TMP = tempfile.mkdtemp(prefix="bitwash-test-")
os.environ["BITWASH_OUT"] = os.path.join(TMP, "out")
os.environ["BITWASH_DATA"] = os.path.join(TMP, "data")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

FFMPEG = shutil.which("ffmpeg")


def make_clip(path, seconds=1, fps=12, w=64, h=48, audio=True):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r={fps}:d={seconds}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", path]
    subprocess.run(cmd, check=True)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.make_server(0)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        shutil.rmtree(TMP, ignore_errors=True)

    def req(self, path, data=None, method=None, headers=None):
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
            headers = {"Content-Type": "application/json", **(headers or {})}
        r = urllib.request.Request(self.base + path, data=data, method=method or ("POST" if data is not None else "GET"),
                                   headers=headers or {})
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                body = resp.read()
                return resp.status, body, resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def jreq(self, *a, **k):
        status, body, _ = self.req(*a, **k)
        return status, json.loads(body)

    def test_ping_and_static(self):
        status, j = self.jreq("/api/ping")
        self.assertEqual((status, j["app"]), (200, "bitwash"))
        status, body, h = self.req("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Bitwash", body)
        self.assertEqual(self.req("/core.js")[2]["Content-Type"], "text/javascript")

    def test_no_path_escape(self):
        for p in ("/../server.py", "/%2e%2e/server.py", "/samples/../server.py", "/source/../presets.json"):
            self.assertEqual(self.req(p)[0], 404, p)

    def test_samples_listed_and_served(self):
        status, names = self.jreq("/api/samples")
        self.assertEqual(status, 200)
        self.assertTrue(names and all(n.endswith(".jpg") for n in names))
        self.assertEqual(self.req("/samples/" + names[0])[0], 200)

    def test_save_png_never_overwrites_and_cleans_names(self):
        png = b"\x89PNG\r\n\x1a\nfake"
        _, a = self.jreq("/api/save?ext=png&name=" + urllib.request.quote('my:look/..\\"x"'), data=png)
        _, b = self.jreq("/api/save?ext=png&name=" + urllib.request.quote('my:look/..\\"x"'), data=png)
        self.assertNotEqual(a["path"], b["path"])
        for r in (a, b):
            self.assertTrue(os.path.dirname(r["path"]) == os.environ["BITWASH_OUT"])
            self.assertTrue(os.path.basename(r["path"]).startswith("x"))
        status, j = self.jreq("/api/save?ext=exe&name=evil", data=b"MZ")
        self.assertEqual(status, 400)

    def test_presets_round_trip(self):
        items = [{"type": "preset", "name": "A", "params": {"scale": 4}}, {"type": "palette", "name": "P", "colors": ["#000000", "#FFFFFF"]}]
        self.assertEqual(self.jreq("/api/presets", data=items)[0], 200)
        self.assertEqual(self.jreq("/api/presets")[1], items)
        self.assertEqual(self.jreq("/api/presets", data={"not": "a list"})[0], 400)

    def test_range_requests_for_video_seeking(self):
        os.makedirs(server.SOURCES, exist_ok=True)
        with open(os.path.join(server.SOURCES, "bytes.mp4"), "wb") as fh:
            fh.write(bytes(range(256)) * 4)
        status, body, h = self.req("/source/bytes.mp4", headers={"Range": "bytes=10-19"})
        self.assertEqual(status, 206)
        self.assertEqual(body, bytes(range(10, 20)))
        self.assertEqual(h["Content-Range"], "bytes 10-19/1024")
        status, body, _ = self.req("/source/bytes.mp4", headers={"Range": "bytes=-4"})
        self.assertEqual((status, body), (206, bytes(range(252, 256))))

    def test_keep_alive_survives_unread_bodies(self):
        # one connection, many requests, some with bodies the handler never reads (cancel/heartbeat/errors)
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.srv.server_address[1], timeout=10)
        for i in range(30):
            c.request("POST", "/api/heartbeat", body=b'{"pad": "' + b"x" * (i * 37) + b'"}')
            r = c.getresponse()
            self.assertEqual((r.status, json.loads(r.read())), (200, {"ok": True}))
            c.request("POST", "/api/save?ext=exe&name=x", body=b"MZ" * 500)  # rejected before the body is read
            r = c.getresponse()
            self.assertEqual(r.status, 400)
            r.read()
            c.request("GET", "/api/ping")
            r = c.getresponse()
            self.assertEqual(json.loads(r.read())["app"], "bitwash")
        c.close()

    def test_exclusive_bind_refuses_a_taken_port(self):
        port = self.srv.server_address[1]
        with self.assertRaises(OSError):
            server.make_server(port)

    @unittest.skipUnless(FFMPEG, "needs ffmpeg")
    def test_upload_probe_and_export_with_audio(self):
        clip = os.path.join(TMP, "clip.mp4")
        make_clip(clip, seconds=1, fps=12, w=64, h=48)
        with open(clip, "rb") as fh:
            status, src = self.jreq("/api/source?name=clip.mp4", data=fh.read())
        self.assertEqual(status, 200, src)
        self.assertEqual((src["width"], src["height"], src["fps"], src["frames"], src["audio"]), (64, 48, 12.0, 12, True))
        # odd sizes are fine: the export crops to even for H.264
        w, h, n = 101, 75, 12
        status, job = self.jreq("/api/export/start", data={"width": w, "height": h, "fps": 12, "frames": n, "name": "t",
                                                           "source": src["id"], "audio": True})
        self.assertEqual(status, 200, job)
        self.assertTrue(job["audio"])
        for i in range(n):
            frame = bytes([i * 20 % 256, 0, 255 - i * 20 % 256, 255]) * (w * h)
            self.assertEqual(self.req(f"/api/export/frame/{job['id']}", data=frame)[0], 200)
        status, res = self.jreq(f"/api/export/finish/{job['id']}", data={})
        self.assertEqual(status, 200, res)
        self.assertEqual((res["width"], res["height"], res["frames"], res["audio"]), (100, 74, n, True))
        self.assertAlmostEqual(res["duration"], 1.0, delta=0.1)
        self.assertFalse(os.path.exists(res["path"][:-4] + ".part.mp4"))

    @unittest.skipUnless(FFMPEG, "needs ffmpeg")
    def test_wrong_frame_size_and_cancel(self):
        status, job = self.jreq("/api/export/start", data={"width": 32, "height": 32, "fps": 10, "frames": 5, "name": "c"})
        self.assertEqual(status, 200, job)
        self.assertEqual(self.jreq(f"/api/export/frame/{job['id']}", data=b"\0" * 100)[0], 400)
        self.assertEqual(self.jreq(f"/api/export/cancel/{job['id']}", data={})[0], 200)
        self.assertFalse(os.path.exists(job["path"]), "a cancelled export leaves no empty file behind")

    @unittest.skipUnless(FFMPEG, "needs ffmpeg")
    def test_proxy_for_videos_chrome_cannot_play(self):
        mov = os.path.join(TMP, "p.mov")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=1",
                        "-c:v", "prores_ks", "-profile:v", "0", mov], check=True)
        with open(mov, "rb") as fh:
            _, src = self.jreq("/api/source?name=p.mov", data=fh.read())
        status, proxy = self.jreq("/api/proxy", data={"id": src["id"]})
        self.assertEqual(status, 200, proxy)
        self.assertEqual(proxy["codec"], "h264")
        self.assertEqual(self.req(proxy["url"])[0], 200)

    @unittest.skipUnless(os.name == "nt" and FFMPEG, "Windows power throttling")
    def test_no_throttle_applies_to_self_and_children(self):
        self.assertTrue(server.no_throttle())
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "nullsrc", "-t", "3", "-f", "null", "-"],
                             creationflags=server.NO_WINDOW)
        try:
            self.assertTrue(server.no_throttle(p.pid))
        finally:
            p.kill()
            p.wait()

    def test_rejects_non_videos_and_unknown_sources(self):
        self.assertEqual(self.jreq("/api/source?name=notes.txt", data=b"hello")[0], 400)
        self.assertEqual(self.jreq("/api/proxy", data={"id": "../server.py"})[0], 400)
        self.assertEqual(self.jreq("/api/export/start", data={"width": 32, "height": 32, "fps": 10, "frames": 5,
                                                              "source": "nope.mp4"})[0], 400)


if __name__ == "__main__":
    unittest.main()
