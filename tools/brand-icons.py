"""Makes Venom Board's icons from the VenomStudios brand (the shared VenomUI kit).

    python -s tools/brand-icons.py [path to VenomUI\\assets]

Writes assets/icon.ico (window, taskbar, tray, installer), assets/icon.png (256 px), assets/icon-1024.png
(macOS and Linux), assets/icon.svg (the website's favicon; a small PNG inside an SVG so every page that links
/favicon.svg keeps working) and assets/brand/ (the mark and the full logo, small enough to inline in index.html with tools/brand-inline.py).
Needs Pillow.
"""
import base64, io, os, shutil, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', '..', 'VenomUI', 'assets')
A = os.path.join(ROOT, 'assets')
os.makedirs(os.path.join(A, 'brand'), exist_ok=True)

mark = Image.open(os.path.join(SRC, 'venomstudios_mark.png')).convert('RGBA')
logo = Image.open(os.path.join(SRC, 'venomstudios_logo.png')).convert('RGBA')

shutil.copyfile(os.path.join(SRC, 'venomstudios.ico'), os.path.join(A, 'icon.ico'))
mark.resize((256, 256), Image.LANCZOS).save(os.path.join(A, 'icon.png'), optimize=True)
mark.resize((1024, 1024), Image.LANCZOS).save(os.path.join(A, 'icon-1024.png'), optimize=True)

def png_bytes(im, size):
    buf = io.BytesIO(); im.resize(size, Image.LANCZOS).save(buf, 'PNG', optimize=True); return buf.getvalue()

# favicon: 64 px PNG wrapped in SVG
fav = base64.b64encode(png_bytes(mark, (64, 64))).decode()
with open(os.path.join(A, 'icon.svg'), 'w', newline='\n') as f:
    f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            f'<image width="64" height="64" href="data:image/png;base64,{fav}"/></svg>\n')

# in-app pictures: the mark at 2x of its largest use, the logo for the About box, and a 32 px favicon
mark.resize((128, 128), Image.LANCZOS).save(os.path.join(A, 'brand', 'mark-128.webp'), quality=88, method=6)
mark.resize((32, 32), Image.LANCZOS).save(os.path.join(A, 'brand', 'mark-32.png'), optimize=True)
logo.resize((288, 288), Image.LANCZOS).save(os.path.join(A, 'brand', 'logo-288.webp'), quality=88, method=6)
for n in ('mark-32.png', 'mark-128.webp', 'logo-288.webp'):
    print(n, os.path.getsize(os.path.join(A, 'brand', n)), 'bytes')
