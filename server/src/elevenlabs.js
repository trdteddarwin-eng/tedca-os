// Cloud-native ElevenLabs TTS — ports the locked settings from execution/gen_avatar_vo.py
// (eleven_v3, stability 0.5, similarity 0.75, style 0.0, speaker boost, ~1.2x speed)
// so Avatar Video works with the user's Mac off.

export function elevenConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

export async function generateVoice({ text, voice, speed = 1.2 }) {
  const key = process.env.ELEVENLABS_API_KEY || "";
  if (!key) throw new Error("ELEVENLABS_API_KEY missing");
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_v3",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
          speed,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}
