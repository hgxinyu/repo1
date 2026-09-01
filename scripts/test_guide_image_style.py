import unittest

from PIL import Image, ImageChops, ImageFont

from guide_image_style import add_guide_watermark


FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size, bold=False):
    return ImageFont.truetype(FONT_PATH, size)


class GuideWatermarkTests(unittest.TestCase):
    def test_watermark_stays_subtle_and_centered_without_resizing(self):
        source = Image.new("RGB", (1000, 1400), "white")

        result = add_guide_watermark(source, font)
        difference = ImageChops.difference(source, result)

        self.assertEqual(result.size, source.size)
        self.assertEqual(result.mode, source.mode)
        self.assertIsNone(difference.crop((0, 0, 1000, 350)).getbbox())
        self.assertIsNotNone(difference.crop((100, 450, 900, 1050)).getbbox())
        self.assertLessEqual(max(channel[1] for channel in difference.getextrema()), 20)

    def test_watermark_preserves_explicit_safe_boxes(self):
        source = Image.new("RGB", (1000, 1400), "white")
        safe_box = (350, 550, 650, 850)

        result = add_guide_watermark(source, font, safe_boxes=(safe_box,))
        difference = ImageChops.difference(source, result)

        self.assertIsNone(difference.crop(safe_box).getbbox())
        self.assertIsNotNone(difference.crop((100, 450, 900, 1050)).getbbox())


if __name__ == "__main__":
    unittest.main()
