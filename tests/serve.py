"""Loopback-only, synthetic fixture. Does not connect to YouTube or use browser accounts."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?', 1)[0] == '/watch':
            self.path = '/tests/browser-fixture.html'
        super().do_GET()

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(f'http://127.0.0.1:{server.server_port}/watch?v=testVideo01', flush=True)
server.serve_forever()
