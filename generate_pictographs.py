#!/usr/bin/env python3
"""
Generate grayscale PNGs for pictographic scripts not covered by emoji fonts.
Covers: Cuneiform (U+12000-1247F), Egyptian Hieroglyphs (U+13000-1342F),
Linear B (U+10000-1003F), etc.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'emoji')

SCRIPTS = [
    ('NotoSansCuneiform.ttf', 0x12000, 0x1247F),   # Cuneiform
    # Add more fonts/ranges as needed
]

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    count = 0

    for font_file, start, end in SCRIPTS:
        font_path = os.path.join(base_dir, font_file)
        if not os.path.exists(font_path):
            print('Font not found:', font_path)
            continue
        font = ImageFont.truetype(font_path, 48)

        for cp in range(start, end + 1):
            ch = chr(cp)
            img = Image.new('RGBA', (48, 48), (255, 255, 255, 0))
            draw = ImageDraw.Draw(img)
            try:
                bbox = draw.textbbox((0, 0), ch, font=font)
                w = bbox[2] - bbox[0]
                h = bbox[3] - bbox[1]
                if w == 0 or h == 0:
                    continue
                x = (48 - w) // 2 - bbox[0]
                y = (48 - h) // 2 - bbox[1]
                draw.text((x, y), ch, font=font, fill=(0, 0, 0, 255))
            except Exception:
                continue
            bbox_check = img.getbbox()
            if bbox_check is None:
                continue
            filename = 'U{:05X}.png'.format(cp)
            filepath = os.path.join(OUT_DIR, filename)
            if not os.path.exists(filepath):
                img.save(filepath, 'PNG')
                count += 1

    print('Generated {} pictographic script PNGs'.format(count))

if __name__ == '__main__':
    main()
