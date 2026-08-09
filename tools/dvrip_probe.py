#!/usr/bin/env python3
"""Quick DVRIP (Sofia) probe: login plus a battery of Get/Cmd requests.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret python tools/dvrip_probe.py

Dependency-free on purpose: it speaks the raw protocol so that a failure here
points at the device rather than at the library.
"""
import hashlib
import json
import os
import socket
import struct
import sys

HOST = os.environ.get("XMEYE_HOST", "")
PORT = int(os.environ.get("XMEYE_PORT", "34567"))
USER = os.environ.get("XMEYE_USER", "admin")
PASS = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("XMEYE_PASS", "")

if not HOST:
    sys.exit("set XMEYE_HOST (and XMEYE_PASS, or pass the password as an argument)")

CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def sofia_hash(pw: str) -> str:
    h = hashlib.md5(pw.encode()).digest()
    return "".join(CHARS[(h[i] + h[i + 1]) % 62] for i in range(0, 16, 2))


class DVRIP:
    def __init__(self):
        self.s = socket.create_connection((HOST, PORT), 5)
        self.s.settimeout(6)
        self.session = 0
        self.seq = 0

    def send(self, msgid, obj):
        payload = (json.dumps(obj, separators=(",", ":")) + "\n\x00").encode()
        hdr = bytearray(20)
        hdr[0] = 0xFF
        struct.pack_into("<I", hdr, 4, self.session)
        struct.pack_into("<I", hdr, 8, self.seq)
        struct.pack_into("<H", hdr, 14, msgid)
        struct.pack_into("<I", hdr, 16, len(payload))
        self.seq += 1
        self.s.sendall(bytes(hdr) + payload)

    def recv(self):
        hdr = self._readn(20)
        if not hdr or hdr[0] != 0xFF:
            raise OSError("bad header")
        self.session = struct.unpack_from("<I", hdr, 4)[0]
        msgid = struct.unpack_from("<H", hdr, 14)[0]
        size = struct.unpack_from("<I", hdr, 16)[0]
        body = self._readn(size)
        try:
            return msgid, json.loads(body.rstrip(b"\x00\n").decode("utf8", "replace"))
        except Exception:
            return msgid, body

    def _readn(self, n):
        buf = b""
        while len(buf) < n:
            c = self.s.recv(n - len(buf))
            if not c:
                raise OSError("closed")
            buf += c
        return buf

    def login(self):
        self.send(1000, {"EncryptType": "MD5", "LoginType": "DVRIP-Web",
                         "PassWord": sofia_hash(PASS), "UserName": USER})
        return self.recv()[1]

    def ask(self, msgid, obj):
        self.send(msgid, obj)
        return self.recv()[1]


d = DVRIP()
print("LOGIN:", json.dumps(d.login(), ensure_ascii=False))
sid = f"0x{d.session:08X}"

# 1020 = ABILITY_GET, 1042 = SYSINFO_REQ, 1044 = CONFIG_GET, 1360 = GUARD,
# 1452 = FULLAUTH
probes = [
    (1042, {"Name": "SystemInfo", "SessionID": sid}),
    (1042, {"Name": "SystemFunction", "SessionID": sid}),
    (1020, {"Name": "SystemFunction", "SessionID": sid}),
    (1020, {"Name": "EncodeCapability", "SessionID": sid}),
    (1042, {"Name": "StorageInfo", "SessionID": sid}),
    (1044, {"Name": "General.Location", "SessionID": sid}),
    (1044, {"Name": "Simplify.Encode", "SessionID": sid}),
    (1044, {"Name": "AVEnc.VideoWidget", "SessionID": sid}),
    (1044, {"Name": "ChannelTitle", "SessionID": sid}),
    (1044, {"Name": "NetWork.NetCommon", "SessionID": sid}),
    (1044, {"Name": "Detect.MotionDetect", "SessionID": sid}),
    (1044, {"Name": "Camera.Param", "SessionID": sid}),
    (1360, {"Name": "", "SessionID": sid}),
    (1452, {"Name": "OPSystemUpgrade", "SessionID": sid}),
]
for mid, obj in probes:
    try:
        r = d.ask(mid, obj)
        s = json.dumps(r, ensure_ascii=False)
        print(f"\n--- {mid} {obj.get('Name')!r} -> {s[:1800]}")
    except Exception as e:
        print(f"\n--- {mid} {obj.get('Name')!r} -> ERR {e}")
        break
