#!/usr/bin/env python3
"""Render the REST Client plugin icon: a pastel-gradient squircle with a chibi
anime mascot (twin buns, ahoge, glossy eyes, omega mouth). Layered SDF painter,
pure stdlib PNG writer, 3x supersampled."""
import math
import struct
import sys
import zlib

SIZE = 256
SS = 3  # supersampling factor

def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v

def hexc(s):
    return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))

def mix(c1, c2, t):
    return (c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t)

def sd_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r

def sd_ellipse(px, py, cx, cy, rx, ry):
    nx, ny = (px - cx) / rx, (py - cy) / ry
    n = math.hypot(nx, ny)
    if n < 1e-6:
        return -min(rx, ry)
    # (n-1) scaled by the local inverse gradient -> near-exact boundary distance
    return (n - 1) * n / math.hypot(nx / rx, ny / ry)

def sd_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0.0, 1.0)
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))

def sd_round_rect(px, py, x0, y0, x1, y1, r):
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx, dy = abs(px - mx) - hx, abs(py - my) - hy
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r

def edge(d, w=1.4):
    return clamp(0.5 - d / w, 0.0, 1.0)

def soft(d, feather):
    return clamp(0.5 - d / feather, 0.0, 1.0)

def glow(d, sigma):
    return math.exp(-(max(d, 0.0) ** 2) / (2 * sigma * sigma))

# ---------------------------------------------------------------- palette
BG1, BG2, BG3 = hexc("#ffd2e9"), hexc("#ddd4ff"), hexc("#cfe9ff")
HAIR_T, HAIR_B = hexc("#b78ae8"), hexc("#f4a9d2")
SKIN = hexc("#ffeede")
SHADOW_SKIN = hexc("#e8a98c")
LINE = hexc("#4a3347")
IRIS_T, IRIS_B = hexc("#2e6fc0"), hexc("#8fe3f5")
PUPIL = hexc("#1b2735")
BLUSH = hexc("#ff9fb4")
BLUSH_LINE = hexc("#f5788f")
MOUTH = hexc("#c25e75")
STAR = hexc("#ffd34e")
WHITE = (255, 255, 255)

def hair_color(px, py):
    return mix(HAIR_T, HAIR_B, clamp((py - 30) / 150, 0.0, 1.0))

def bg_color(px, py):
    t = clamp(((px - 12) + (py - 12)) / (2 * (SIZE - 24)), 0.0, 1.0)
    if t < 0.5:
        return mix(BG1, BG2, t * 2)
    return mix(BG2, BG3, (t - 0.5) * 2)

# ---------------------------------------------------------------- prims
PRIMS = []  # (bbox, color_fn(px,py)->(r,g,b,a), svg markup)

def prim(x0, y0, x1, y1, fn, svg=""):
    PRIMS.append(((x0, y0, x1, y1), fn, svg))

def solid_shape(sd, color, alpha=1.0, w=1.4):
    def fn(px, py):
        return (*color, alpha * edge(sd(px, py), w))
    return fn

def filled(sd, color_fn, w=1.4):
    def fn(px, py):
        r, g, b = color_fn(px, py)
        return (r, g, b, edge(sd(px, py), w))
    return fn

def soft_blob(sd, color, base, sigma):
    def fn(px, py):
        return (*color, base * glow(sd(px, py), sigma))
    return fn

def ring(sd, color, base, mid, half, feather=1.2):
    def fn(px, py):
        a = base * clamp(1.0 - abs(sd(px, py) - mid) / half, 0.0, 1.0)
        return (*color, a)
    return fn

# eye / face geometry
EYE_Y = 166
EYE_RX, EYE_RY = 15, 19
EYES = (100, 156)

