from collections.abc import Callable

import discord
from discord.ext.voice_recv import VoiceRecvClient as DiscordVoiceRecvClient

from app.music_transport import MusicAudioPlayer


class VoiceRecvClient(DiscordVoiceRecvClient):
    def play_music(
        self,
        source: discord.AudioSource,
        *,
        bitrate: int = 384,
        after: Callable[[Exception | None], None] | None = None,
    ) -> None:
        if not self.is_connected():
            message = "Not connected to voice."
            raise discord.ClientException(message)
        if self.is_playing():
            message = "Already playing audio."
            raise discord.ClientException(message)
        if not isinstance(source, discord.AudioSource):
            message = "Music requires a Discord audio source."
            raise TypeError(message)
        if not source.is_opus():
            self.encoder = discord.opus.Encoder(bitrate=bitrate, signal_type="music")
        self._player = MusicAudioPlayer(source, self, after=after)
        self._player.start()

    def _remove_ssrc(self, *, user_id: int) -> None:
        ssrc = self._id_to_ssrc.pop(user_id, None)
        if ssrc is None:
            return
        reader = self._reader
        if reader:
            reader.speaking_timer.drop_ssrc(ssrc)
        self._ssrc_to_id.pop(ssrc, None)
