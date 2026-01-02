/** @module wxt/utils/content-script-ui/shadow-root */
import { browser } from 'wxt/browser';
import { ContentScriptContext } from '../content-script-context';
import type { ContentScriptUi, ContentScriptUiOptions } from './types';
import { createIsolatedElement } from '@webext-core/isolated-element';
import { applyPosition, createMountFunctions, mountUi } from './shared';
import { logger } from '../internal/logger';
import { splitShadowRootCss } from '../split-shadow-root-css';

/**
 * Create a content script UI inside a [`ShadowRoot`](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot).
 *
 * > This function is async because it has to load the CSS via a network call.
 *
 * @see https://wxt.dev/guide/essentials/content-scripts.html#shadow-root
 */
export async function createShadowRootUi<TMounted>(
  ctx: ContentScriptContext,
  options: ShadowRootContentScriptUiOptions<TMounted>,
): Promise<ShadowRootContentScriptUi<TMounted>> {
  const instanceId = Math.random().toString(36).substring(2, 15);
  const entrypointName = getEntrypointName();
  const css: string[] = [];
  let entryCssUrl: string | undefined;

  if (!options.inheritStyles) {
    css.push(`/* WXT Shadow Root Reset */ :host{all:initial !important;}`);
  }
  if (options.css) {
    css.push(options.css);
  }
  if (ctx.options?.cssInjectionMode === 'ui') {
    entryCssUrl = getContentScriptCssUrl(entrypointName);
    const entryCss = await loadCss(entryCssUrl);
    // Replace :root selectors with :host since we're in a shadow root
    css.push(entryCss.replaceAll(':root', ':host'));
  }

  // Some rules must be applied outside the shadow root, so split the CSS apart
  const cssTextRaw = css.join('\n').trim();
  const cssText =
    entryCssUrl != null ? rewriteCssUrls(cssTextRaw, entryCssUrl) : cssTextRaw;
  const { shadowCss, documentCss } = splitShadowRootCss(cssText);

  const {
    isolatedElement: uiContainer,
    parentElement: shadowHost,
    shadow,
  } = await createIsolatedElement({
    name: options.name,
    css: {
      textContent: shadowCss,
    },
    mode: options.mode ?? 'open',
    isolateEvents: options.isolateEvents,
  });

  let mounted: TMounted | undefined;

  const mount = () => {
    // Add shadow root element to DOM
    mountUi(shadowHost, options);
    applyPosition(shadowHost, shadow.querySelector('html'), options);

    // Add document CSS
    if (
      documentCss &&
      !document.querySelector(
        `style[wxt-shadow-root-document-styles="${instanceId}"]`,
      )
    ) {
      const style = document.createElement('style');
      style.textContent = documentCss;
      style.setAttribute('wxt-shadow-root-document-styles', instanceId);
      (document.head ?? document.body).append(style);
    }

    // Mount UI inside shadow root
    mounted = options.onMount(uiContainer, shadow, shadowHost);
  };

  const remove = () => {
    // Cleanup mounted state
    options.onRemove?.(mounted);

    // Detach shadow root from DOM
    shadowHost.remove();

    // Remove document CSS
    const documentStyle = document.querySelector(
      `style[wxt-shadow-root-document-styles="${instanceId}"]`,
    );
    documentStyle?.remove();

    // Remove children from uiContainer
    while (uiContainer.lastChild)
      uiContainer.removeChild(uiContainer.lastChild);

    // Clear mounted value
    mounted = undefined;
  };

  const mountFunctions = createMountFunctions(
    {
      mount,
      remove,
    },
    options,
  );

  ctx.onInvalidated(remove);

  return {
    shadow,
    shadowHost,
    uiContainer,
    ...mountFunctions,
    get mounted() {
      return mounted;
    },
  };
}

/**
 * Load the CSS for the current entrypoint.
 */
async function loadCss(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    return await res.text();
  } catch (err) {
    logger.warn(
      `Failed to load styles @ ${url}. Did you forget to import the stylesheet in your entrypoint?`,
      err,
    );
    return '';
  }
}

function getEntrypointName(): string {
  const entrypoint =
    // @ts-expect-error: `import.meta.env` is typed by the consumer project
    import.meta.env?.ENTRYPOINT ?? (globalThis as any).__ENTRYPOINT__;
  return entrypoint ?? 'unknown';
}

function getContentScriptCssUrl(entrypointName: string): string {
  return (
    browser.runtime
      // @ts-expect-error: getURL is defined per-project, but not inside the package
      .getURL(`/content-scripts/${entrypointName}.css`)
  );
}

