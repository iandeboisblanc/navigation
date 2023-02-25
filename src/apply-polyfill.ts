import {DEFAULT_POLYFILL_OPTIONS, getCompletePolyfill, getPolyfill, NavigationPolyfillOptions} from "./get-polyfill";
import {getNavigation} from "./get-navigation";
import {globalNavigation} from "./global-navigation";

export async function applyPolyfill(options: NavigationPolyfillOptions = DEFAULT_POLYFILL_OPTIONS) {
  const { apply } = getCompletePolyfill(options);
  await apply();
}

export function shouldApplyPolyfill(navigation = getNavigation()) {
  return (
      navigation !== globalNavigation &&
      !globalNavigation &&
      typeof window !== "undefined"
  );
}