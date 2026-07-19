import unittest
from unittest.mock import patch

from local_transcriber.bilibili_audio import validate_audio_url


PUBLIC_CDN = "https://xy120x209x102x30xy.mcdn.bilivideo.cn:8082/audio.m4s?token=1"
FALLBACK_CDN = "https://809aj93l.edge.mountaintoys.cn:4483/audio.m4s?token=1"


class AudioUrlTests(unittest.TestCase):
    @patch("local_transcriber.bilibili_audio._is_private_host", return_value=False)
    def test_accepts_bilibili_cdn(self, _private):
        validate_audio_url(PUBLIC_CDN)
        validate_audio_url(FALLBACK_CDN)

    def test_rejects_non_https(self):
        with self.assertRaises(ValueError):
            validate_audio_url("http://audio.hdslb.com/audio.m4s")

    def test_rejects_untrusted_host(self):
        with self.assertRaises(ValueError):
            validate_audio_url("https://example.com/audio.m4s")
        validate_audio_url(FALLBACK_CDN)

    def test_rejects_local_host(self):
        with self.assertRaises(ValueError):
            validate_audio_url("https://127.0.0.1/audio.m4s")


if __name__ == "__main__":
    unittest.main()

