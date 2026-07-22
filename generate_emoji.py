#!/usr/bin/env python3
"""
Generate exhaustive grayscale emoji PNGs for Kindle e-ink display.
Renders from the Noto COLRv1 font as monochrome images.
"""
import os
import sys
import json
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'emoji')
FONT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'OpenMoji-Black.ttf')
PNG_SIZE = 48

# All emoji codepoints from Unicode 15.1 ranges
EMOJI_RANGES = [
    (0x2300, 0x23FF),    # Misc technical
    (0x2600, 0x27BF),   # Misc symbols & dingbats  
    (0x2B00, 0x2BFF),    # Supplemental arrows & symbols
    (0x1F000, 0x1F0FF),  # Mahjong, dominoes, playing cards
    (0x1F100, 0x1F1FF),  # Enclosed alphanumeric supplement
    (0x1F200, 0x1F2FF),  # Enclosed ideographic supplement
    (0x1F300, 0x1FAFF),  # Symbols & Pictographs + Extensions A, C
    (0x1FB00, 0x1FBFF),  # Symbols for Legacy Computing
]

# Skip these (non-visual, control chars, variation selectors)
SKIP = {
    0xFE0F, 0xFE0E, 0x200D, 0x20E3,
}

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    font = ImageFont.truetype(FONT_PATH, PNG_SIZE)
    
    generated = {}
    skipped = 0
    empty = 0
    
    for start, end in EMOJI_RANGES:
        for cp in range(start, end + 1):
            if cp in SKIP:
                skipped += 1
                continue
            
            ch = chr(cp)
            
            # Render to RGBA image with transparent background
            img = Image.new('RGBA', (PNG_SIZE, PNG_SIZE), (255, 255, 255, 0))
            draw = ImageDraw.Draw(img)
            
            # Get glyph bounding box for centering
            try:
                bbox = draw.textbbox((0, 0), ch, font=font)
                w = bbox[2] - bbox[0]
                h = bbox[3] - bbox[1]
                if w == 0 or h == 0:
                    empty += 1
                    continue
                x = (PNG_SIZE - w) // 2 - bbox[0]
                y = (PNG_SIZE - h) // 2 - bbox[1]
                draw.text((x, y), ch, font=font, fill=(0, 0, 0, 255))
            except Exception:
                empty += 1
                continue
            
            # Check if the image is actually non-blank (alpha channel)
            bbox = img.getbbox()
            if bbox is None:
                empty += 1
                continue
            
            # Save as PNG
            filename = 'U{:05X}.png'.format(cp)
            filepath = os.path.join(OUT_DIR, filename)
            img.save(filepath, 'PNG')
            
            generated[cp] = filename
    
    # Write the lookup table
    lookup_path = os.path.join(OUT_DIR, 'emoji_map.json')
    lookup = {}
    for cp, fname in sorted(generated.items()):
        lookup[str(cp)] = fname
    with open(lookup_path, 'w') as f:
        json.dump(lookup, f, indent=0)
    
    print('Generated {} emoji PNGs ({} skipped, {} empty)'.format(
        len(generated), skipped, empty))
    print('Output: {}/'.format(OUT_DIR))
    print('Lookup: {}'.format(lookup_path))

if __name__ == '__main__':
    main()