const CSS_URL_REGEX = /url\(([^)]+)\)/g;
const EXTENSION_PROTOCOLS = new Set([
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
  'wxt-extension:',
]);

function rewriteCssUrls(css: string, baseUrl: string): string {
  if (!css) return css;
  return css.replace(CSS_URL_REGEX, (match, rawUrl) => {
    const resolved = resolveExtensionAssetUrl(rawUrl, baseUrl);
    return resolved ? `url("${resolved}")` : match;
  });
}

function resolveExtensionAssetUrl(
  rawUrl: string,
  baseUrl: string,
): string | undefined {
  const trimmed = rawUrl.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return;
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('http:') ||
    trimmed.startsWith('https:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('#')
  )
    return;

  try {
    const base = new URL(baseUrl);
    const resolved = new URL(trimmed, base);
    const isExtensionResource =
      resolved.origin === base.origin ||
      EXTENSION_PROTOCOLS.has(resolved.protocol);
    if (!isExtensionResource) return;

    // Include the host when the resolved URL points to a different origin (like a custom
    // `wxt-extension://assets/...` URL) so the asset path isn't lost.
    const shouldIncludeHost =
      resolved.origin !== base.origin && resolved.host !== '';
    const pathWithoutSearch = shouldIncludeHost
      ? `${resolved.host}${resolved.pathname}`
      : resolved.pathname;
    const path = `${pathWithoutSearch}${resolved.search}${resolved.hash}`;

    return browser.runtime.getURL(path.startsWith('/') ? path : `/${path}`);
  } catch {
    return;
  }
}

export interface ShadowRootContentScriptUi<
  TMounted,
> extends ContentScriptUi<TMounted> {
  /**
   * The `HTMLElement` hosting the shadow root used to isolate the UI's styles. This is the element
   * that get's added to the DOM. This element's style is not isolated from the webpage.
   */
  shadowHost: HTMLElement;
  /**
   * The container element inside the `ShadowRoot` whose styles are isolated. The UI is mounted
   * inside this `HTMLElement`.
   */
  uiContainer: HTMLElement;
  /**
   * The shadow root performing the isolation.
   */
  shadow: ShadowRoot;
}

export type ShadowRootContentScriptUiOptions<TMounted> =
  ContentScriptUiOptions<TMounted> & {
    /**
     * The name of the custom component used to host the ShadowRoot. Must be kebab-case.
     */
    name: string;
    /**
     * Custom CSS text to apply to the UI. If your content script imports/generates CSS and you've
     * set `cssInjectionMode: "ui"`, the imported CSS will be included automatically. You do not need
     * to pass those styles in here. This is for any additional styles not in the imported CSS.
     */
    css?: string;
    /**
     * ShadowRoot's mode.
     *
     * @see https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot/mode
     * @default "open"
     */
    mode?: 'open' | 'closed';
    /**
     * When enabled, `event.stopPropagation` will be called on events trying to bubble out of the
     * shadow root.
     *
     * - Set to `true` to stop the propagation of a default set of events,
     *   `["keyup", "keydown", "keypress"]`
     * - Set to an array of event names to stop the propagation of a custom list of events
     */
    isolateEvents?: boolean | string[];
    /**
     * By default, WXT adds `all: initial` to the shadow root before the rest of
     * your CSS. This resets any inheritable CSS styles that
     * [normally pierce the Shadow DOM](https://open-wc.org/guides/knowledge/styling/styles-piercing-shadow-dom/).
     *
     * WXT resets everything but:
     * - **`rem` Units**: they continue to scale based off the webpage's HTML `font-size`.
     * - **CSS Variables/Custom Properties**: CSS variables defined outside the shadow root can be accessed inside it.
     * - **`@font-face` Definitions**: Fonts defined outside the shadow root can be used inside it.
     *
     * To disable this behavior and inherit styles from the webpage, set `inheritStyles: true`.
     *
     * @default false
     */
    inheritStyles?: boolean;
    /**
     * Callback executed when mounting the UI. This function should create and append the UI to the
     * `uiContainer` element. It is called every time `ui.mount()` is called.
     *
     * Optionally return a value that can be accessed at `ui.mounted` or in the `onRemove` callback.
     */
    onMount: (
      uiContainer: HTMLElement,
      shadow: ShadowRoot,
      shadowHost: HTMLElement,
    ) => TMounted;
  };
