// Live transcript of the other side for the menu navigator: an OpenAI
// realtime transcription session (gpt-live-transcribe) fed the same call
// audio as the voice model. Unlike the voice model's own transcript, which
// waits for a pause, it streams text while the line is still talking, so a
// menu that never pauses is still readable.

export interface Transcriber {
  /** pcm_s16le, mono, 24 kHz */
  send(pcm: Buffer): void;
  close(): void;
}

export function openAiLiveTranscriber(o: {
  apiKey: string;
  model: string;
  delay: string;
  prompt?: string;
  onText(delta: string): void;
  onError(err: Error): void;
}): Transcriber {
  const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
    headers: { Authorization: `Bearer ${o.apiKey}` },
  } as any);
  let open = false;
  let closed = false;
  const pending: string[] = [];
  const append = (pcm: Buffer) => JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: o.model, delay: o.delay, ...(o.prompt ? { prompt: o.prompt } : {}) },
            },
          },
        },
      }),
    );
    open = true;
    for (const m of pending.splice(0)) ws.send(m);
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "conversation.item.input_audio_transcription.delta" && msg.delta) o.onText(msg.delta);
    else if (msg.type === "error") o.onError(new Error(`transcription: ${msg.error?.message ?? "error"}`));
  };
  ws.onerror = () => {
    if (!closed) o.onError(new Error("transcription socket error"));
  };
  ws.onclose = () => {
    open = false;
  };
  return {
    send(pcm) {
      if (closed || !pcm.length) return;
      if (open) ws.send(append(pcm));
      // Before the socket opens, keep a few seconds at most.
      else if (pending.length < 150) pending.push(append(pcm));
    },
    close() {
      closed = true;
      try {
        ws.close();
      } catch {}
    },
  };
}
