#!/usr/bin/env python3
"""Local static preview on localhost:8000, plus explicitly allowlisted private Pro page fixtures.
No live API, accounts, or Blobs. Never bind this private preview to a public interface.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import json
import re

ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / 'output/guide-import/guofeng-pro-v4'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'flipgame'), **kwargs)
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/__guide-preview/'):
            name = path.removeprefix('/__guide-preview/')
            if name == 'manifest.json':
                pages = sorted(PAGES.glob('page-*.jpg'))
                payload = json.dumps(dict(id='guofeng-pro-v4', title='国风偷学 · Pro 版本攻略', titleEn='Guofeng · Pro Strategy Guide', category='vip', status='published', pages=[p.stem for p in pages], updatedAt='2026-09-07T00:00:00.000Z'), ensure_ascii=False).encode()
                kind = 'application/json'
            elif re.fullmatch(r'page-\d{2}\.jpg', name) and (PAGES/name).is_file():
                payload = (PAGES/name).read_bytes()
                kind = 'image/jpeg'
            else:
                self.send_error(404); return
            self.send_response(200); self.send_header('Content-Type',kind); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload)
            return
        super().do_GET()
if __name__ == '__main__':
    print('Private local preview: http://127.0.0.1:8000/ (no production writes)', flush=True)
    ThreadingHTTPServer(('127.0.0.1',8000),Handler).serve_forever()
