// Vercel: POST /api/openai/hud-summary — mounted via the shared connect adapter.
// (openAiRealtimeProxy also serves /api/realtime/token; /api/realtime/debug-log
// is a no-op stub on Vercel and /api/setup/keys is a 501 stub. Each Vercel
// function file mounts the same factory and the adapter dispatches only the
// matching route.)
import { mountProvider } from '../_lib/connect.js';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';

export default mountProvider(() => openAiRealtimeProxy());
