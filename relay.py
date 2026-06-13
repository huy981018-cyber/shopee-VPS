from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer
import json, threading, os, time, re, urllib.request, urllib.error, urllib.parse
import struct, hashlib, base64, socket, select

jobs = {}
results = {}
result_events = {}
lock = threading.Lock()
new_job_event = threading.Event()
counter = [0]
last_heartbeat = [0.0]
affiliate_tab_ok = [None]
pending_commands = []

# ============================================================
#  WebSocket clients — extension kết nối WebSocket sẽ được
#  giữ persistent → Chrome không terminate service worker
# ============================================================
ws_clients = []
ws_lock = threading.Lock()

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


# ============================================================
#  WebSocket server — xử lý kết nối WebSocket từ extension
# ============================================================

def handle_websocket(conn, addr):
    """Xử lý 1 kết nối WebSocket client"""
    with ws_lock:
        ws_clients.append(conn)
    
    print(f'[ws] Extension connected from {addr}')
    
    # Gửi tin nhắn chào và jobs/commands hiện tại
    ws_send(conn, json.dumps({'type': 'connected', 'ok': True}))
    
    # Push pending commands nếu có
    with lock:
        if pending_commands:
            ws_send(conn, json.dumps({'type': 'commands', 'commands': list(pending_commands)}))
            pending_commands.clear()
        if jobs:
            ws_send(conn, json.dumps({'type': 'jobs', 'jobs': dict(jobs)}))
    
    try:
        while True:
            # Đọc frame WebSocket
            frame = ws_recv(conn)
            if frame is None:
                break
            
            try:
                msg = json.loads(frame)
            except:
                continue
            
            msg_type = msg.get('type')
            
            if msg_type == 'heartbeat':
                # Extension gửi heartbeat
                last_heartbeat[0] = time.time()
                affiliate_tab_ok[0] = msg.get('affiliate_tab')
                ws_send(conn, json.dumps({'type': 'heartbeat_ack'}))
            
            elif msg_type == 'result':
                # Extension trả kết quả convert
                job_id = msg.get('job_id')
                result = msg.get('result')
                if job_id:
                    with lock:
                        results[job_id] = result
                        jobs.pop(job_id, None)
                        ev = result_events.get(job_id)
                    if ev:
                        ev.set()
                    ws_send(conn, json.dumps({'type': 'result_ack', 'job_id': job_id}))
            
            elif msg_type == 'ping':
                ws_send(conn, json.dumps({'type': 'pong'}))
    
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        with ws_lock:
            if conn in ws_clients:
                ws_clients.remove(conn)
        try:
            conn.close()
        except:
            pass
        print(f'[ws] Extension disconnected from {addr}')


def ws_broadcast(data):
    """Gửi dữ liệu tới tất cả WebSocket clients"""
    with ws_lock:
        dead = []
        for conn in ws_clients:
            try:
                ws_send(conn, data)
            except:
                dead.append(conn)
        for conn in dead:
            try:
                conn.close()
            except:
                pass
            ws_clients.remove(conn)


def ws_send(conn, data):
    """Gửi text frame qua WebSocket"""
    if isinstance(data, str):
        data = data.encode('utf-8')
    
    length = len(data)
    header = bytearray()
    header.append(0x81)  # FIN + text opcode
    
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack('>H', length))
    else:
        header.append(127)
        header.extend(struct.pack('>Q', length))
    
    conn.sendall(bytes(header) + data)


def ws_recv(conn):
    """Đọc text frame từ WebSocket (server-side, không mask)"""
    first_byte = conn.recv(1)
    if not first_byte:
        return None
    
    opcode = first_byte[0] & 0x0F
    if opcode == 0x8:  # Close frame
        return None
    if opcode == 0x9:  # Ping
        ws_send_pong(conn)
        return ws_recv(conn)
    if opcode == 0xA:  # Pong
        return ws_recv(conn)
    
    second_byte = conn.recv(1)
    if not second_byte:
        return None
    
    masked = (second_byte[0] & 0x80) != 0
    length = second_byte[0] & 0x7F
    
    if length == 126:
        raw = conn.recv(2)
        length = struct.unpack('>H', raw)[0]
    elif length == 127:
        raw = conn.recv(8)
        length = struct.unpack('>Q', raw)[0]
    
    if masked:
        mask_key = conn.recv(4)
        payload = conn.recv(length)
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    else:
        payload = conn.recv(length)
    
    return payload.decode('utf-8', errors='ignore')


def ws_send_pong(conn):
    """Gửi pong frame"""
    conn.sendall(b'\x8A\x00')


