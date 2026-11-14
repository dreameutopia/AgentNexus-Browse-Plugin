/** Shared browser/CLI verification and editor schemas. Never fork package validation rules. */
export { verifyPackage } from '../utils/plugins/package';
export { base32, sha256, toBase64 } from '../utils/plugins/codec';
export {
  manifestSchema,
  toolSchema,
  agentSchema,
} from '../utils/plugins/contracts';
export { canonicalize } from 'json-canonicalize';
export { zipSync, strToU8 } from 'fflate';
export { zodToJsonSchema } from 'zod-to-json-schema';
export { strictJson } from '../utils/plugins/json';
export { catalogSchema } from '../utils/plugins/github';
