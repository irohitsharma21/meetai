"""
The languages MeetAI can transcribe, translate into, and speak.

One table, shared by accounts (native language), speech-to-text (which
language to decode each speaker in), translation and text-to-speech, so a
code accepted in one place is never rejected in another.

`stt` is whether Deepgram nova-3 transcribes the language. It was probed
against the live API rather than taken from docs: Malayalam, Odia and Sinhala
return 400, so people who speak them can *receive* translations but cannot yet
be transcribed.

`multi` marks languages covered by nova-3's code-switching mode
(`language=multi`). A Hindi speaker is decoded with `multi` because real
meetings are Hinglish - "hamari TTS ki latency" - and the monolingual Hindi
model transliterates the English words. Tamil is deliberately *not* in it:
tested with `multi`, Tamil speech came back as nonsense Devanagari, and
automatic language detection labelled the same Tamil clip as English. That is
why each speaker is transcribed in their declared language instead of relying
on detection.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    code: str        # short code used everywhere in the app ("ta")
    name: str        # English name ("Tamil")
    native: str      # endonym, shown in pickers ("தமிழ்")
    locale: str      # BCP-47 locale for browser speech voices ("ta-IN")
    stt: bool        # Deepgram nova-3 can transcribe it
    multi: bool = False  # covered by nova-3 `language=multi` code-switching

    def to_dict(self) -> dict:
        return {
            "code": self.code, "name": self.name, "native": self.native,
            "locale": self.locale, "stt": self.stt,
        }


_ALL = [
    Language("en", "English", "English", "en-IN", True, True),
    Language("hi", "Hindi", "हिन्दी", "hi-IN", True, True),
    Language("ta", "Tamil", "தமிழ்", "ta-IN", True),
    Language("te", "Telugu", "తెలుగు", "te-IN", True),
    Language("kn", "Kannada", "ಕನ್ನಡ", "kn-IN", True),
    Language("ml", "Malayalam", "മലയാളം", "ml-IN", False),
    Language("bn", "Bengali", "বাংলা", "bn-IN", True),
    Language("mr", "Marathi", "मराठी", "mr-IN", True),
    Language("gu", "Gujarati", "ગુજરાતી", "gu-IN", True),
    Language("pa", "Punjabi", "ਪੰਜਾਬੀ", "pa-IN", True),
    Language("ur", "Urdu", "اردو", "ur-IN", True),
    Language("or", "Odia", "ଓଡ଼ିଆ", "or-IN", False),
    Language("as", "Assamese", "অসমীয়া", "as-IN", True),
    Language("ne", "Nepali", "नेपाली", "ne-NP", True),
    Language("es", "Spanish", "Español", "es-ES", True, True),
    Language("fr", "French", "Français", "fr-FR", True, True),
    Language("de", "German", "Deutsch", "de-DE", True, True),
    Language("it", "Italian", "Italiano", "it-IT", True, True),
    Language("pt", "Portuguese", "Português", "pt-BR", True, True),
    Language("nl", "Dutch", "Nederlands", "nl-NL", True, True),
    Language("ru", "Russian", "Русский", "ru-RU", True, True),
    Language("ja", "Japanese", "日本語", "ja-JP", True, True),
    Language("ko", "Korean", "한국어", "ko-KR", True),
    Language("zh", "Chinese", "中文", "zh-CN", True),
    Language("ar", "Arabic", "العربية", "ar-SA", True),
    Language("tr", "Turkish", "Türkçe", "tr-TR", True),
    Language("id", "Indonesian", "Bahasa Indonesia", "id-ID", True),
    Language("vi", "Vietnamese", "Tiếng Việt", "vi-VN", True),
    Language("th", "Thai", "ไทย", "th-TH", True),
    Language("pl", "Polish", "Polski", "pl-PL", True),
    Language("uk", "Ukrainian", "Українська", "uk-UA", True),
    Language("sv", "Swedish", "Svenska", "sv-SE", True),
]

LANGUAGES: dict[str, Language] = {lang.code: lang for lang in _ALL}
DEFAULT_LANGUAGE = "en"


def normalise(code: str | None, default: str | None = DEFAULT_LANGUAGE) -> str | None:
    """Map "ta-IN", "TA", " ta " to "ta"; unknown codes to `default`."""
    if not code:
        return default
    short = code.strip().lower().replace("_", "-").split("-")[0]
    return short if short in LANGUAGES else default


def deepgram_language(code: str | None) -> str:
    """
    The `language` parameter to open a speaker's Deepgram stream with.

    Hindi speakers get `multi` so Hinglish survives; everyone else gets their
    own language (English stays on the monolingual model it has always used).
    A language nova-3 cannot decode falls back to `multi` - wrong, but better
    than a stream that refuses to open and leaves the speaker with no
    transcript at all.
    """
    lang = LANGUAGES.get(normalise(code) or "")
    if lang is None or not lang.stt or lang.code in HINGLISH:
        return "multi"
    return lang.code


# Decoded with `multi` because speakers routinely mix in English.
HINGLISH = {"hi"}


def name_of(code: str | None) -> str:
    lang = LANGUAGES.get(normalise(code) or "")
    return lang.name if lang else (code or "Unknown")
