/**
 * Kujira Chan plugin, node half. The empty apply exists so the plugin appears
 * in the host cordis.yml / Loader and therefore in the Plugins page's built-in
 * inventory; the browser half owns the card and its page through
 * `exports["./client"]`, discovered from the package.json `dsh.client`
 * declaration. This package registers no Host service and no settings
 * namespace of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
