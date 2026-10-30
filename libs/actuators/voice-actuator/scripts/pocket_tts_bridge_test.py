"""Dependency-free contract tests; no model downloads or audio devices."""

import sys
import types
import unittest
from unittest.mock import Mock, patch

import pocket_tts_bridge as bridge


class PocketModelSelectionTests(unittest.TestCase):
    def setUp(self):
        bridge._MODEL = None
        bridge._MODEL_ID = None
        bridge._VOICE_CACHE.clear()
        self.loader = Mock(side_effect=lambda **kwargs: Mock())
        self.module = types.SimpleNamespace(TTSModel=types.SimpleNamespace(load_model=self.loader))
        self.modules = patch.dict(sys.modules, {"pocket_tts": self.module})
        self.modules.start()

    def tearDown(self):
        self.modules.stop()
        bridge._MODEL = None
        bridge._MODEL_ID = None
        bridge._VOICE_CACHE.clear()

    def test_legacy_default_preserves_upstream_default_call(self):
        self.assertIs(bridge._model(), bridge._model())
        self.loader.assert_called_once_with()

    def test_small_models_use_packaged_language_configs(self):
        for model in ("english_18m_2026-10", "english_7m_2026-10", "english_2m_2026-10"):
            with self.subTest(model=model):
                bridge._model(model)
                self.loader.assert_called_with(language=model)

    def test_model_switch_discards_incompatible_voice_state(self):
        first = bridge._model()
        bridge._voice_state(first, "alba")
        second = bridge._model("english_7m_2026-10")
        self.assertIsNot(first, second)
        self.assertFalse(bridge._VOICE_CACHE)
        bridge._voice_state(second, "alba")
        second.get_state_for_audio_prompt.assert_called_once_with("alba")

    def test_rejects_arbitrary_config_before_model_load(self):
        for model in ("../../foreign.yaml", "https://example.com/model.yaml", "japanese"):
            with self.subTest(model=model), self.assertRaisesRegex(ValueError, "Unsupported"):
                bridge._model(model)
        self.loader.assert_not_called()

    def test_voice_state_cache_is_bounded_and_lru(self):
        model = bridge._model()
        for index in range(bridge._MAX_VOICE_STATES):
            bridge._voice_state(model, f"voice-{index}")
        bridge._voice_state(model, "voice-0")
        bridge._voice_state(model, "new-voice")
        self.assertEqual(len(bridge._VOICE_CACHE), bridge._MAX_VOICE_STATES)
        self.assertIn("voice-0", bridge._VOICE_CACHE)
        self.assertNotIn("voice-1", bridge._VOICE_CACHE)

    def test_japanese_is_rejected_without_loading_english_model(self):
        result = bridge._generate({"text": "こんにちは", "output_path": "unused.wav", "lang_code": "ja"})
        self.assertEqual(result["status"], "error")
        self.loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
