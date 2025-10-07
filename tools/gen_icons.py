#!/usr/bin/env python3
import os, zlib, struct

def write_png(path, w, h, pixels):
    # pixels: list of rows, each row is bytes RGBA len w*4
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    # add filter byte 0 at start of each row
    raw = b''.join(b'\x00' + row for row in pixels)
    comp = zlib.compress(raw, 9)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', comp) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(data)

def lerp(a, b, t):
    return int(a + (b - a) * t)

def hex_to_rgb(hexstr):
    hexstr = hexstr.lstrip('#')
    return tuple(int(hexstr[i:i+2], 16) for i in (0, 2, 4))

def make_icon(w, h, top_hex, bottom_hex, circle_ratio=0.32):
    top = hex_to_rgb(top_hex)
    bottom = hex_to_rgb(bottom_hex)
    cx, cy = w // 2, h // 2
    r = int(min(w, h) * circle_ratio)
    r2 = r * r
    rows = []
    for y in range(h):
        t = y / max(1, h - 1)
        rch = lerp(top[0], bottom[0], t)
        gch = lerp(top[1], bottom[1], t)
        bch = lerp(top[2], bottom[2], t)
        row = bytearray()
        for x in range(w):
            dx, dy = x - cx, y - cy
            inside = (dx*dx + dy*dy) <= r2
            if inside:
                row += bytes((255, 255, 255, 255))
            else:
                row += bytes((rch, gch, bch, 255))
        rows.append(bytes(row))
    return rows

def main():
    os.makedirs('icons', exist_ok=True)
    # Brand gradient: indigo-500 -> indigo-900
    grad_top = '#6366f1'
    grad_bottom = '#312e81'
    for size in (192, 512):
        rows = make_icon(size, size, grad_top, grad_bottom, circle_ratio=0.30 if size<256 else 0.28)
        write_png(os.path.join('icons', f'icon-{size}.png'), size, size, rows)

if __name__ == '__main__':
    main()

