#!/usr/bin/python3 -I
# The in-guest agent CLI's only route to Moe: an MCP stdio server serving MOE_ROLE's tools.json allowlist and relaying each
# allowed tools/call as one CQ-R08c request frame on the agent socket. It adds no trust; verified-local stays unavailable.
import json
import math
import os
import re
import selectors
import socket
import struct
import sys
import time

AGENT_SOCKET = '/run/moe/agent.sock'
TOOLS_PATH = '/opt/moe/bin/tools.json'
MAX_GUEST_FRAME_BYTES = 262144  # mirrors guest-bridge.mjs
MAX_HOST_FRAME_BYTES = 4194304  # mirrors guest-bridge.mjs
MAX_LINE_BYTES = 262144
MAX_TOOLS_BYTES = 262144  # guest-bootstrap.mjs MAX_SUPERVISOR_BYTES, the asset bound
MAX_IN_FLIGHT = 8  # guest-supervisor.py's per-connection bound
MAX_REQUEST_ID = 2147483647
CALL_TIMEOUT_SECONDS = 120  # above the host's 60 s forward cap
PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')  # newest first
TOOL = re.compile(r'moe\.[a-z][a-z_]{0,63}')  # guest-supervisor.py
CODE = re.compile(r'[A-Z][A-Z0-9_]{0,63}')  # guest-supervisor.py
KEY = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')
CHUNK_BYTES = 65536
# The only source of error text: no message includes input. Only REFUSED carries data, the host's CODE.
ERRORS = {
    'PARSE': (-32700, 'Parse error.'), 'INVALID_REQUEST': (-32600, 'Invalid request.'), 'TOO_LARGE': (-32600, 'Request too large.'),
    'METHOD': (-32601, 'Method not found.'), 'INVALID_PARAMS': (-32602, 'Invalid params.'),
    'TOOL_DENIED': (-32602, 'Tool not available to this role.'), 'ARGUMENT_DENIED': (-32602, 'Argument not allowed for this tool.'),
    'BUSY': (-32001, 'Too many tool calls in flight.'), 'TIMEOUT': (-32002, 'The tool call timed out.'),
    'UNAVAILABLE': (-32003, 'The Moe bridge is unavailable.'), 'REFUSED': (-32004, 'Moe refused the tool call.'),
}


def _finite(text):  # parse_float and parse_constant: NaN, Infinity and an overflow such as 1e999 are refused
    if not math.isfinite(value := float(text)):
        raise ValueError('non-finite number')
    return value


def _decode(data):  # strict UTF-8 JSON: a BOM is refused, and UnicodeDecodeError is a ValueError
    return json.loads(data.decode('utf-8'), parse_constant=_finite, parse_float=_finite)


def load_tools(path):
    # role -> TOOL name -> unique KEY argument names. Anything else, a missing or oversized file included, serves none.
    try:
        with open(path, 'rb') as file:
            data = file.read(MAX_TOOLS_BYTES + 1)
        table = _decode(data) if len(data) <= MAX_TOOLS_BYTES else None
    except (OSError, ValueError, RecursionError):
        return {}
    valid = type(table) is dict and all(type(tools) is dict and all(
        TOOL.fullmatch(name) and type(keys) is list and all(type(key) is str and KEY.fullmatch(key) for key in keys)
        and len(set(keys)) == len(keys) for name, keys in tools.items()) for tools in table.values())
    return table if valid else {}


def _reply(request_id, answer, data=None):  # answer is a result object or an ERRORS name
    if type(answer) is not str:
        return {'jsonrpc': '2.0', 'id': request_id, 'result': answer}
    error = {'code': ERRORS[answer][0], 'message': ERRORS[answer][1]}
    return {'jsonrpc': '2.0', 'id': request_id, 'error': {**error, 'data': data} if data else error}


