// Global test setup. Applies to every test file (see vitest.config.ts).

// Nine test files build throwaway git repos under os.tmpdir() and delete them
// in afterEach. Git runs `gc --auto` in a *detached background process* at the
// end of commands like rebase and fetch, so that cleanup can race a maintenance
// run still writing into .git/objects — surfacing as
// `ENOTEMPTY: rmdir '<repo>/.git/objects/pack'` and failing an unrelated test.
// These env vars are inherited by every git subprocess a test spawns, so no
// fixture has to remember to set them.
const gitConfig: Array<[string, string]> = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
];

process.env.GIT_CONFIG_COUNT = String(gitConfig.length);
gitConfig.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
});

// happy-dom 21 implements the Web Animations API (`Element.animate`), which
// 20 did not. Framer Motion uses it whenever it exists, and cancelling an
// animation on unmount rejects its `finished` promise with an AbortError that
// nothing awaits — so vitest reports "Unhandled Errors" and fails a run in
// which every test passed. No test here asserts on animation; removing
// `animate` puts Motion back on the JavaScript path it took under happy-dom 20.
if (typeof Element !== "undefined" && "animate" in Element.prototype) {
  Reflect.deleteProperty(Element.prototype, "animate");
}
