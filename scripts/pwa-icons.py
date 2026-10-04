"""Generate Reality OS PWA icons with PIL (eye motif, cyan on #0a0a0f).

Icon set:
  public/icons/icon-192.png          192x192, purpose: any
  public/icons/icon-512.png          512x512, purpose: any
  public/icons/icon-maskable-512.png 512x512, purpose: maskable (design in 80% safe zone)
"""
import os
from PIL import Image, ImageDraw

BG = (10, 10, 15, 255)
CYAN = (0, 246, 255, 255)
CYAN_DIM = (0, 212, 255, 255)
IRIS = (10, 40, 50, 255)
PUPIL = (10, 10, 15, 255)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'icons')


def draw_eye(img, cx, cy, r, pad=1.0):
    d = ImageDraw.Draw(img)
    # Almond eye: two arcs via ellipse outline, squashed vertically
    w, h = int(r * 2.2 * pad), int(r * 1.15 * pad)
    bbox = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
    d.ellipse(bbox, outline=CYAN, width=max(2, int(r * 0.09)))
    # Iris
    ir = int(r * 0.62 * pad)
    d.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=IRIS, outline=CYAN_DIM, width=max(2, int(r * 0.07)))
    # Pupil
    pr = int(r * 0.28 * pad)
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=PUPIL)
    # Glint
    gr = int(r * 0.10 * pad)
    d.ellipse([cx - ir * 0.55 - gr, cy - ir * 0.55 - gr, cx - ir * 0.55 + gr, cy - ir * 0.55 + gr], fill=CYAN)


def make(size, maskable=False):
    img = Image.new('RGBA', (size, size), BG)
    if maskable:
        # Design inside the ~80% safe zone, centered
        draw_eye(img, size / 2, size / 2, size * 0.30, pad=0.8)
    else:
        draw_eye(img, size / 2, size / 2, size * 0.40)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    specs = [('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)]
    for name, size, maskable in specs:
        path = os.path.join(OUT, name)
        make(size, maskable).save(path, 'PNG', optimize=True)
        print('wrote', path, os.path.getsize(path), 'bytes')
    # Verify PNG magic + IHDR dimensions
    for name, size, _ in specs:
        path = os.path.join(OUT, name)
        with open(path, 'rb') as f:
            head = f.read(33)
        assert head[:8] == b'\x89PNG\r\n\x1a\n', f'{name}: bad PNG magic'
        w = int.from_bytes(head[16:20], 'big')
        h = int.from_bytes(head[20:24], 'big')
        assert (w, h) == (size, size), f'{name}: expected {size}x{size}, got {w}x{h}'
        print('verified', name, f'{w}x{h} PNG')


if __name__ == '__main__':
    main()