class _Shim:
    def __init__(self, tools, socket_path, timeout, in_fd, out_fd):
        self.tools, self.path, self.timeout, self.in_fd, self.out_fd = tools, socket_path, timeout, in_fd, out_fd
        self.listed = {'tools': [{'name': name, 'inputSchema': {
            'type': 'object', 'properties': {key: {} for key in keys}, 'additionalProperties': False}}
            for name, keys in tools.items()]}
        self.selector = selectors.DefaultSelector()
        self.line, self.skipping = bytearray(), False
        self.sock, self.inbox, self.outbox = None, bytearray(), bytearray()
        self.pending, self.next_id = {}, 1  # bridge id -> (JSON-RPC id, deadline); bridge ids are never reused

    def run(self):
        try:
            self.selector.register(self.in_fd, selectors.EVENT_READ)
            while True:
                due = min((deadline for _, deadline in self.pending.values()), default=None)
                for key, mask in self.selector.select(None if due is None else max(0, due - time.monotonic())):
                    if key.fileobj is self.sock:
                        self.from_bridge(mask)
                    elif key.fd == self.in_fd:
                        data = os.read(self.in_fd, CHUNK_BYTES)
                        if not data:
                            return 0  # EOF drops an unterminated final line
                        self.read_lines(data)
                self.expire()
        except OSError:  # stdin, stdout or the selector; every socket error is handled where it happens
            return os.EX_IOERR
        finally:
            self.close_bridge()
            self.selector.close()

    def read_lines(self, data):
        # An over-long line gets one TOO_LARGE and is discarded through its newline: the buffer never exceeds the bound.
        start = 0
        while start < len(data):
            newline = data.find(b'\n', start)
            end = len(data) if newline < 0 else newline
            if not self.skipping and len(self.line) + end - start > MAX_LINE_BYTES:
                self.emit(_reply(None, 'TOO_LARGE'))
                self.line.clear()
                self.skipping = True
            if not self.skipping:
                self.line += data[start:end]
            if newline >= 0:
                if not self.skipping and self.line.strip(b' \t\r'):
                    self.handle(bytes(self.line))
                self.line.clear()
                self.skipping = False
            start = end + 1

    def handle(self, line):
        try:
            message = _decode(line)
        except (ValueError, RecursionError):
            return self.emit(_reply(None, 'PARSE'))
        request_id = message.get('id') if type(message) is dict else None
        valid_id = (type(request_id) is int and abs(request_id) < 2 ** 53) or (type(request_id) is str and len(request_id) <= 256)
        if not (type(message) is dict and message.get('jsonrpc') == '2.0' and type(message.get('method')) is str
                and ('id' not in message or valid_id)):
            return self.emit(_reply(None, 'INVALID_REQUEST'))
        answer = self.answer(request_id, message['method'], message.get('params', {})) if 'id' in message else None
        if answer is not None:  # None: a notification, or a relayed call answered later
            self.emit(_reply(request_id, answer))

    def answer(self, request_id, method, params):
        if type(params) is not dict:
            return 'INVALID_PARAMS'
        if method == 'initialize':
            version = params.get('protocolVersion')
            return 'INVALID_PARAMS' if type(version) is not str else {
                'protocolVersion': version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'moe-guest-shim', 'version': '1'}}
        if method == 'tools/call':
            return self.call(request_id, params.get('name'), params.get('arguments', {}))
        return {} if method == 'ping' else self.listed if method == 'tools/list' else 'METHOD'

    def call(self, request_id, name, args):
        refusal = ('INVALID_PARAMS' if type(name) is not str else 'TOOL_DENIED' if name not in self.tools
                   else 'INVALID_PARAMS' if type(args) is not dict
                   else 'ARGUMENT_DENIED' if any(key not in self.tools[name] for key in args)
                   else 'BUSY' if len(self.pending) >= MAX_IN_FLIGHT else None)
        if refusal:
            return refusal
        try:  # guest-supervisor.py encode_frame
            body = json.dumps({'kind': 'request', 'id': self.next_id, 'tool': name, 'args': args}, separators=(',', ':'),
                              ensure_ascii=False, allow_nan=False).encode('utf-8', 'backslashreplace')
        except (ValueError, RecursionError):
            return 'TOO_LARGE'
        if len(body) > MAX_GUEST_FRAME_BYTES:
            return 'TOO_LARGE'
        if self.next_id > MAX_REQUEST_ID or (self.sock is None and not self.connect()):
            return 'UNAVAILABLE'
        # Only EVENT_WRITE drains the outbox. The supervisor stops reading while replies to us are queued, so a
        # blocking send could deadlock against our own full receive buffer.
        self.outbox += struct.pack('>I', len(body)) + body
        self.pending[self.next_id] = (request_id, time.monotonic() + self.timeout)
        self.next_id += 1
        self.watch()
        return None

    def connect(self):
        try:  # no retry loop: a failure answers this call, and the next call tries once more
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(5)  # a full listen backlog blocks connect
            self.sock.connect(self.path)
            self.sock.setblocking(False)
            self.selector.register(self.sock, selectors.EVENT_READ)
            return True
        except OSError:
            if self.sock is not None:
                self.sock.close()
            self.sock = None
            return False

    def watch(self):
        self.selector.modify(self.sock, selectors.EVENT_READ | (selectors.EVENT_WRITE if self.outbox else 0))

    def from_bridge(self, mask):
        try:
            if mask & selectors.EVENT_WRITE:
                del self.outbox[:self.sock.send(self.outbox)]
            data = self.sock.recv(CHUNK_BYTES) if mask & selectors.EVENT_READ else None
        except BlockingIOError:
            data = None
        except OSError:
            return self.fail_bridge()
        frames, broken = self.take_frames(data) if data else ([], data == b'')  # b'' is EOF
        for frame in frames:
            if frame['id'] in self.pending:  # any other id is a late reply to an expired call
                request_id = self.pending.pop(frame['id'])[0]
                self.emit(_reply(request_id, frame['result']) if frame['ok']
                          else _reply(request_id, 'REFUSED', {'code': frame['error']['code']}))
        return self.fail_bridge() if broken else self.watch()

    def take_frames(self, data):
        # The whole frames in order, then whether the bytes broke the protocol. A length is checked before its body is
        # awaited, and a frame must be exactly guest-supervisor.py host_response's shape for an id already assigned.
        self.inbox += data
        frames = []
        try:
            while len(self.inbox) >= 4:
                length = struct.unpack_from('>I', self.inbox)[0]
                if not 0 < length <= MAX_HOST_FRAME_BYTES:
                    return frames, True
                if len(self.inbox) < 4 + length:
                    break
                frame = _decode(bytes(self.inbox[4:4 + length]))
                del self.inbox[:4 + length]
                ok = frame.get('ok') if type(frame) is dict else None
                field = frame.get('result' if ok else 'error') if type(ok) is bool else None
                if not (type(field) is dict and frame.keys() == {'kind', 'id', 'ok', 'result' if ok else 'error'}
                        and frame['kind'] == 'response' and type(frame['id']) is int and 0 < frame['id'] < self.next_id
                        and (ok or (field.keys() == {'code'} and type(field['code']) is str and CODE.fullmatch(field['code'])))):
                    return frames, True
                frames.append(frame)
        except (ValueError, RecursionError):
            return frames, True
        return frames, False

    def fail_bridge(self):
        # A violation, EOF or socket error closes the connection and fails every pending call; the next call reconnects.
        self.close_bridge()
        failed, self.pending = self.pending, {}
        for request_id, _ in failed.values():
            self.emit(_reply(request_id, 'UNAVAILABLE'))

    def close_bridge(self):
        if self.sock is not None:
            self.selector.unregister(self.sock)
            self.sock.close()
            self.sock = None
        del self.inbox[:], self.outbox[:]

    def expire(self):
        now = time.monotonic()
        for bridge_id, (request_id, deadline) in list(self.pending.items()):
            if deadline <= now:
                del self.pending[bridge_id]
                self.emit(_reply(request_id, 'TIMEOUT'))

    def emit(self, message):
        try:
            text = json.dumps(message, separators=(',', ':'), ensure_ascii=True, allow_nan=False)
        except (ValueError, RecursionError):  # a host result the encoder refuses
            text = json.dumps(_reply(message['id'], 'UNAVAILABLE'), separators=(',', ':'))
        data = memoryview(text.encode() + b'\n')
        while data:
            data = data[os.write(self.out_fd, data):]


def serve(role, table, socket_path, timeout=None, in_fd=0, out_fd=1):
    tools = table[role] if type(role) is str and role in table else {}
    return _Shim(tools, socket_path, CALL_TIMEOUT_SECONDS if timeout is None else timeout, in_fd, out_fd).run()


def main():
    return serve(os.environ.get('MOE_ROLE'), load_tools(TOOLS_PATH), AGENT_SOCKET)


if __name__ == '__main__':
    sys.exit(main())
