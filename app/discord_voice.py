from discord.ext.voice_recv import VoiceRecvClient as DiscordVoiceRecvClient


class VoiceRecvClient(DiscordVoiceRecvClient):
    def _remove_ssrc(self, *, user_id: int) -> None:
        ssrc = self._id_to_ssrc.pop(user_id, None)
        if ssrc is None:
            return
        reader = self._reader
        if reader:
            reader.speaking_timer.drop_ssrc(ssrc)
        self._ssrc_to_id.pop(ssrc, None)
