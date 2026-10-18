from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.music_matching import choose_recording, matching_queries, normalized, recording_match


def spotify(title: str = "Round Ere", artist: str = "K Motionz", duration: float = 274.285) -> dict:
    return {"provider": "spotify", "title": title, "artist": artist, "duration": duration}


def recording(
    title: str = "K Motionz - Round Ere",
    artist: str = "#alldayjumpup #",
    duration: float = 275,
    identity: str = "2ZVgOWAflII",
) -> dict:
    return {"title": title, "artist": artist, "duration": duration, "youtube_id": identity}


def test_round_ere_mashup_is_rejected_and_correct_recording_is_ranked_first() -> None:
    mashup = recording("Turno - Asylum X K Motionz - Round Ere", "DJ James W", 297, "DKWXsaZadKs")
    other_song = recording("Flex", "K Motionz", 275, "vAbk3yp51rY")
    snippet = recording("K Motionz - round ere", "Remo Bxssanino", 64, "HmmDzY1z2YA")
    remix = recording("K Motionz - Round Ere (Toxinate & Latte Remix)", "Insohmnia", 48, "VJHGEgoQMAU")
    desired = recording()
    chosen = choose_recording(spotify(), [mashup, other_song, snippet, remix, desired])
    assert chosen is not None
    assert chosen.track["youtube_id"] == "2ZVgOWAflII"
    assert recording_match(spotify(), {**mashup, "duration": 274}) is None


def test_artist_channel_is_preferred_to_unofficial_copy_of_same_recording() -> None:
    official = recording("Round Ere", "K Motionz - Topic", identity="TcweJonSBBI")
    chosen = choose_recording(spotify(), [recording(), official])
    assert chosen is not None
    assert chosen.track["youtube_id"] == "TcweJonSBBI"


@pytest.mark.parametrize(
    ("title", "artist", "duration"),
    [
        ("K Motionz - Round Ere (Bootleg)", "Artist", 274),
        ("K Motionz - Round Ere (Live)", "Artist", 274),
        ("K Motionz - Round Ere (Acoustic Cover)", "Artist", 274),
        ("K Motionz - Round Ere (Sped Up)", "Artist", 274),
        ("K Motionz - Round Ere (Slowed & Reverb)", "Artist", 274),
        ("K Motionz - Round Ere (Extended Mix)", "Artist", 274),
        ("K Motionz - Round Ere (Radio Edit)", "Artist", 274),
        ("K Motionz - Round Ere VIP", "Artist", 274),
        ("Round Ere", "Another Artist", 274),
        ("K Motionz - Another Song", "K Motionz", 274),
        ("Round Ere", "K Motionz", 120),
        ("Round Ere", "K Motionz", 1200),
        ("Round Ere", "K Motionz", float("nan")),
        ("Round Ere", "K Motionz", 0),
    ],
)
def test_wrong_versions_artists_titles_and_durations_are_not_silently_matched(
    title: str, artist: str, duration: float
) -> None:
    assert choose_recording(spotify(), [recording(title, artist, duration)]) is None


@pytest.mark.parametrize("suffix", ["(Official Audio)", "[Official Music Video]", "(Lyrics)", "(FULL)", "HD"])
def test_cosmetic_video_labels_do_not_hide_correct_recording(suffix: str) -> None:
    assert recording_match(spotify(), recording("K Motionz - Round Ere " + suffix)) is not None


def test_punctuation_diacritics_and_featured_artist_labels_are_normalized() -> None:
    desired = spotify("L'amour & l'été (feat. A$AP)", "André, A$AP", 180)
    candidate = recording("Andre - Lamour and lete ft. A$AP [Official Video]", "Andre - Topic", 181)
    assert recording_match(desired, candidate) is not None
    assert normalized("DON\u2019T stop") == "dont stop"


@pytest.mark.parametrize(
    ("title", "artist", "candidate_title", "duration"),
    [
        (
            "Baddadan (feat. IRAH, Flowdan, Trigga & Takura)",
            "Chase & Status, Bou, Flowdan, IRAH, Trigga, Takura",
            "Chase & Status and Bou - Baddadan Feat. IRAH, Flowdan, Trigga and Takura (Visualiser)",
            177.291,
        ),
        ("Of Two Minds", "IMANU, Rhode", "IMANU x Rhode - Of Two Minds (Visualizer)", 279.069),
    ],
)
def test_collaboration_joiners_disappear_only_with_known_performer_names(
    title: str, artist: str, candidate_title: str, duration: float
) -> None:
    assert (
        recording_match(spotify(title, artist, duration), recording(candidate_title, artist, duration + 1)) is not None
    )


