#!/usr/bin/env python3
"""A stand-in for the iter8 conversation service's agent routes, for live mod runs.

usage: stub-service.py <home> <scenario.json> <log.jsonl>

Listens at <home>/control.sock (keep <home> short: a Unix socket path is limited to
about 100 bytes). The scenario names the owner, the AgentState body, and the waits:

  {"owner": "O1", "state": {...}, "waits": [{"trigger": "/path", "deliveries": [...]}]}

/agent/wait answers `deliver` with a wait's deliveries once its trigger file exists,
in list order, each wait once; otherwise `timeout` after timeoutSeconds.
"""
import json
import os
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

POLL_SECONDS = 0.1


class Service(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def build_handler(scenario, log_path):
    lock = threading.Lock()
    waits = [{'spec': w, 'taken': False} for w in scenario['waits']]

    def log(entry):
        with lock:
            with open(log_path, 'a') as out:
                out.write(json.dumps(entry) + '\n')

    def take_wait():
        with lock:
            for w in waits:
                if w['taken']:
                    continue
                if os.path.exists(w['spec']['trigger']):
                    w['taken'] = True
                    return w['spec']['deliveries']
                return None
        return None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            pass

        def reply(self, status, body, content_type='application/json'):
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def text_error(self, status, message):
            self.reply(status, message, 'text/plain')

        def owner_ok(self, owner):
            if owner == scenario['owner']:
                return True
            self.text_error(404, 'unknown owner')
            return False

        def handle_request(self, method):
            url = urlsplit(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length).decode() if length else ''
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                body = None
            log({'at': int(time.time() * 1000), 'method': method, 'path': url.path, 'query': query, 'body': body})

            if method == 'GET' and url.path == '/agent/wait':
                self.wait(query)
            elif method == 'GET' and url.path == '/agent/state':
                if self.owner_ok(query.get('owner')):
                    self.reply(200, scenario['state'])
            elif method == 'POST' and url.path == '/agent/transcript':
                self.transcript(body)
            elif method == 'POST' and url.path == '/agent/turn':
                if isinstance(body, dict) and body.get('state') in ('busy', 'idle') and self.owner_ok(body.get('owner')):
                    self.reply(200, {'ok': True})
                elif not isinstance(body, dict) or body.get('state') not in ('busy', 'idle'):
                    self.text_error(400, 'invalid input')
            else:
                self.text_error(404, 'no such route')

        def wait(self, query):
            seconds = query.get('timeoutSeconds', '')
            if not seconds.isdigit() or not 1 <= int(seconds) <= 25:
                return self.text_error(400, 'invalid input')
            if not self.owner_ok(query.get('owner')):
                return
            deadline = time.monotonic() + int(seconds)
            while True:
                deliveries = take_wait()
                if deliveries is not None:
                    return self.reply(200, {'outcome': 'deliver', 'deliveries': deliveries})
                if time.monotonic() >= deadline:
                    return self.reply(200, {'outcome': 'timeout'})
                time.sleep(POLL_SECONDS)

        def transcript(self, body):
            rows = body.get('rows') if isinstance(body, dict) else None
            if not isinstance(rows, list) or not 1 <= len(rows) <= 50:
                return self.text_error(400, 'invalid input')
            if not self.owner_ok(body.get('owner')):
                return
            self.reply(200, {'pageId': None, 'stored': []})

        def do_GET(self):
            self.handle_request('GET')

        def do_POST(self):
            self.handle_request('POST')

    return Handler


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    home, scenario_path, log_path = sys.argv[1:]
    with open(scenario_path) as f:
        scenario = json.load(f)
    sock = os.path.join(home, 'control.sock')
    if len(sock.encode()) >= 100:
        sys.exit('stub-service: socket path is %d bytes; use a shorter home such as /tmp/i8.XXXX' % len(sock.encode()))
    server = Service(sock, build_handler(scenario, log_path))
    os.chmod(sock, 0o600)
    print('listening', sock, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
