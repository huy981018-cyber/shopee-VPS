from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer
import json, threading, os, time, re, urllib.request, urllib.error, urllib.parse

jobs = {}
results = {}
result_events = {}
lock = threading.Lock()
new_job_event = threading.Event()
counter = [0]
last_heartbeat = [0.0]
affiliate_tab_ok = [None]
pending_commands = []
restart_requested = [False]

SHOPEE_URL_RE = re.compile(r'https?://(?:s\.shopee\.vn|(?:[a-z]+\.)?shp\.ee|(?:www\.)?shopee\.[a-z]+(?:\.[a-z]+)?)[^\s"\']*', re.I)


def is_shopee_url(url):
    return bool(url and SHOPEE_URL_RE.match(url))


def find_shopee_link(text):
    if not text:
        return None
    m = SHOPEE_URL_RE.search(text)
    return m.group(0) if m else None


def resolve_url(url, timeout=12):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl()
            if is_shopee_url(final_url):
                return final_url
            body = resp.read(32768).decode('utf-8', errors='ignore')
            shopee_link = find_shopee_link(body)
            if shopee_link:
                return shopee_link
            meta = re.search(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+content=["\']?(?:\d+;\s*url=)?([^"\'>]+)', body, re.I)
            if meta:
                candidate = urllib.parse.urljoin(final_url, meta.group(1).strip())
                if is_shopee_url(candidate):
                    return candidate
            return final_url if final_url != url else None
    except Exception:
        return None

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

        elif self.path == '/api/command':
            with lock:
                commands = list(pending_commands)
                pending_commands.clear()
            self._json(200, {'commands': commands})

        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        if self.path == '/api/heartbeat':
            last_heartbeat[0] = time.time()
            affiliate_tab_ok[0] = body.get('affiliate_tab')
            self._json(200, {'ok': True})

        elif self.path == '/api/resolve':
            url = body.get('url')
            if not url:
                self._json(400, {'error': 'Missing url'})
                return
            resolved = resolve_url(url)
            self._json(200, {'resolved': resolved})

        elif self.path == '/api/reload-custom-link':
            with lock:
                pending_commands.append({'action': 'reload_custom_link'})
            self._json(200, {'ok': True})

        elif self.path == '/api/command':
            action = body.get('action')
            if action == 'reload_custom_link':
                with lock:
                    pending_commands.append({'action': 'reload_custom_link'})
                self._json(200, {'ok': True})
            else:
                self._json(400, {'error': 'Unsupported action'})

        elif self.path == '/api/restart':
            with lock:
                restart_requested[0] = True
                pending_commands.append({'action': 'restart'})
            self._json(200, {'ok': True})

        elif self.path == '/api/convert':
            urls = body['urls']
            batches = max(1, (len(urls) + 4) // 5)
            timeout = batches * 12  # 12s mỗi batch
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

        elif self.path == '/api/reset':
            with lock:
                for ev in result_events.values():
                    ev.set()
                jobs.clear()
                results.clear()
                result_events.clear()
            self._json(200, {'ok': True})

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


def restart_loop():
    while True:
        time.sleep(1)
        if restart_requested[0]:
            print('Restart requested, exiting in 3 seconds...')
            time.sleep(3)
            os._exit(0)

os.chdir(os.path.dirname(os.path.abspath(__file__)))
ThreadingTCPServer.allow_reuse_address = True
ThreadingTCPServer.daemon_threads = True
threading.Thread(target=cleanup_loop, daemon=True).start()
threading.Thread(target=restart_loop, daemon=True).start()
print('Server running on http://localhost:8080')
ThreadingTCPServer(('0.0.0.0', 8080), Handler).serve_forever()
