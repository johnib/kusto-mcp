import { createRequire } from 'module';

// Read the version from package.json at runtime so the MCP handshake always
// reports the real published version. package.json sits one level above both
// src/ (dev via ts-node) and dist/ (built), so '../../package.json' resolves
// correctly from src/common/ and dist/common/ alike.
const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere('../../package.json') as { version: string };

export const VERSION: string = pkg.version;
