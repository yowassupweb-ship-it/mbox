import os
import select
import socket
import socketserver
import sys
import threading

import paramiko


class ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_handler(transport, remote_host, remote_port):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            channel = transport.open_channel(
                "direct-tcpip",
                (remote_host, remote_port),
                self.request.getpeername(),
            )
            if channel is None:
                return

            while True:
                readable, _, _ = select.select([self.request, channel], [], [])
                if self.request in readable:
                    data = self.request.recv(1024)
                    if not data:
                        break
                    channel.send(data)
                if channel in readable:
                    data = channel.recv(1024)
                    if not data:
                        break
                    self.request.send(data)
            channel.close()

    return Handler


def main():
    ssh_host = os.environ.get("MBOX_SSH_HOST")
    ssh_user = os.environ.get("MBOX_SSH_USER", "root")
    ssh_password = os.environ.get("MBOX_SSH_PASSWORD")
    local_host = os.environ.get("MBOX_TUNNEL_HOST", "127.0.0.1")
    local_port = int(os.environ.get("MBOX_TUNNEL_PORT", "15432"))
    remote_host = os.environ.get("MBOX_REMOTE_DB_HOST", "127.0.0.1")
    remote_port = int(os.environ.get("MBOX_REMOTE_DB_PORT", "5432"))

    if not ssh_host or not ssh_password:
        print("MBOX_SSH_HOST and MBOX_SSH_PASSWORD are required", file=sys.stderr)
        return 1

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(ssh_host, username=ssh_user, password=ssh_password, timeout=20, banner_timeout=20, auth_timeout=20)

    server = ForwardServer((local_host, local_port), make_handler(client.get_transport(), remote_host, remote_port))
    thread = threading.Thread(target=server.serve_forever, daemon=False)
    print(f"forwarding {local_host}:{local_port} -> {ssh_host}:{remote_host}:{remote_port}")
    thread.start()
    thread.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
