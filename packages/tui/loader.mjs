// Resolve '@zcode/tui' to zagent's own TUI, for a runtime that does not ship one.
//
// Used as `node --import <this> <official zcode.cjs> tui`. The official kernel is
// read in place: nothing is copied, patched, or written into its install root
// (which is root-owned anyway). This is the supported ESM resolution hook, not a
// monkey-patch.
import { registerHooks } from 'node:module';

const TUI = new URL('./index.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@zcode/tui') return { url: TUI, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