def test_collaboration_cleanup_preserves_title_connector_words() -> None:
    desired = spotify("And I", "Artist", 180)
    assert recording_match(desired, recording("Artist - And I", "Artist", 180)) is not None
    assert recording_match(desired, recording("Artist - I", "Artist", 180)) is None


def test_artist_compact_spelling_does_not_match_substrings_of_other_names() -> None:
    assert recording_match(spotify(), recording("KMotionz - Round Ere")) is not None
    assert recording_match(spotify(artist="Air"), recording("Round Ere", "Fairground")) is None


def test_requested_remixer_and_version_must_match() -> None:
    desired = spotify("Push The Tempo - K Motionz Remix", "Sub Focus, Katy B, K Motionz", 227.571)
    correct = recording("Sub Focus - Push The Tempo (K Motionz Remix) ft. Katy B", "Sub Focus", 228)
    wrong_remixer = recording("Sub Focus - Push The Tempo (1991 Remix)", "Sub Focus", 228)
    original = recording("Sub Focus - Push The Tempo", "Sub Focus", 228)
    assert recording_match(desired, correct) is not None
    assert recording_match(desired, wrong_remixer) is None
    assert recording_match(desired, original) is None


def test_postfix_version_is_preserved_after_parenthesized_featured_artists() -> None:
    desired = spotify("Balling (feat. Songer, Mr Traumatik) - Edit", "Vibe Chemistry, Songer, Mr Traumatik", 180)
    correct = recording("Vibe Chemistry - Balling (Edit)", "Vibe Chemistry - Topic", 181)
    original = recording("Vibe Chemistry - Balling", "Vibe Chemistry - Topic", 181)
    assert recording_match(desired, correct) is not None
    assert recording_match(desired, original) is None


def test_featured_credit_before_title_does_not_discard_song_name() -> None:
    desired = spotify("Program", "Chase & Status, IRAH", 252.36)
    candidate = recording("Chase & Status feat. IRAH - Program (Original Mix)", "Chase & Status", 252)
    assert recording_match(desired, candidate) is not None


def test_remaster_label_and_year_are_cosmetic_for_same_song_and_duration() -> None:
    desired = spotify("Song - 2011 Remaster", "Artist", 180)
    assert recording_match(desired, recording("Artist - Song", "Artist", 181)) is not None
    assert recording_match(spotify("Song", "Artist", 180), recording("Song (Remastered 2024)", "Artist", 180))


def test_short_recording_does_not_allow_large_relative_duration_error() -> None:
    assert recording_match(spotify("Intro", "Artist", 15), recording("Artist - Intro", "Artist", 25)) is None


def test_cosmetic_words_can_still_be_the_actual_song_title() -> None:
    assert recording_match(spotify("Music", "Artist", 180), recording("Artist - Music", "Artist", 180)) is not None


def test_display_rename_uses_original_title_for_matching_and_neutral_queries() -> None:
    desired = {**spotify(), "title": "My favourite song", "original_title": "Round Ere"}
    assert recording_match(desired, recording()) is not None
    assert matching_queries(desired) == ('"K Motionz" "Round Ere"', "K Motionz Round Ere", "K Motionz Round Ere audio")


def test_audio_query_drops_featured_credit_but_preserves_postfix_version() -> None:
    desired = spotify("Balling (feat. Songer) - Edit", "Vibe Chemistry, Songer", 180)
    assert matching_queries(desired)[2] == "Vibe Chemistry Balling  - Edit audio"


@pytest.mark.parametrize(
    "example", json.loads((Path(__file__).parent / "fixtures/corrected_music_matches.json").read_text())
)
def test_manually_selected_recordings_keep_title_tolerance_and_duration_guards(example: dict) -> None:
    assert bool(recording_match(example["spotify"], example["youtube"])) is example["expected_match"]


def test_album_labels_must_match_spotify_metadata() -> None:
    desired = {**spotify("Together", "Mefjus", 285), "album": "Manifest"}
    assert recording_match(desired, recording("Mefjus - Together (Manifest)", "Mefjus", 285)) is not None
    assert recording_match(desired, recording("Mefjus - Together (Another Song)", "Mefjus", 285)) is None


def test_publisher_suffix_does_not_hide_a_different_recording_version() -> None:
    desired = spotify("See The Sun", "SOTA", 172)
    assert recording_match(desired, recording("Sota - See The Sun | Live | Bassrush Records", "Bassrush", 172)) is None
