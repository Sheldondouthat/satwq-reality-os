// Vercel: GET /api/local-receivers/aircraft — mounted via the shared connect
// adapter, byte-for-byte the same handler as the Docker/prod-server path.
//
// DORMANT ON VERCEL BY DESIGN: this proxy forwards to receivers on the
// operator's LAN (127.0.0.0/8, 10/8, 172.16/12, 192.168/16). A Vercel function
// has no route to the viewer's LAN, so every request degrades through the
// provider's normal unreachable-receiver path. Kept (not dropped) so the
// route inventory stays identical across deploy targets.
import { mountProvider } from '../_lib/connect.js';
import { localReceiversProxy } from '../../server/providers/local-receivers.js';

export default mountProvider(() => localReceiversProxy());
