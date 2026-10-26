#!/usr/bin/python3 -I
# Protected guest supervisor, bridge core (CQ-R08b). guest-bootstrap.mjs buildUserData installs these bytes at
# GUEST_LAYOUT.supervisor, and guest-bridge.mjs is the protocol source of truth. This process is the ONLY writer of
# its stdout: child bytes reach the host only inside base64 'output' frames, and termination only as this process's
# own 'observation' frame from waitpid. Standard library only; the guest has python3 for cloud-init and no Node.
# Exit codes: 0 relay complete; 64 usage; 71 the job could not start (child or agent socket: hello, then EOF, no
# observation); 74 I/O failure or host EOF (child group killed); 76 host protocol violation (child group killed);
# 77 not root; 78 root bridge with no job.
import base64
import json
import os
import pwd
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import types

PROTOCOL = 1
MAX_GUEST_FRAME_BYTES = 262144  # mirrors guest-bridge.mjs
MAX_HOST_FRAME_BYTES = 4194304  # mirrors guest-bridge.mjs
MAX_REQUEST_ID = 2147483647
# base64 grows a full chunk to 87,384 bytes plus a 45-byte JSON envelope, far inside the frame limit.
OUTPUT_CHUNK_BYTES = 65536
# CQ-R08c ingress, the agent's only route to Moe. AGENT_IDENTITY is JOB_IDENTITIES[0] in guest-bootstrap.mjs.
AGENT_IDENTITY = 'moe-agent'
AGENT_SOCKET = '/run/moe/agent.sock'
MAX_CONNECTIONS = 8
MAX_IN_FLIGHT = 8  # per connection; MAX_CONNECTIONS * MAX_IN_FLIGHT bounds all pending ids, closed requesters' too
TOOL = re.compile(r'moe\.[a-z][a-z_]{0,63}')
CODE = re.compile(r'[A-Z][A-Z0-9_]{0,63}')


class ProtocolViolation(Exception):
    """The host broke the protocol; the bridge ends with EX_PROTOCOL."""


def encode_frame(value, limit=MAX_GUEST_FRAME_BYTES):
    # UTF-8 keeps a relayed frame the size of its source; backslashreplace turns a lone surrogate (only a JSON escape
    # makes one) back into that escape, and allow_nan refuses the inf that Python reads 1e999 as.
    text = json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    body = text.encode('utf-8', 'backslashreplace')
    if len(body) > limit:
        raise ValueError('frame body exceeds its limit')
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


def take_frames(buffer, data, limit):
    # Appends data, then pops each whole frame: a length of 1..limit (refused before its body is buffered), UTF-8 JSON.
    buffer += data
    frames = []
    while len(buffer) >= 4:
        length = struct.unpack_from('>I', buffer)[0]
        if not 0 < length <= limit:
            raise ValueError('frame length outside its limit')
        if len(buffer) < 4 + length:
            break
        frames.append(json.loads(buffer[4:4 + length].decode('utf-8')))
        del buffer[:4 + length]
    return frames


def agent_request(frame):
    # Exactly the CQ-R08a request shape (parseGuestFrame); the host's scopeRequest owns the per-role tool allowlist.
    if not (type(frame) is dict and frame.keys() == {'kind', 'id', 'tool', 'args'} and frame['kind'] == 'request'
            and type(frame['id']) is int and 0 < frame['id'] <= MAX_REQUEST_ID and type(frame['tool']) is str
            and TOOL.fullmatch(frame['tool']) and type(frame['args']) is dict):
        raise ValueError('not a request frame')
    return frame


def host_response(frame):
    ok = frame.get('ok') if type(frame) is dict else None
    error = frame.get('error') if ok is False else {'code': 'OK'}
    if not (type(ok) is bool and frame.keys() == {'kind', 'id', 'ok', 'result' if ok else 'error'}
            and frame['kind'] == 'response' and type(frame['id']) is int and type(error) is dict
            and error.keys() == {'code'} and type(error['code']) is str and CODE.fullmatch(error['code'])):
        raise ProtocolViolation
    return frame


def peer_uid(sock):
    # Linux SO_PEERCRED is struct ucred {pid_t pid; uid_t uid; gid_t gid;}, fixed by the kernel at connect().
    return struct.unpack('iII', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]


