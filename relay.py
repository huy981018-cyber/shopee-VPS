from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer
import json, threading, os, time, urllib.request, subprocess, sys

jobs = {}
results = {}
result_events = {}
lock = threading.Lock()
new_job_event = threading.Event()
counter = [0]
last_heartbeat = [0.0]
affiliate_tab_ok = [None]

class Handler(SimpleHTTPRequestHandler):
    def send_head(self):
        if 'If-Modified-Since' in self.headers:
            del self.headers['If-Modified-Since']
        return super().send_head()

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/ping':
            self._json(200, {'ok': True})

        elif self.path == '/api/health':
            ext_ok = time.time() - last_heartbeat[0] < 10
            with lock:
                pending = len(jobs)
            self._json(200, {
                'server': True,
                'extension': ext_ok,
                'affiliate_tab': affiliate_tab_ok[0],
                'pending_jobs': pending,
            })

        elif 'apple-touch-icon' in self.path or 'favicon' in self.path:
            self.send_response(204)
            self._cors()
            self.end_headers()

        elif self.path.startswith('/api/jobs'):
            deadline = time.time() + 25
            while True:
                with lock:
                    snapshot = dict(jobs) if jobs else None
                if snapshot:
                    self._json(200, snapshot)
                    return
                remaining = deadline - time.time()
                if remaining <= 0:
                    self._json(200, {})
                    return
                new_job_event.wait(timeout=min(remaining, 1.0))
                new_job_event.clear()

        elif self.path == '/' or self.path == '/index.html':
            self.path = '/index.html'
            super().do_GET()

        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        if self.path == '/api/heartbeat':
            last_heartbeat[0] = time.time()
            affiliate_tab_ok[0] = body.get('affiliate_tab')
            self._json(200, {'ok': True})

        elif self.path == '/api/convert':
            urls = body['urls']
            batches = max(1, (len(urls) + 4) // 5)
            timeout = batches * 12
            with lock:
                counter[0] += 1
                job_id = str(counter[0])
                jobs[job_id] = {'urls': urls, 'ts': time.time()}
                ev = threading.Event()
                result_events[job_id] = ev
            new_job_event.set()
            ev.wait(timeout=timeout)
            with lock:
                result = results.pop(job_id, None)
                result_events.pop(job_id, None)
                jobs.pop(job_id, None)
            self._json(200, result if result else {'error': 'Timeout'})

        elif self.path.startswith('/api/result/'):
            job_id = self.path.split('/')[-1]
            with lock:
                results[job_id] = body
                jobs.pop(job_id, None)
                ev = result_events.get(job_id)
            if ev:
                ev.set()
            self._json(200, {'ok': True})

        elif self.path == '/api/resolve':
            url = body.get('url', '')
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}, method='HEAD')
                with urllib.request.urlopen(req, timeout=10) as resp:
                    resolved = resp.url
            except Exception as e:
                self._json(200, {'error': str(e)})
                return
            self._json(200, {'resolved': resolved})

        elif self.path == '/api/reset':
            with lock:
                for ev in result_events.values():
                    ev.set()
                jobs.clear()
                results.clear()
                result_events.clear()
            self._json(200, {'ok': True})

        elif self.path == '/api/reload-custom-link':
            try:
                subprocess.run(['xdotool', 'search', '--name', 'custom_link', 'key', 'F5'], 
                               timeout=5, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
                self._json(200, {'ok': True, 'message': 'Reload custom_link thành công'})
            except Exception as e:
                self._json(200, {'ok': False, 'error': str(e)})

        elif self.path == '/api/restart':
            try:
                self._json(200, {'ok': True, 'message': 'Server sẽ restart...'})
                threading.Timer(0.5, lambda: os.execv(sys.executable, [sys.executable] + sys.argv)).start()
            except Exception as e:
                self._json(200, {'ok': False, 'error': str(e)})

    def send_response(self, code, message=None):
        super().send_response(code, message)
        self.send_header('Cache-Control', 'no-store')

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, code, data):
        try:
            body = json.dumps(data).encode()
            self.send_response(code)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def handle_error(self, request, client_address):
        pass

    def log_message(self, *args): pass

def cleanup_loop():
    while True:
        time.sleep(5)
        now = time.time()
        with lock:
            stale = [jid for jid, j in jobs.items()
                     if isinstance(j, dict) and now - j.get('ts', now) > 10]
            for jid in stale:
                jobs.pop(jid, None)
                ev = result_events.pop(jid, None)
                if ev:
                    ev.set()

os.chdir(os.path.dirname(os.path.abspath(__file__)))
ThreadingTCPServer.allow_reuse_address = True
ThreadingTCPServer.daemon_threads = True
threading.Thread(target=cleanup_loop, daemon=True).start()
print('Server running on http://0.0.0.0:8080')
ThreadingTCPServer(('0.0.0.0', 8080), Handler).serve_forever()
