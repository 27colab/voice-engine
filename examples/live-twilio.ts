/**
 * Live example: a real phone call over Twilio Media Streams.
 * Needs real accounts and keys, so it only runs when ALL of these are set:
 *
 *   DEEPGRAM_API_KEY  ELEVENLABS_API_KEY  ANTHROPIC_API_KEY
 *   ELEVENLABS_VOICE_EN   (any ElevenLabs voice id)
 *   ELEVENLABS_VOICE_ES   (optional; falls back to the EN voice)
 *   PORT                  (optional, default 8080)
 *
 *   npx tsx examples/live-twilio.ts
 *
 * Point a Twilio number at TwiML that streams to this server (use a tunnel for
 * local dev; the URL must be wss://):
 *
 *   <Response><Connect><Stream url="wss://YOUR-HOST/media" /></Connect></Response>
 *
 * This is a demo, not a deployable server: no auth, no signature validation,
 * no concurrency limits.
 */
import { WebSocketServer } from 'ws';
import { createCallSession, TwilioMediaTransport } from '../src/index.js';
import { createAnthropicChat, createDeepgramFluxFactory, createElevenLabsFactory } from '../src/providers/index.js';

const env = process.env;
const required = ['DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_VOICE_EN'] as const;
const missing = required.filter((k) => !env[k]);
if (missing.length > 0) {
  console.log(`Skipping live example, missing env: ${missing.join(', ')}`);
  process.exit(0);
}

const sttFactory = createDeepgramFluxFactory(env.DEEPGRAM_API_KEY!);
const ttsFactory = createElevenLabsFactory(env.ELEVENLABS_API_KEY!);
const chat = createAnthropicChat(env.ANTHROPIC_API_KEY!);

const wss = new WebSocketServer({ port: Number(env.PORT ?? 8080), path: '/media' });
console.log(`listening on :${env.PORT ?? 8080}/media`);

wss.on('connection', async (ws) => {
  const transport = new TwilioMediaTransport(ws);
  const start = await transport.started;
  const session = createCallSession(
    { transport, sttFactory, ttsFactory, chat },
    { callId: start.callSid, startedAt: new Date() },
    { onEnd: (record) => console.log(`[${record.callId}]`, JSON.stringify(record.stats)) },
    {
      languages: ['en', 'es'],
      languagePolicy: 'follow-caller',
      greeting: { en: 'Hi, thanks for calling. How can I help?', es: 'Hola, gracias por llamar. ¿En qué puedo ayudarle?' },
      system: (lang) => `You are a concise, friendly phone assistant. Reply in ${lang === 'es' ? 'Spanish' : 'English'}. Keep answers under two sentences.`,
      llm: { model: env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5', maxTokens: 300 },
      voice: {
        provider: 'elevenlabs',
        voices: { en: env.ELEVENLABS_VOICE_EN, es: env.ELEVENLABS_VOICE_ES },
        defaultVoiceId: env.ELEVENLABS_VOICE_EN!,
        model: 'eleven_flash_v2_5',
        outputFormat: 'ulaw_8000',
      },
      stt: { model: 'flux-general-multi', eagerEotThreshold: 0.6 },
    },
  );
  await session.start();
});
