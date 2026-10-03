"""Drive the faux rerun demo through a real POSIX controlling terminal."""

import errno
import os
from pathlib import Path
import pty
import re
import select
import signal
import sys
import tempfile
import time


root = Path(__file__).resolve().parents[1]
log = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / "yo-rerun-pty.log"
pid, master = pty.fork()
if pid == 0:
    os.chdir(root)
    os.execvp("node", ["node", "examples/run-rerun-demo.ts", "--tty"])

raw = bytearray()
cursor = 0
status = None


def output():
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw.decode("utf-8", errors="replace")).replace("\r", "")


def read_chunk(timeout):
    if not select.select([master], [], [], timeout)[0]:
        return True
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    raw.extend(chunk)
    return bool(chunk)


def expect(marker):
    global cursor
    deadline = time.monotonic() + 15
    while True:
        text = output()
        found = text.find(marker, cursor)
        if found >= 0:
            cursor = found + len(marker)
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not read_chunk(min(remaining, 1)):
            raise AssertionError(f"Missing terminal marker after offset {cursor}: {marker!r}")


def send(value):
    encoded = value.encode("utf-8")
    while encoded:
        encoded = encoded[os.write(master, encoded):]


def command(value, marker=None):
    send(value + "\r")
    if marker is not None:
        expect(marker)
    expect("yo> ")


try:
    assert os.isatty(master)
    expect("Temporary fixture is removed on exit.")
    expect("yo> ")
    assert os.tcgetpgrp(master) == pid
    send("  Read and patch answer.ts  \r")
    expect("[SOURCE_REVIEW: Ctrl+C]")
    send("\x03")
    expect("Run #1 result: cancelled")
    expect("Stop reason: aborted")
    expect("yo> ")
    print("PTY: Ctrl+C byte cancelled source review; fresh chat prompt recovered.")
    command("/run 1", "Run #1:")
    command("Correction: keep the marker; use current answer.ts.", "Run #2 result:")
    send("/rerun 1\r /rerun\t1 \r")
    expect("[RERUN_READ_WAIT: enter /rerun  1 now; the line stays buffered]")
    send(" /rerun  1\r")
    expect("Run #3 result:")
    expect("Rerun action already accepted as Run #3.")
    expect("Rerun action already accepted as Run #3.")
    expect("yo> ")
    print("PTY: normalized batch and active-work duplicates drained as two Run #3 receipts.")
    command("/run 1", "Run #1:")
    command("/run 3", "Run #3:")
    send("/rerun 1\r")
    expect("[FRESH_REVIEW_DENY: enter /rerun 1]")
    send("/rerun 1\r")
    expect("Run #4 result:")
    expect("yo> ")
    command("/run 1", "Run #1:")
    send("/rerun 1\r")
    expect("[FRESH_REVIEW_APPROVE: enter yes]")
    send("yes\r")
    expect("Run #5 result:")
    expect("yo> ")
    print("PTY: fresh prompts allocated Runs #4/#5; command-like denial stayed approval input; new yes applied.")
    command("/runs", "Session runs:")
    command("/run 1", "Run #1:")
    command("/run 5", "Run #5:")
    send("/exit\r")
    expect("[VERIFIED: exact source task/current transcript;")
    deadline = time.monotonic() + 15
    while read_chunk(0.1):
        if time.monotonic() >= deadline:
            raise AssertionError("Child did not close its PTY")
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, f"Child status: {status}"
    text = output()
    assert text.count("Rerun action already accepted as Run #3.") == 2
    assert "Run #6" not in text
    assert text.count("Patch proposal: answer.ts") == 3
    assert "-export const answer = 42\n+export const answer = 43\n" in text
    assert text.count("-export const answer = 44\n+export const answer = 45\n") == 2
    assert "Fresh proposal denied; answer stays 44." in text
    assert "Fresh consent applied 45; marker retained." in text
    print("PTY PASS: child exit 0; demo assertions passed; three complete diffs; two duplicates; no Run #6.")
finally:
    log.write_bytes(raw)
    os.close(master)
    if status is None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    print(f"Raw PTY output: {log}")
