// Vercel: POST /api/realtime/token — mounted via the shared connect adapter.
import { mountProvider } from '../_lib/connect.js';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';

export default mountProvider(() => openAiRealtimeProxy());
