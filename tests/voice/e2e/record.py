"""Record a phone's calls from ws/voice/monitor: stereo WAV (L = other party,
R = what otacon played) + a timestamped event log. Stops on SIGTERM/SIGINT."""
import asyncio, json, signal, ssl, sys, time, wave
import websockets

host, phone, out = sys.argv[1], sys.argv[2], sys.argv[3]

async def main():
    stop = asyncio.Event()
    for s in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(s, stop.set)
    ws = await websockets.connect(f"wss://{host}/phones/{phone}/ws/voice/monitor", ssl=ssl.create_default_context(), max_size=None)
    hello = json.loads(await ws.recv())
    w = wave.open(out + ".wav", "wb"); w.setnchannels(2); w.setsampwidth(2); w.setframerate(hello["audio"]["sampleRate"])
    log = open(out + ".events.jsonl", "w")
    t0 = time.time()
    async def pump():
        async for m in ws:
            if isinstance(m, bytes):
                w.writeframes(m)
            else:
                msg = json.loads(m)
                log.write(json.dumps(msg) + "\n"); log.flush()
                c = msg.get("call", {})
                print(f"+{time.time()-t0:6.1f}s {msg['type']} {c.get('id','')} {c.get('state','')} {c.get('number') or ''} {msg.get('reason','')}", flush=True)
    task = asyncio.create_task(pump())
    await stop.wait()
    task.cancel()
    w.close(); log.close()
    await ws.close()

asyncio.run(main())
