"""Run one interactive shell behind a PTY while speaking pipes to the server.

This deliberately lives outside the ASGI process.  macOS can leave an ASGI
event loop unresponsive when it reads a shell PTY directly after a WebSocket
resize/input event.  The bridge owns that PTY and relays bytes over ordinary
stdin/stdout pipes, which asyncio handles safely.
"""

from __future__ import annotations

import os
import selectors
import signal
import subprocess
import sys


def _command(shell: str) -> list[str]:
    name = os.path.basename(shell).lower()
    return [shell, "-i"] if name in {"sh", "bash", "zsh", "fish", "ksh", "dash"} else [shell]


def _write_all(fd: int, data: bytes) -> None:
    while data:
        try:
            written = os.write(fd, data)
        except BrokenPipeError:
            raise SystemExit(0)
        data = data[written:]


def run(shell: str, root: str) -> int:
    try:
        import pty
    except ImportError:
        return 1

    master_fd, slave_fd = pty.openpty()
    environment = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    environment["TERM"] = "xterm-256color"
    try:
        child = subprocess.Popen(
            _command(shell),
            cwd=root,
            env=environment,
            preexec_fn=lambda: os.login_tty(slave_fd),
        )
    finally:
        os.close(slave_fd)

    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ, "shell")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")
    try:
        while True:
            if child.poll() is not None:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    data = b""
                if data:
                    _write_all(sys.stdout.fileno(), data)
                return child.returncode or 0

            for key, _ in selector.select(timeout=0.25):
                try:
                    data = os.read(key.fd, 4096)
                except OSError:
                    data = b""
                if key.data == "input":
                    if not data:
                        return 0
                    _write_all(master_fd, data)
                elif data:
                    _write_all(sys.stdout.fileno(), data)
    finally:
        selector.close()
        try:
            os.close(master_fd)
        except OSError:
            pass
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python -m src.terminal_bridge SHELL PROJECT_ROOT")
    raise SystemExit(run(sys.argv[1], sys.argv[2]))
