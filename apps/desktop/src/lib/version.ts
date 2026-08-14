// Desktop app version — single source of truth is apps/desktop/package.json.
// Never hard-code a version literal in UI; import APP_VERSION instead.
import pkg from '../../package.json';

export const APP_VERSION: string = pkg.version;