class Bridge:
    """The one selector loop: child pipes, host response frames on in_fd and, once opened, the agent socket."""

    def __init__(self, out_fd, peer_uid):
        self.out_fd, self.peer_uid = out_fd, peer_uid
        self.selector = selectors.DefaultSelector()
        self.inbox, self.pending, self.next_id, self.sockets = bytearray(), {}, 1, set()
        self.server = self.path = None

    def open(self, in_fd, path, agent_uid):
        self.selector.register(in_fd, selectors.EVENT_READ, self.from_host)
        if path is None:
            return
        self.agent_uid = pwd.getpwnam(AGENT_IDENTITY).pw_uid if agent_uid is None else agent_uid
        folder = os.path.dirname(path)
        os.makedirs(folder, 0o755, exist_ok=True)  # sudo's umask 0022 keeps it searchable by the agent
        info = os.lstat(folder)
        # Writable only by this euid (root in the guest), so no job can plant or replace the socket.
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise PermissionError('the agent socket directory is not private')
        if os.path.lexists(path) and stat.S_ISSOCK(os.lstat(path).st_mode):
            os.unlink(path)  # left by an earlier bridge
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        info = os.lstat(path)
        self.path, self.bound = path, (info.st_dev, info.st_ino)
        os.chmod(path, 0o666)  # any guest user may connect; SO_PEERCRED decides who is served
        self.server.listen(MAX_CONNECTIONS)
        self.server.setblocking(False)
        self.selector.register(self.server, selectors.EVENT_READ, self.accept)

    def from_host(self, key, mask):
        data = os.read(key.fd, OUTPUT_CHUNK_BYTES)
        if not data:
            raise BrokenPipeError('the host closed the bridge')  # a gone host, as on stdout: EX_IOERR
        try:
            for frame in take_frames(self.inbox, data, MAX_HOST_FRAME_BYTES):
                conn, agent_id = self.pending.pop(host_response(frame)['id'], (None, None))
                if conn is None:
                    raise ProtocolViolation  # an id never assigned, or already answered
                if not conn.closed:  # a closed requester's answer is dropped, never rerouted
                    conn.inflight -= 1
                    field = 'result' if frame['ok'] else 'error'
                    reply = {'kind': 'response', 'id': agent_id, 'ok': frame['ok'], field: frame[field]}
                    conn.outbox += encode_frame(reply, MAX_HOST_FRAME_BYTES)
                    self.watch(conn)
        except (ValueError, RecursionError):
            raise ProtocolViolation from None

    def accept(self, key, mask):
        try:
            sock = self.server.accept()[0]
        except OSError:
            return
        try:
            if len(self.sockets) >= MAX_CONNECTIONS or self.peer_uid(sock) != self.agent_uid:
                raise PermissionError('not a served agent peer')
        except OSError:
            return sock.close()  # before any byte is read from it
        sock.setblocking(False)
        conn = types.SimpleNamespace(sock=sock, inbox=bytearray(), outbox=bytearray(), inflight=0, closed=False)
        conn.handler = lambda key, mask: self.from_agent(conn, mask)
        self.sockets.add(sock)
        self.selector.register(sock, selectors.EVENT_READ, conn.handler)

    def from_agent(self, conn, mask):
        frames = []
        try:
            if mask & selectors.EVENT_WRITE:
                del conn.outbox[:conn.sock.send(conn.outbox)]
            elif not (data := conn.sock.recv(OUTPUT_CHUNK_BYTES)):
                return self.drop(conn)  # the agent closed it
            else:
                frames = [agent_request(frame) for frame in take_frames(conn.inbox, data, MAX_GUEST_FRAME_BYTES)]
        except BlockingIOError:
            pass
        except (OSError, ValueError, RecursionError):
            return self.drop(conn)  # only the offending connection
        for frame in frames:
            if conn.inflight >= MAX_IN_FLIGHT or len(self.pending) >= MAX_CONNECTIONS * MAX_IN_FLIGHT:
                busy = {'kind': 'response', 'id': frame['id'], 'ok': False, 'error': {'code': 'BRIDGE_BUSY'}}
                conn.outbox += encode_frame(busy)
                continue
            relayed = {'kind': 'request', 'id': self.next_id, 'tool': frame['tool'], 'args': frame['args']}
            try:  # encoding fails before any byte is written; an OSError is a gone host and ends the bridge
                write_frame(self.out_fd, relayed)
            except (ValueError, RecursionError):
                return self.drop(conn)  # not relayable within the guest frame limit
            self.pending[self.next_id] = (conn, frame['id'])
            self.next_id += 1
            conn.inflight += 1
        self.watch(conn)

    def watch(self, conn):
        # Reading pauses while replies are queued, so an agent that never reads cannot make its outbox grow unbounded.
        self.selector.modify(conn.sock, selectors.EVENT_WRITE if conn.outbox else selectors.EVENT_READ, conn.handler)

    def drop(self, conn):
        conn.closed = True
        self.sockets.discard(conn.sock)
        self.selector.unregister(conn.sock)
        conn.sock.close()

    def close(self):
        for sock in [*self.sockets, *filter(None, [self.server])]:
            sock.close()
        self.selector.close()
        try:
            info = os.lstat(self.path) if self.path else None
            if info and (info.st_dev, info.st_ino) == self.bound:  # a newer bridge may have replaced it
                os.unlink(self.path)
        except FileNotFoundError:
            pass


def pump(child, out_fd, bridge):
    streams = {child.stdout.fileno(): 'stdout', child.stderr.fileno(): 'stderr'}
    with bridge.selector as selector:
        for fd in streams:
            selector.register(fd, selectors.EVENT_READ)
        while any(fd in selector.get_map() for fd in streams):
            for key, mask in selector.select():
                if key.data:  # the host stream, the agent socket or an agent connection
                    key.data(key, mask)
                    continue
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


# in_fd carries host response frames, and its EOF is a gone host. agent_socket opens the CQ-R08c ingress for peers
# whose uid is agent_uid (default: the AGENT_IDENTITY account); peer_uid is injectable from Python only (tests).
def relay(argv, out_fd=1, in_fd=0, agent_socket=None, agent_uid=None, peer_uid=peer_uid):
    # An inherited SIG_IGN (it survives exec) lets the kernel discard the child's status before waitpid reads it.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    try:
        write_frame(out_fd, {'kind': 'hello', 'protocol': PROTOCOL})
    except OSError:
        return os.EX_IOERR
    bridge = Bridge(out_fd, peer_uid)
    try:
        bridge.open(in_fd, agent_socket, agent_uid)
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
    except (OSError, KeyError):  # KeyError: no AGENT_IDENTITY account
        bridge.close()
        return os.EX_OSERR  # hello, then EOF: never a fabricated observation
    reaped = False
    try:
        pump(child, out_fd, bridge)
        # Both pipes are at EOF; waitpid is the only source of the exit frame.
        status = reap(child)
        reaped = True
        write_frame(out_fd, exit_observation(status))
        return 0
    except ProtocolViolation:
        return os.EX_PROTOCOL
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
        bridge.close()  # no agent connection or socket outlives the job


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
