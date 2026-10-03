import { mountProvider } from '../server/pages/registry.mjs';
import { meteorShowersProxy } from '../server/providers/wave6/meteorShowers.js';
export default mountProvider(meteorShowersProxy());
