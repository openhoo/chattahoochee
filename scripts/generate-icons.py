"""Generate Chattahoochee's original chat icon. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
out = root / 'src-tauri' / 'icons'
out.mkdir(parents=True, exist_ok=True)
scale = 2
image = Image.new('RGBA', (1024 * scale, 1024 * scale))
draw = ImageDraw.Draw(image)

def rounded(box, radius, fill):
    draw.rounded_rectangle(tuple(int(v * scale) for v in box), int(radius * scale), fill=fill)

def polygon(points, fill):
    draw.polygon([(int(x * scale), int(y * scale)) for x, y in points], fill=fill)

rounded((48, 48, 976, 976), 218, '#7461D3')
rounded((185, 223, 717, 626), 115, '#FFFFFF')
polygon([(235, 567), (235, 719), (407, 603)], '#FFFFFF')
rounded((448, 473, 836, 765), 93, '#C6BAFF')
polygon([(793, 699), (793, 832), (641, 744)], '#C6BAFF')
for x in (302, 428, 554):
    rounded((x, 389, x + 47, 436), 24, '#7461D3')
image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
image.save(out / 'icon.png')
for size, filename in ((32, '32x32.png'), (128, '128x128.png'), (256, '128x128@2x.png')):
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / filename)
image.save(out / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.save(out / 'icon.icns')
(root / 'public').mkdir(exist_ok=True)
image.resize((64, 64), Image.Resampling.LANCZOS).save(root / 'public' / 'icon.png')
print('Generated original Chattahoochee icons.')
