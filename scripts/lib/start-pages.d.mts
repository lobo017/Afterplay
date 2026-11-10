export const START_SLUG_PATTERN: RegExp;
/** The preset's app name ('' when it names none); throws when the text is not a version 1 preset. */
export function presetAppName(presetText: string): string;
/** The link's manifest (JSON text): the app's own, started at the link and named as the preset says. */
export function startManifest(baseManifestText: string, slug: string, appName: string): string;
/** The link's page: the app's page with the link's manifest and the preset's name, kept out of search results. */
export function startIndexHtml(indexHtml: string, slug: string, appName: string): string;
