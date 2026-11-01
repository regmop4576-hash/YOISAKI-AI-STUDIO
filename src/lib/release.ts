import release from '../../package.json';
export const STUDIO_VERSION=release.version;
export const STUDIO_EDITION='PIXEL FANTASY EDITION';
export const STUDIO_LABEL=`PIXEL FANTASY · v${STUDIO_VERSION} ${STUDIO_EDITION}`;
declare const __YOISAKI_BUILD__:string|undefined;
/** First 12 hex characters of dist/release.json source_sha256, injected by scripts/build.mjs. The version stays 1.9.2;
 *  this identifies WHICH 1.9.2 build the browser is running (shown in Settings, compared with the local server). */
export const STUDIO_BUILD:string=typeof __YOISAKI_BUILD__==='string'?__YOISAKI_BUILD__:'dev';
