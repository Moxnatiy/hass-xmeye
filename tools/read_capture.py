#!/usr/bin/env python3
"""Read DVRIP traffic out of a pcapng capture.

    sudo tcpdump -i any -s0 -w /tmp/xmeye.pcap 'host 192.168.1.10 and port 34567'
    python tools/read_capture.py /tmp/xmeye.pcap

Written for watching what the vendor app asks the recorder to do, which is the
only reliable way to learn the parts of the protocol no document describes.
Dependency-free: it walks pcapng blocks and reassembles each direction in
capture order, resynchronising DVRIP framing on the magic byte. Crude, but the
JSON comes out readable.

Login hashes are redacted on the way out — a Sofia hash is password-equivalent,
so a capture and its transcript are both credentials.
"""
import json
import re
import struct
import sys
from collections import defaultdict

PORT = 34567

def blocks(data):
    """Walk pcapng blocks, yielding (block_type, body)."""
    off = 0
    endian = "<"
    while off + 12 <= len(data):
        btype, = struct.unpack_from(endian + "I", data, off)
        if btype == 0x0A0D0D0A:  # section header, carries the byte order magic
            bom, = struct.unpack_from("<I", data, off + 8)
            endian = "<" if bom == 0x1A2B3C4D else ">"
        blen, = struct.unpack_from(endian + "I", data, off + 4)
        if blen < 12 or off + blen > len(data):
            break
        yield btype, data[off + 8: off + blen - 4], endian
        off += blen

def packets(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    for btype, body, endian in blocks(raw):
        if btype == 6:  # enhanced packet block
            caplen, = struct.unpack_from(endian + "I", body, 12)
            yield body[20:20 + caplen]
        elif btype == 3:  # simple packet block
            yield body[4:]

def strip_pktap(pkt):
    """PKTAP prepends its own header; its length is the first word."""
    if len(pkt) < 4:
        return None
    hdr_len, = struct.unpack_from("<I", pkt, 0)
    if 4 <= hdr_len <= 256 and hdr_len < len(pkt):
        return pkt[hdr_len:]
    return pkt

def ipv4_tcp(frame):
    """Return (src, dst, sport, dport, payload) for IPv4/TCP, else None."""
    for start in (0, 4, 14):  # loopback/null, ethernet
        if start + 20 > len(frame):
            continue
        ver_ihl = frame[start]
        if ver_ihl >> 4 != 4:
            continue
        ihl = (ver_ihl & 0xF) * 4
        if frame[start + 9] != 6:  # TCP
            continue
        total, = struct.unpack_from(">H", frame, start + 2)
        src = ".".join(str(b) for b in frame[start + 12:start + 16])
        dst = ".".join(str(b) for b in frame[start + 16:start + 20])
        tcp = start + ihl
        if tcp + 20 > len(frame):
            continue
        sport, dport = struct.unpack_from(">HH", frame, tcp)
        doff = (frame[tcp + 12] >> 4) * 4
        end = start + total if total else len(frame)
        return src, dst, sport, dport, frame[tcp + doff:end]
    return None

streams = defaultdict(bytearray)
order = []
for pkt in packets(sys.argv[1]):
    frame = strip_pktap(pkt)
    if not frame:
        continue
    parsed = ipv4_tcp(frame)
    if not parsed:
        continue
    src, dst, sport, dport, payload = parsed
    if PORT not in (sport, dport) or not payload:
        continue
    key = (src, sport, dst, dport)
    if key not in streams:
        order.append(key)
    streams[key] += payload

SECRET = re.compile(r'("PassWord"\s*:\s*")[^"]*(")')

def dvrip(buf):
    """Yield (msgid, payload) resynchronising on the magic byte."""
    i = 0
    while True:
        i = buf.find(b"\xff", i)
        if i < 0 or i + 20 > len(buf):
            return
        msgid, size = struct.unpack_from("<HI", buf, i + 14)
        if size > 4_000_000 or i + 20 + size > len(buf):
            i += 1
            continue
        body = bytes(buf[i + 20:i + 20 + size])
        yield msgid, body
        i += 20 + size

print(f"{len(order)} TCP streams touching port {PORT}\n")
for key in order:
    src, sport, dst, dport = key
    to_device = dport == PORT
    buf = streams[key]
    arrow = "->" if to_device else "<-"
    print(f"--- {src}:{sport} {arrow} {dst}:{dport}  ({len(buf)} bytes, "
          f"{'to device' if to_device else 'from device'}) ---")
    shown = 0
    for msgid, body in dvrip(buf):
        if msgid in (1412, 1422, 1426, 1432):   # media, not worth printing
            continue
        text = body.rstrip(b"\x00\n").decode("utf8", "replace")
        text = SECRET.sub(r"\1<redacted>\2", text)
        try:
            obj = json.loads(text)
            kind = "json"
            text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            kind = "raw "
            text = f"len={len(body)} hex={body[:24].hex()} ascii={text[:60]!r}"
        print(f"  msgid {msgid:<5} {kind} {text[:400]}")
        shown += 1
        if shown > 40:
            print("  ...")
            break
    print()
