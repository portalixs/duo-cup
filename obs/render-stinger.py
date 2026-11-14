"""Regenerate the bundled 60 fps transparent OBS stinger with Pillow and FFmpeg."""

import argparse
from pathlib import Path
from subprocess import Popen

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 1920, 1080
SIZE = WIDTH, HEIGHT
FPS = 60
SLOPE = WIDTH * 0.40


def smooth(value):
    value = max(0, min(value, 1))
    return value * value * (3 - 2 * value)


def edge(draw, point, color):
    draw.polygon([(-1, 0), (point, 0), (point - SLOPE, HEIGHT), (-1, HEIGHT)], fill=color)


def artwork(font_path):
    gradient = Image.linear_gradient('L').rotate(-90, expand=True).resize(SIZE)
    slate = Image.new('RGB', SIZE, '#081022')
    blue = Image.new('RGB', SIZE, '#2041a0')
    red = Image.new('RGB', SIZE, '#591631')
    shaded = Image.composite(blue, slate, gradient.point(lambda x: max(0, (x - 126) * 2)))
    shaded = Image.composite(red, shaded, gradient.point(lambda x: max(0, (80 - x) * 3)))
    face = ImageDraw.Draw(shaded)
    for x, color in [(245, '#536aa6'), (365, '#344e85'), (1760, '#5b2848'), (1830, '#78305a')]:
        face.line([(x, 0), (x - SLOPE, HEIGHT)], fill=color, width=2)
    font = ImageFont.truetype(font_path, 132)
    face.text((WIDTH // 2, HEIGHT // 2), 'DUO CUP', font=font, anchor='mm', fill='#f0f3ff')
    face.polygon([(875, 627), (1055, 627), (1045, 644), (865, 644)], fill='#5082fa')
    return shaded


def frame(index, slate):
    point = -150 + (WIDTH + SLOPE + 320) * smooth(index / 23)
    tail = -130 + (WIDTH + SLOPE + 200) * smooth((index - 28) / 22)
    coverage = Image.new('L', SIZE)
    draw = ImageDraw.Draw(coverage)
    edge(draw, point, 255)
    edge(draw, tail, 0)

    coloring = slate.copy()
    draw = ImageDraw.Draw(coloring)
    for width, color in [(156, '#3157ef'), (84, '#8db9ff'), (34, '#f4e5f6'), (11, '#f43768')]:
        draw.polygon([(point - width, 0), (point, 0), (point - SLOPE, HEIGHT),
                      (point - SLOPE - width, HEIGHT)], fill=color)
    for width, color in [(96, '#3157ef'), (52, '#97bfff'), (13, '#f43768')]:
        draw.polygon([(tail, 0), (tail + width, 0), (tail + width - SLOPE, HEIGHT),
                      (tail - SLOPE, HEIGHT)], fill=color)
    coloring.putalpha(coverage)
    return coloring


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--font', default='segoeuib.ttf')
    arguments = parser.parse_args()
    slate = artwork(arguments.font)
    output = Path(__file__).with_name('duo-cup-wave.webm')
    command = [arguments.ffmpeg, '-hide_banner', '-loglevel', 'warning', '-y', '-f', 'rawvideo',
               '-pix_fmt', 'rgba', '-video_size', f'{WIDTH}x{HEIGHT}', '-framerate', str(FPS),
               '-i', 'pipe:0', '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
               '-crf', '20', '-b:v', '0', '-row-mt', '1', '-cpu-used', '3', str(output)]
    with Popen(command, stdin=-1) as process:
        with process.stdin as stream:
            for index in range(52):
                stream.write(frame(index, slate).tobytes())
        if process.wait() != 0:
            raise SystemExit('FFmpeg could not encode the stinger')


if __name__ == '__main__':
    main()
