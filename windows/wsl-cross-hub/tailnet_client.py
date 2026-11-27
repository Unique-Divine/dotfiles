"""Call WSL Cross Hub HTTPS with a signed request and verify its response."""

import argparse
import hmac
from http.client import HTTPException, HTTPSConnection
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

import tailnet_api
import worker

MAX_RESPONSE_BYTES = 65536


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Windows Tailscale Serve HTTPS URL")
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("command", choices=("health", "status", "job", *tailnet_api.OPERATIONS))
    parser.add_argument("--job-id")
    args = parser.parse_args()
    url = urlsplit(args.url)
    if (
        url.scheme != "https" or not url.hostname or url.username or url.password
        or url.path not in ("", "/") or url.query or url.fragment
    ):
        parser.error("Use the HTTPS origin of the Windows tailnet endpoint.")
    if args.command in ("health", "status"):
        if args.job_id:
            parser.error("This command does not take a job ID.")
        method = "GET"
        path = "/healthz" if args.command == "health" else "/v1/status"
        job_id = ""
    else:
        try:
            job_id = worker.parse_job_id(args.job_id or "")
        except ValueError as error:
            parser.error(str(error))
        method = "GET" if args.command == "job" else "POST"
        path = tailnet_api.JOB_PREFIX + (job_id if method == "GET" else args.command)
    try:
        token = tailnet_api.read_token(args.token_file)
        headers = tailnet_api.signed_headers(token, method, path, job_id if method == "POST" else "")
        request_mac = headers["Authorization"].rsplit(".", 1)[1]
        conn = HTTPSConnection(url.hostname, url.port, timeout=25)
        try:
            conn.request(method, path, headers=headers)
            response = conn.getresponse()
            body = response.read(MAX_RESPONSE_BYTES + 1)
            signature = response.getheader(tailnet_api.SIGNATURE_HEADER, "")
            expected = tailnet_api.response_signature(token, request_mac, response.status, body)
            if (
                len(body) > MAX_RESPONSE_BYTES or not re.fullmatch(r"[0-9a-f]{64}", signature)
                or not hmac.compare_digest(signature, expected)
            ):
                raise ValueError("WSL Cross Hub did not return an authenticated response.")
            print(json.dumps(json.loads(body)))
            return int(response.status >= 400)
        finally:
            conn.close()
    except (HTTPException, OSError, ValueError) as error:
        parser.exit(1, f"WSL Cross Hub: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