def build():
    # ---- background
    prim(0, 0, SIZE, SIZE, lambda px, py: (*bg_color(px, py), edge(sd_round_rect(px, py, 12, 12, 244, 244, 54))),
         '<rect x="12" y="12" width="232" height="232" rx="54" fill="url(#bg)"/>')
    prim(0, 0, SIZE, SIZE, soft_blob(lambda px, py: sd_ellipse(px, py, 110, 92, 95, 85), WHITE, 0.30, 40),
         '<ellipse cx="110" cy="92" rx="95" ry="85" fill="url(#bgglow)"/>')

    def star(cx, cy, a, al):
        b = a * 0.34
        def fn(px, py):
            dx, dy = abs(px - cx), abs(py - cy)
            d = min(dx / a + dy / b, dx / b + dy / a) - 1.0
            return (*WHITE, al * edge(d * b, 1.2))
        return fn

    def svg_star(cx, cy, a, al):
        b = a * 0.34
        p1 = f"M{cx} {cy-a}L{cx+b} {cy}L{cx} {cy+a}L{cx-b} {cy}Z"
        p2 = f"M{cx-a} {cy}L{cx} {cy-b}L{cx+a} {cy}L{cx} {cy+b}Z"
        return f'<g fill="#fff" opacity="{al}"><path d="{p1}"/><path d="{p2}"/></g>'

    for cx, cy, a, al in ((40, 56, 9, 0.85), (216, 42, 6, 0.8), (222, 168, 8, 0.8), (30, 190, 6, 0.75)):
        prim(cx - a - 4, cy - a - 4, cx + a + 4, cy + a + 4, star(cx, cy, a, al), svg_star(cx, cy, a, al))
    for cx, cy, r, al in ((150, 34, 3, 0.55), (36, 122, 2.5, 0.5), (214, 112, 2.5, 0.5)):
        prim(cx - 6, cy - 6, cx + 6, cy + 6, solid_shape(lambda px, py: sd_circle(px, py, cx, cy, r), WHITE, al),
             f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#fff" opacity="{al}"/>')

    # ---- ahoge (drawn before hair so the base tucks under the dome)
    ahoge_segs = ((124, 46, 128, 27), (128, 27, 146, 17))
    for ax, ay, bx, by in ahoge_segs:
        prim(min(ax, bx) - 8, min(ay, by) - 8, max(ax, bx) + 8, max(ay, by) + 8,
             filled(lambda px, py, ax=ax, ay=ay, bx=bx, by=by: sd_seg(px, py, ax, ay, bx, by) - 4.5, hair_color),
             f'<line x1="{ax}" y1="{ay}" x2="{bx}" y2="{by}" stroke="url(#hair)" stroke-width="9" stroke-linecap="round"/>')

    # ---- twin bun on the left (the right slot hosts the code bubble)
    for s in (-1,):
        bx, by = 128 + s * 58, 44
        prim(bx - 26, by - 26, bx + 26, by + 26, filled(lambda px, py, bx=bx, by=by: sd_circle(px, py, bx, by, 21), hair_color),
             f'<circle cx="{bx}" cy="{by}" r="21" fill="url(#hair)"/>')
        prim(bx - 13, by - 16, bx + 8, by + 5,
             solid_shape(lambda px, py, bx=bx, by=by, s=s: sd_circle(px, py, bx - s * 6, by - 8, 6), mix(HAIR_T, WHITE, 0.45), 0.8),
             f'<circle cx="{bx - s * 6}" cy="{by - 8}" r="6" fill="#dcb4f4" opacity="0.8"/>')
        prim(bx - 10, by - 15, bx + 4, by - 1,
             solid_shape(lambda px, py, bx=bx, by=by, s=s: sd_circle(px, py, bx - s * 4, by - 10, 2.3), WHITE, 0.9),
             f'<circle cx="{bx - s * 4}" cy="{by - 10}" r="2.3" fill="#fff" opacity="0.9"/>')

    # ---- face
    prim(56, 88, 200, 218, filled(lambda px, py: sd_ellipse(px, py, 128, 153, 64, 55), lambda px, py: SKIN),
         '<ellipse cx="128" cy="153" rx="64" ry="55" fill="#ffeede"/>')
    prim(64, 108, 192, 152,
         soft_blob(lambda px, py: sd_ellipse(px, py, 128, 131, 56, 13), SHADOW_SKIN, 0.22, 7),
         '<ellipse cx="128" cy="131" rx="56" ry="13" fill="url(#fshadow)"/>')

    # ---- eyes
    for s in (-1, 1):
        ex = 128 + s * 28
        prim(ex - 19, EYE_Y - 23, ex + 19, EYE_Y + 23,
             filled(lambda px, py, ex=ex: sd_ellipse(px, py, ex, EYE_Y, 17, 21), lambda px, py: LINE),
             f'<ellipse cx="{ex}" cy="{EYE_Y}" rx="17" ry="21" fill="#4a3347"/>')
        def iris_fn(px, py, ex=ex):
            t = clamp((py - (EYE_Y - 17)) / 37, 0.0, 1.0)
            return mix(IRIS_T, IRIS_B, t)
        prim(ex - 15, EYE_Y - 19, ex + 15, EYE_Y + 21,
             filled(lambda px, py, ex=ex: sd_ellipse(px, py, ex, EYE_Y + 1, 14, 18.5), iris_fn),
             f'<ellipse cx="{ex}" cy="{EYE_Y + 1}" rx="14" ry="18.5" fill="url(#iris{s})"/>')
        prim(ex - 8, EYE_Y - 6, ex + 8, EYE_Y + 13,
             filled(lambda px, py, ex=ex: sd_ellipse(px, py, ex, EYE_Y + 3.5, 6.5, 9), lambda px, py: PUPIL),
             f'<ellipse cx="{ex}" cy="{EYE_Y + 3.5}" rx="6.5" ry="9" fill="#1b2735"/>')
        prim(ex - 10, EYE_Y + 2, ex + 10, EYE_Y + 17,
             soft_blob(lambda px, py, ex=ex: sd_ellipse(px, py, ex, EYE_Y + 9.5, 9, 5.5), hexc("#aeeeff"), 0.8, 3),
             f'<ellipse cx="{ex}" cy="{EYE_Y + 9.5}" rx="9" ry="5.5" fill="url(#eglow)"/>')
        for cxo, cyo, r, al in ((-5.5, -7, 5.2, 1.0), (5.5, 6, 2.6, 0.92), (1.5, -11.5, 1.6, 0.8)):
            hx, hy = ex + cxo, EYE_Y + cyo
            prim(hx - 7, hy - 7, hx + 7, hy + 7,
                 solid_shape(lambda px, py, hx=hx, hy=hy, r=r: sd_circle(px, py, hx, hy, r), WHITE, al),
                 f'<circle cx="{hx}" cy="{hy}" r="{r}" fill="#fff" opacity="{al}"/>')
        pts = ((ex - s * 14, EYE_Y - 12), (ex, EYE_Y - 18.5), (ex + s * 15, EYE_Y - 14), (ex + s * 20.5, EYE_Y - 18))
        for i in range(3):
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            prim(min(ax, bx) - 6, min(ay, by) - 6, max(ax, bx) + 6, max(ay, by) + 6,
                 filled(lambda px, py, ax=ax, ay=ay, bx=bx, by=by: sd_seg(px, py, ax, ay, bx, by) - 4, lambda px, py: hexc("#3e2b3c")),
                 "")
        svg_pts = " ".join(f"{p[0]},{p[1]}" for p in pts)
        last = PRIMS.pop()
        PRIMS.append(last)
        PRIMS[-1] = (last[0], last[1],
                     f'<polyline points="{svg_pts}" fill="none" stroke="#3e2b3c" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>')

    # ---- blush + omega mouth
    for s in (-1, 1):
        bx = 128 + s * 44
        prim(bx - 20, 166, bx + 20, 196,
             soft_blob(lambda px, py, bx=bx: sd_ellipse(px, py, bx, 181, 13, 8), BLUSH, 0.62, 6),
             f'<ellipse cx="{bx}" cy="181" rx="13" ry="8" fill="url(#blush)"/>')
        for i, (ox1, ox2) in enumerate(((-7, -1), (1, 7))):
            ax, ay = bx + ox1, 176
            bx2, by2 = bx + ox2, 186
            prim(min(ax, bx2) - 4, min(ay, by2) - 4, max(ax, bx2) + 4, max(ay, by2) + 4,
                 filled(lambda px, py, ax=ax, ay=ay, bx2=bx2, by2=by2: sd_seg(px, py, ax, ay, bx2, by2) - 1.7,
                        lambda px, py: BLUSH_LINE, w=1.6) ,
                 "")
            PRIMS[-1] = (PRIMS[-1][0], PRIMS[-1][1],
                         f'<line x1="{ax}" y1="{ay}" x2="{bx2}" y2="{by2}" stroke="#f5788f" stroke-width="3.4" stroke-linecap="round" opacity="0.8"/>')
    mouth_pts = ((120, 189), (124, 193), (128, 189), (132, 193), (136, 189))
    for i in range(4):
        ax, ay = mouth_pts[i]
        bx, by = mouth_pts[i + 1]
        prim(min(ax, bx) - 4, min(ay, by) - 4, max(ax, bx) + 4, max(ay, by) + 4,
             filled(lambda px, py, ax=ax, ay=ay, bx=bx, by=by: sd_seg(px, py, ax, ay, bx, by) - 2.2, lambda px, py: MOUTH, w=1.6), "")
    svg_pts = " ".join(f"{p[0]},{p[1]}" for p in mouth_pts)
    PRIMS[-1] = (PRIMS[-1][0], PRIMS[-1][1],
                 f'<polyline points="{svg_pts}" fill="none" stroke="#c25e75" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>')

    # ---- hair mass on top of the face
    prim(48, 38, 208, 148, filled(lambda px, py: sd_ellipse(px, py, 128, 90, 80, 52), hair_color),
         '<ellipse cx="128" cy="90" rx="80" ry="52" fill="url(#hair)"/>')
    for s in (-1,):
        tx = 128 + s * 58
        prim(tx - 13, 49, tx + 13, 67,
             filled(lambda px, py, tx=tx: sd_ellipse(px, py, tx, 58, 9, 4.5), lambda px, py: hexc("#cf7ec2")),
             f'<ellipse cx="{tx}" cy="58" rx="9" ry="4.5" fill="#cf7ec2"/>')
    prim(50, 76, 206, 142, filled(lambda px, py: sd_ellipse(px, py, 128, 106, 78, 30), hair_color),
         '<ellipse cx="128" cy="106" rx="78" ry="30" fill="url(#hair)"/>')
    for cx, cy, r in ((86, 128, 24), (114, 132, 24), (142, 132, 24), (170, 128, 24)):
        prim(cx - r - 4, cy - r - 4, cx + r + 4, cy + r + 4,
             filled(lambda px, py, cx=cx, cy=cy, r=r: sd_circle(px, py, cx, cy, r), hair_color),
             f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#hair)"/>')
    for s in (-1, 1):
        cx = 128 + s * 70
        prim(cx - 22, 96, cx + 22, 140,
             filled(lambda px, py, cx=cx: sd_circle(px, py, cx, 118, 16), hair_color),
             f'<circle cx="{cx}" cy="118" r="16" fill="url(#hair)"/>')
        prim(cx - 19, 112, cx + 19, 190,
             filled(lambda px, py, s=s: sd_ellipse(px, py, 128 + s * 68, 150, 15, 36), hair_color),
             f'<ellipse cx="{128 + s * 68}" cy="150" rx="15" ry="36" fill="url(#hair)"/>')
    # hair sheen crescent along the upper-left of the dome
    def sheen_fn(px, py):
        d = math.hypot(px - 128, py - 96)
        band = clamp(1.0 - abs(d - 62) / 7.0, 0.0, 1.0)
        gate = clamp((88 - py) / 10.0, 0.0, 1.0) * clamp((px - 62) / 12.0, 0.0, 1.0) * clamp((172 - px) / 16.0, 0.0, 1.0)
        return (*WHITE, 0.45 * band * gate)
    prim(60, 30, 196, 92, sheen_fn,
         '<path d="M70 74 A62 62 0 0 1 168 62" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity="0.45"/>')
    # star hair clip
    def clip_fn(px, py):
        dx, dy = abs(px - 174), abs(py - 104)
        a, b = 11.0, 3.8
        d = min(dx / a + dy / b, dx / b + dy / a) - 1.0
        return (*STAR, edge(d * b, 1.2))
    prim(160, 90, 188, 118, clip_fn,
         '<g fill="#ffd34e"><path d="M174 93L177.8 100.2L185 104L177.8 107.8L174 115L170.2 107.8L163 104L170.2 100.2Z"/></g>')
    prim(168, 98, 180, 110, solid_shape(lambda px, py: sd_circle(px, py, 174, 104, 2.4), WHITE, 0.9),
         '<circle cx="174" cy="104" r="2.4" fill="#fff" opacity="0.9"/>')

    # ---- code bubble in the top-right corner (canvas space, in front of the
    # character, outside the character transform)
    global FRONT_START
    FRONT_START = len(PRIMS)
    CODE = hexc("#4f46e5")
    prim(168, 25, 232, 80,
         soft_blob(lambda px, py: sd_round_rect(px, py - 4, 174, 27, 226, 69, 19), hexc("#312e81"), 0.13, 5), "")
    prim(170, 23, 230, 73,
         filled(lambda px, py: sd_round_rect(px, py, 174, 27, 226, 69, 19), lambda px, py: WHITE),
         '<rect x="174" y="27" width="52" height="42" rx="19" fill="#fff"/>')
    glyph_segs = ((186, 41, 179, 48), (179, 48, 186, 55), (193, 57, 201, 39), (214, 41, 221, 48), (221, 48, 214, 55))
    for ax, ay, bx, by in glyph_segs:
        prim(min(ax, bx) - 5, min(ay, by) - 5, max(ax, bx) + 5, max(ay, by) + 5,
             filled(lambda px, py, ax=ax, ay=ay, bx=bx, by=by: sd_seg(px, py, ax, ay, bx, by) - 3.9, lambda px, py: CODE),
             "")
    PRIMS[-5] = (PRIMS[-5][0], PRIMS[-5][1],
                 '<polyline points="186,41 179,48 186,55" fill="none" stroke="#4f46e5" stroke-width="7.8" stroke-linecap="round" stroke-linejoin="round"/>')
    PRIMS[-3] = (PRIMS[-3][0], PRIMS[-3][1],
                 '<line x1="193" y1="57" x2="201" y2="39" stroke="#4f46e5" stroke-width="7.8" stroke-linecap="round"/>')
    PRIMS[-2] = (PRIMS[-2][0], PRIMS[-2][1],
                 '<polyline points="214,41 221,48 214,55" fill="none" stroke="#4f46e5" stroke-width="7.8" stroke-linecap="round" stroke-linejoin="round"/>')

# ---- character transform: scale up slightly and center vertically
K = 1.07      # scale factor
DX = -12.0    # leftward shift to make room for the code bubble
DY = 10.0     # downward shift
BG_PRIM_COUNT = 9  # squircle, glow, 4 sparkles, 3 dots
FRONT_START = 0    # set by build(): prims from here on are canvas-space foreground


def transform_character():
    head = PRIMS[:BG_PRIM_COUNT]
    chars = PRIMS[BG_PRIM_COUNT:FRONT_START]
    front = PRIMS[FRONT_START:]
    out = list(head)
    for (x0, y0, x1, y1), fn, svg in chars:
        bx0, by0 = 128 + DX + (x0 - 128) * K - 3, 138 + (y0 - 128) * K - 3
        bx1, by1 = 128 + DX + (x1 - 128) * K + 3, 138 + (y1 - 128) * K + 3

        def wrapped(px, py, fn=fn):
            return fn(128 + (px - 128 - DX) / K, 128 + (py - 138) / K)
        out.append(((bx0, by0, bx1, by1), wrapped, svg))
    out.extend(front)
    PRIMS[:] = out


def pixel(x, y):
    total = [0.0, 0.0, 0.0, 0.0]
    for sy_off in range(SS):
        for sx_off in range(SS):
            px = x + (sx_off + 0.5) / SS
            py = y + (sy_off + 0.5) / SS
            bg = sd_round_rect(px, py, 12, 12, SIZE - 12, SIZE - 12, 54)
            if bg > 0.6:
                continue
            r, g, b = bg_color(px, py)
            a_canvas = edge(bg)
            for (x0, y0, x1, y1), fn, _svg in PRIMS:
                if px < x0 or px > x1 or py < y0 or py > y1:
                    continue
                cr, cg, cb, ca = fn(px, py)
                if ca <= 0:
                    continue
                r += (cr - r) * ca
                g += (cg - g) * ca
                b += (cb - b) * ca
            total[0] += r
            total[1] += g
            total[2] += b
            total[3] += a_canvas
    count = SS * SS
    if total[3] <= 0:
        return (0, 0, 0, 0)
    return (int(total[0] / count), int(total[1] / count), int(total[2] / count), int(255 * total[3] / count))

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

SVG_DEFS = '''<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#ffd2e9"/>
      <stop offset="0.5" stop-color="#ddd4ff"/>
      <stop offset="1" stop-color="#cfe9ff"/>
    </linearGradient>
    <radialGradient id="bgglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.4"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hair" x1="0" y1="30" x2="0" y2="180" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#b78ae8"/>
      <stop offset="1" stop-color="#f4a9d2"/>
    </linearGradient>
    <radialGradient id="fshadow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#e8a98c" stop-opacity="0.4"/>
      <stop offset="0.7" stop-color="#e8a98c" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#e8a98c" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="iris-1" x1="0" y1="149" x2="0" y2="186" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2e6fc0"/>
      <stop offset="1" stop-color="#8fe3f5"/>
    </linearGradient>
    <linearGradient id="iris1" x1="0" y1="149" x2="0" y2="186" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2e6fc0"/>
      <stop offset="1" stop-color="#8fe3f5"/>
    </linearGradient>
    <radialGradient id="eglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#aeeeff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#aeeeff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="blush" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ff9fb4" stop-opacity="0.7"/>
      <stop offset="1" stop-color="#ff9fb4" stop-opacity="0"/>
    </radialGradient>
  </defs>'''

def write_svg(path):
    svgs = [svg for _bbox, _fn, svg in PRIMS]
    head = "\n".join(s for s in svgs[:BG_PRIM_COUNT] if s)
    chars = "\n".join(s for s in svgs[BG_PRIM_COUNT:FRONT_START] if s)
    front = "\n".join(s for s in svgs[FRONT_START:] if s)
    tx = DX + 128 * (1 - K)
    ty = DY + 128 * (1 - K)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n{SVG_DEFS}\n'
           f'{head}\n<g transform="translate({tx:.2f},{ty:.2f}) scale({K})">\n{chars}\n</g>\n{front}\n</svg>\n')
    with open(path, "w") as f:
        f.write(svg)
    print(f"wrote {path}")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "assets"
    build()
    transform_character()
    write_png(f"{out}/plugin.png")
    write_svg(f"{out}/plugin.svg")
