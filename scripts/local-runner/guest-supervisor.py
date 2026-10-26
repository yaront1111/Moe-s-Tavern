#!/usr/bin/python3 -I
# Protected guest supervisor, bridge core (CQ-R08b). guest-bootstrap.mjs buildUserData installs these bytes at
# GUEST_LAYOUT.supervisor, and guest-bridge.mjs is the protocol source of truth. This process is the ONLY writer of
# its stdout: child bytes reach the host only inside base64 'output' frames, and termination only as this process's
# own 'observation' frame from waitpid. Standard library only; the guest has python3 for cloud-init and no Node.
# Exit codes: 0 relay complete; 64 usage; 71 child failed to start (hello, then EOF, no observation);
# 74 I/O failure (child group killed); 77 not root; 78 root bridge with no job.
import base64
import json
import os
import selectors
import signal
import struct
import subprocess
import sys

PROTOCOL = 1
MAX_GUEST_FRAME_BYTES = 262144  # mirrors guest-bridge.mjs
# base64 grows a full chunk to 87,384 bytes plus a 45-byte JSON envelope, far inside the frame limit.
OUTPUT_CHUNK_BYTES = 65536


def encode_frame(value):
    body = json.dumps(value, separators=(',', ':')).encode('ascii')
    if len(body) > MAX_GUEST_FRAME_BYTES:
        raise ValueError('frame body exceeds MAX_GUEST_FRAME_BYTES')
    return struct.pack('>I', len(body)) + body


def write_frame(fd, value):
    view = memoryview(encode_frame(value))
    while view:
        view = view[os.write(fd, view):]


def exit_observation(status):
    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        try:
            name = signal.Signals(number).name
        except ValueError:
            name = 'SIG%d' % number  # unnamed Linux real-time signals
        return {'kind': 'observation', 'type': 'exit', 'code': None, 'signal': name}
    if os.WIFEXITED(status):
        return {'kind': 'observation', 'type': 'exit', 'code': os.WEXITSTATUS(status), 'signal': None}
    raise ValueError('wait status is neither an exit nor a signal')


def pump(child, out_fd):
    streams = {child.stdout.fileno(): 'stdout', child.stderr.fileno(): 'stderr'}
    with selectors.DefaultSelector() as selector:
        for fd in streams:
            selector.register(fd, selectors.EVENT_READ)
        while selector.get_map():
            for key, _ in selector.select():
                chunk = os.read(key.fd, OUTPUT_CHUNK_BYTES)
                if not chunk:
                    selector.unregister(key.fd)
                    continue
                data = base64.b64encode(chunk).decode('ascii')
                write_frame(out_fd, {'kind': 'output', 'stream': streams[key.fd], 'data': data})


def reap(child):
    status = os.waitpid(child.pid, 0)[1]
    child.returncode = os.waitstatus_to_exitcode(status)  # so subprocess never reaps again
    return status


def relay(argv, out_fd=1):
    # An inherited SIG_IGN (it survives exec) lets the kernel discard the child's status before waitpid reads it.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    try:
        write_frame(out_fd, {'kind': 'hello', 'protocol': PROTOCOL})
    except OSError:
        return os.EX_IOERR
    try:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
    except OSError:
        return os.EX_OSERR  # hello, then EOF: never a fabricated observation
    reaped = False
    try:
        pump(child, out_fd)
        # Both pipes are at EOF; waitpid is the only source of the exit frame.
        status = reap(child)
        reaped = True
        write_frame(out_fd, exit_observation(status))
        return 0
    except OSError:
        return os.EX_IOERR  # a gone host (BrokenPipeError: CPython ignores SIGPIPE) or a failed pipe read
    finally:
        if not reaped:
            # Kill the whole session group while the unreaped leader still pins its id, then reap the leader.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reap(child)
        child.stdout.close()
        child.stderr.close()


# geteuid is injectable from Python only (tests), never from argv or the environment. No path writes to stdout.
def main(argv, geteuid=os.geteuid):
    if argv != ['bridge']:  # bridgeArgv in guest-bridge.mjs passes exactly this
        return os.EX_USAGE
    if geteuid() != 0:
        return os.EX_NOPERM
    # The job a bridge session runs comes from the CQ-R10/R11 job tables; until one exists a root bridge fails closed.
    return os.EX_CONFIG


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
