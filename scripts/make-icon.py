#!/usr/bin/env python3
"""Render the NintyAPI plugin icon: a dark navy squircle carrying a request/
response arrow pair — the outbound request arrow in a blue-violet gradient,
the inbound response arrow in white. Matches the NintyShell icon family.
Layered SDF painter, pure stdlib PNG writer, 4x supersampled."""
import math
import struct
import sys
import zlib

SIZE = 256
SS = 4        # supersampling factor
RADIUS = 56   # squircle corner radius (14/64 of the canvas, same as Shell)
STROKE = 24   # arrow stroke width

def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v

def hexc(s):
    return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))

def mix(c1, c2, t):
    return (c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t)

def sd_round_rect(px, py, x0, y0, x1, y1, r):
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx, dy = abs(px - mx) - hx, abs(py - my) - hy
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r

def sd_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0.0, 1.0)
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))

def edge(d, w=1.4):
    return clamp(0.5 - d / w, 0.0, 1.0)

# ---------------------------------------------------------------- palette
BG1, BG2, BG3 = hexc("#3d4d68"), hexc("#263349"), hexc("#141c2b")
REQ_T, REQ_B = hexc("#60a5fa"), hexc("#a78bfa")   # request arrow: blue -> violet
RES = hexc("#f1f5f9")                             # response arrow: soft white

def bg_color(px, py):
    t = clamp((px + py) / (2.0 * SIZE), 0.0, 1.0)
    if t < 0.5:
        return mix(BG1, BG2, t * 2)
    return mix(BG2, BG3, (t - 0.5) * 2)

def req_color(px, py):
    return mix(REQ_T, REQ_B, clamp((px - 58) / 118, 0.0, 1.0))

# ---------------------------------------------------------------- geometry
# Each arrow = horizontal shaft + V-shaped head (two segments sharing the apex).
REQ_SEGS = ((70, 88, 160, 88), (134, 66, 164, 88), (164, 88, 134, 110))   # ->
RES_SEGS = ((186, 168, 96, 168), (122, 146, 92, 168), (92, 168, 122, 190))  # <-

def arrow_sd(px, py, segs):
    return min(sd_seg(px, py, ax, ay, bx, by) for ax, ay, bx, by in segs) - STROKE / 2

def ring_alpha(px, py):
    d = sd_round_rect(px, py, 3, 3, SIZE - 3, SIZE - 3, RADIUS - 3)
    return 0.12 * edge(abs(d), 6)

# ---------------------------------------------------------------- painter
OVERLAYS = [
    (ring_alpha, lambda px, py: (255, 255, 255)),
    (lambda px, py: edge(arrow_sd(px, py, REQ_SEGS)), req_color),
    (lambda px, py: edge(arrow_sd(px, py, RES_SEGS)), lambda px, py: RES),
]

def pixel(x, y):
    total = [0.0, 0.0, 0.0, 0.0]
    for sy_off in range(SS):
        for sx_off in range(SS):
            px = x + (sx_off + 0.5) / SS
            py = y + (sy_off + 0.5) / SS
            a = edge(sd_round_rect(px, py, 0, 0, SIZE, SIZE, RADIUS))
            if a <= 0:
                continue
            r, g, b = bg_color(px, py)
            for alpha_fn, color_fn in OVERLAYS:
                ca = alpha_fn(px, py)
                if ca <= 0:
                    continue
                cr, cg, cb = color_fn(px, py)
                r += (cr - r) * ca
                g += (cg - g) * ca
                b += (cb - b) * ca
            total[0] += r
            total[1] += g
            total[2] += b
            total[3] += a
    count = SS * SS
    if total[3] <= 0:
        return (0, 0, 0, 0)
    return (int(total[0] / count + 0.5), int(total[1] / count + 0.5), int(total[2] / count + 0.5), int(255 * total[3] / count + 0.5))

def write_png(path):
    rows = []
    for y in range(SIZE):
        row = bytearray([0])
        for x in range(SIZE):
            row.extend(pixel(x, y))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({len(png)} bytes)")

SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="NintyAPI">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="{SIZE}" y2="{SIZE}" gradientUnits="userSpaceOnUse">
      <stop stop-color="#3d4d68"/>
      <stop offset="0.5" stop-color="#263349"/>
      <stop offset="1" stop-color="#141c2b"/>
    </linearGradient>
    <linearGradient id="req" x1="58" y1="0" x2="176" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#60a5fa"/>
      <stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>
  <rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="url(#bg)"/>
  <rect x="3" y="3" width="{SIZE - 6}" height="{SIZE - 6}" rx="{RADIUS - 3}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="6"/>
  <path d="M70 88H160M134 66L164 88L134 110" fill="none" stroke="url(#req)" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M186 168H96M122 146L92 168L122 190" fill="none" stroke="#f1f5f9" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
'''

def write_svg(path):
    with open(path, "w") as f:
        f.write(SVG)
    print(f"wrote {path}")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "assets"
    write_png(f"{out}/plugin.png")
    write_svg(f"{out}/plugin.svg")
