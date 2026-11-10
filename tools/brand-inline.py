"""Puts the brand into index.html, so the app needs no font service or picture files (it also runs as one file).

    python -s tools/brand-inline.py

Fills in, from assets/: the favicon (brand/mark-32.png), the mark in the top bar (brand/mark-128.webp), the logo
in Settings > About (brand/logo-288.webp) and the fonts (fonts/*.woff2: Orbitron for titles, Share Tech Mono for
data; SIL Open Font License, see fonts/OFL-*.txt). Run tools/brand-icons.py first to remake the pictures.
Running it again replaces what an earlier run put in.
"""
import base64, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, 'assets')
PATH = os.path.join(ROOT, 'index.html')
b64 = lambda *p: base64.b64encode(open(os.path.join(A, *p), 'rb').read()).decode()

FONTS = [('Orbitron', 500, 'orbitron-latin-500-normal.woff2'), ('Orbitron', 700, 'orbitron-latin-700-normal.woff2'),
         ('Orbitron', 800, 'orbitron-latin-800-normal.woff2'), ('Orbitron', 900, 'orbitron-latin-900-normal.woff2'),
         ('Share Tech Mono', 400, 'share-tech-mono-latin-400-normal.woff2')]
faces = ''.join(f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;"
                f"src:url(data:font/woff2;base64,{b64('fonts', f)}) format('woff2')}}" for fam, w, f in FONTS)

s = open(PATH, encoding='utf-8').read()
subs = [
    (r'<link rel="icon" href="data:image/png;base64,[^"]*">', f'<link rel="icon" href="data:image/png;base64,{b64("brand", "mark-32.png")}">'),
    (r'<img class="mark" src="data:image/webp;base64,[^"]*"', f'<img class="mark" src="data:image/webp;base64,{b64("brand", "mark-128.webp")}"'),
    (r"const BRAND_LOGO = 'data:image/webp;base64,[^']*';", f"const BRAND_LOGO = 'data:image/webp;base64,{b64('brand', 'logo-288.webp')}';"),
    (r'/\* brand fonts \*/.*?/\* end brand fonts \*/', f'/* brand fonts */{faces}/* end brand fonts */'),
]
for pat, rep in subs:
    s, n = re.subn(pat, lambda m: rep, s, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f'not found in index.html: {pat[:60]}')
open(PATH, 'w', encoding='utf-8', newline='').write(s)
print('index.html:', len(s.encode('utf-8')), 'bytes')
