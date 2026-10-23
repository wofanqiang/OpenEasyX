"""A tiny persistent fetcher that speaks a real Chrome TLS fingerprint.

Live CDNs increasingly gate on the client's TLS fingerprint rather than on headers or cookies:
CamSoda's edge answers 403 to ffmpeg's OpenSSL stack for the very same URL that answers 200
through curl_cffi's Chrome impersonation (measured: playlist *and* segments, headers identical).
ffmpeg cannot impersonate, so the app's HLS proxy forwards those fetches here.

One process serves every request: spawning Python per segment would cost more than the segment
itself on a single-core host. The protocol is deliberately plain -- POST a JSON {url, headers},
get the upstream status, a few headers, and the body streamed back in chunks -- so the Node side
is a thin `fetch` shim and nothing else has to know this exists.

Run by server/tls-fingerprint.ts; not an entry point.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from curl_cffi import requests

# Headers the caller (the HLS proxy) needs to make its own decisions with. content-length is
# deliberately absent: the body goes back chunked, and a length header beside a chunked stream
# makes strict clients (undici) reject the whole response.
PASSTHROUGH_HEADERS = ("content-type", "content-range", "accept-ranges")
CHUNK = 65536


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            url = payload["url"]
            headers = payload.get("headers") or {}
            if not isinstance(url, str) or not isinstance(headers, dict):
                raise ValueError("url must be a string and headers an object")
        except Exception:
            self.send_error(400, "malformed fetch request")
            return

        try:
            upstream = requests.get(
                url, headers=headers, impersonate="chrome",
                timeout=(10, 60), stream=True, allow_redirects=True,
            )
        except Exception as error:  # unreachable, TLS failure, timeout
            body = json.dumps({"error": str(error)}).encode()
            self.send_response(502)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(upstream.status_code)
        for name in PASSTHROUGH_HEADERS:
            value = upstream.headers.get(name)
            if value:
                self.send_header(name, value)
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        try:
            for chunk in upstream.iter_content(chunk_size=CHUNK):
                if not chunk:
                    continue
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        except Exception:
            # The client went away mid-stream; the connection is done for either way.
            self.close_connection = True

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # The port is the whole handshake: the parent reads this one line and never needs anything else.
    print("PORT", server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