def ws_handshake(conn):
    """Xử lý WebSocket handshake"""
    request = b''
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            return False
        request += chunk
        if b'\r\n\r\n' in request:
            break
    
    request_str = request.decode('utf-8', errors='ignore')
    
    # Tìm WebSocket key
    for line in request_str.split('\r\n'):
        if line.lower().startswith('sec-websocket-key:'):
            key = line.split(':', 1)[1].strip()
            break
    else:
        return False
    
    # Tính accept key
    GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    accept_key = base64.b64encode(
        hashlib.sha1((key + GUID).encode()).digest()
    ).decode()
    
    response = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Accept: ' + accept_key + '\r\n'
        '\r\n'
    )
    conn.sendall(response.encode())
    return True


def websocket_server_thread():
    """Thread chính lắng nghe kết nối WebSocket"""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', 8081))
    server.listen(16)
    server.settimeout(1.0)
    print('[ws] WebSocket server on ws://0.0.0.0:8081')
    
    while True:
        try:
            conn, addr = server.accept()
            if conn:
                t = threading.Thread(target=_handle_ws_connection, args=(conn, addr), daemon=True)
                t.start()
        except socket.timeout:
            continue
        except Exception as e:
            print(f'[ws] Accept error: {e}')


def _handle_ws_connection(conn, addr):
    """Xử lý kết nối WebSocket mới"""
    try:
        if ws_handshake(conn):
            handle_websocket(conn, addr)
    except Exception as e:
        print(f'[ws] Handshake error: {e}')
    finally:
        try:
            conn.close()
        except:
            pass


# ============================================================
#  HTTP handler
# ============================================================

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

        elif self.path == '/api/warmup':
            with lock:
                pending_commands.append({'action': 'warmup'})
            # Cũng broadcast qua WebSocket
            ws_broadcast(json.dumps({'type': 'commands', 'commands': [{'action': 'warmup'}]}))
            self._json(200, {'ok': True, 'message': 'Warmup command sent'})


        elif self.path == '/api/extension-health':
            with lock:
                self._json(200, {
                    'ok': True,
                    'server': True,
                    'jobs_count': len(jobs),
                    'pending_commands': len(pending_commands),
                    'result_events': len(result_events),
                    'last_heartbeat': time.time() - last_heartbeat[0] < 10,
                })

        elif self.path == '/api/health':
            ext_ok = time.time() - last_heartbeat[0] < 10
            with lock:
                pending = len(jobs)
            ws_connected = False
            with ws_lock:
                ws_connected = len(ws_clients) > 0
            self._json(200, {
                'server': True,
                'extension': ext_ok,
                'ws_connected': ws_connected,
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
        raw_body = self.rfile.read(length)
        if length == 0:
            body = {}
        else:
            try:
                body = json.loads(raw_body.decode('utf-8', errors='ignore'))
            except Exception:
                self._json(400, {'error': 'Invalid JSON'})
                return

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
            ws_broadcast(json.dumps({'type': 'commands', 'commands': [{'action': 'reload_custom_link'}]}))
            self._json(200, {'ok': True})

        elif self.path == '/api/fix-extension':
            with lock:
                for ev in result_events.values():
                    ev.set()
                jobs.clear()
                results.clear()
                result_events.clear()
            self._json(200, {'ok': True, 'message': 'Extension state reset'})

        elif self.path == '/api/command':
            action = body.get('action')
            if action == 'reload_custom_link':
                with lock:
                    pending_commands.append({'action': 'reload_custom_link'})
                ws_broadcast(json.dumps({'type': 'commands', 'commands': [{'action': 'reload_custom_link'}]}))
                self._json(200, {'ok': True})
            else:
                self._json(400, {'error': 'Unsupported action'})

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
            # Broadcast job qua WebSocket
            ws_broadcast(json.dumps({'type': 'new_job', 'job_id': job_id, 'urls': urls}))
            ev.wait(timeout=timeout)
            with lock:
                result_data = results.pop(job_id, None)
                result_events.pop(job_id, None)
                jobs.pop(job_id, None)
            self._json(200, result_data if result_data else {'error': 'Timeout'})

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


os.chdir(os.path.dirname(os.path.abspath(__file__)))
ThreadingTCPServer.allow_reuse_address = True
ThreadingTCPServer.daemon_threads = True
threading.Thread(target=cleanup_loop, daemon=True).start()
threading.Thread(target=websocket_server_thread, daemon=True).start()
print('Server running on http://localhost:8080')
print('WebSocket on ws://localhost:8081')
print('Warmup loop disabled — WebSocket keepalive thay thế')
ThreadingTCPServer(('0.0.0.0', 8080), Handler).serve_forever()
