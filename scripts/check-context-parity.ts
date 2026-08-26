/**
 * Phase 6 parity gate for the context library:
 *
 *   GET    /api/context
 *   GET    /api/context/graph
 *   POST   /api/context/notes
 *   GET    /api/context/notes/:id
 *   PUT    /api/context/notes/:id
 *   DELETE /api/context/notes/:id
 *   PUT    /api/context/pins
 *   POST   /api/context/preview
 *
 * **Nothing here is stable between two runtimes.** A note's id is a fresh uuid,
 * its revision is a sha256 over a file containing that uuid and two timestamps,
 * and its path is named after both. So a case that wants to edit a note cannot
 * carry its id or revision in the case table — each runtime's own values are
 * read back from its own listing, the same way the snapshot gate follows shas.
 *
 * **A revision is a precondition, not a field.** An update or a delete carrying
 * the wrong one is a 409 whose body includes the note as it actually is, which
 * is the only place in this surface where a refusal carries state. Cases send a
 * stale revision deliberately.
 *
 * **`kinds` is a filter that silently drops what it does not recognise.** It is
 * split on commas and every unknown kind is filtered out, so `kinds=note,widget`
 * is `kinds=note` and `kinds=widget` is an *empty* filter rather than an absent
 * one — which matches nothing at all rather than everything.
 *
 * Usage:
 *   node --import tsx scripts/check-context-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-context-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * `{{ID:title}}` becomes the id of the note with that title, and
   * `{{REV:title}}` its current revision — both resolved against the runtime
   * being driven, since neither is the same on both sides.
   */
  readonly path: string;
  readonly body?: string;
  /**
   * Runs against this runtime before the request.
   *
   * The vault is a directory of Markdown files that the daemon re-reads on
   * every request, so a step can put something there that no endpoint would
   * ever create — a note carrying an id another note already claims, which is
   * what a copied file looks like.
   */
  readonly mutate?: (runtime: Runtime) => Promise<void>;
}

const NOTES = "/api/context/notes";
const CONTEXT = "/api/context";
/** Over the 120-character title bound. */
const LONG_TITLE = "t".repeat(121);
/** A revision that is well-formed and belongs to nothing. */
const STALE_REVISION = "0".repeat(64);

const steps: readonly Step[] = [
  // --- an empty library ------------------------------------------------------
  // `items` is not empty even with no notes: services and repositories in the
  // config are derived items, and they are what the vault is indexed against.
  { name: "list/empty", method: "GET", path: CONTEXT },
  { name: "list/the-graph-when-empty", method: "GET", path: "/api/context/graph" },
  { name: "list/wrong-method", method: "POST", path: CONTEXT },

  // --- creating --------------------------------------------------------------
  { name: "create/a-note", method: "POST", path: NOTES, body: '{"title":"Alpha note","body":"the body"}' },
  // The title is trimmed before it is bounded, and it names the file.
  { name: "create/a-padded-title", method: "POST", path: NOTES, body: '{"title":"   Beta note   ","body":"b"}' },
  { name: "create/no-body", method: "POST", path: NOTES, body: '{"title":"Gamma note"}' },
  { name: "create/a-blank-title", method: "POST", path: NOTES, body: '{"title":"   "}' },
  { name: "create/no-title", method: "POST", path: NOTES, body: '{"body":"orphan"}' },
  { name: "create/a-title-that-is-too-long", method: "POST", path: NOTES, body: `{"title":"${LONG_TITLE}"}` },
  { name: "create/a-title-that-is-a-number", method: "POST", path: NOTES, body: '{"title":7}' },
  { name: "create/an-unknown-key", method: "POST", path: NOTES, body: '{"title":"Nope","colour":"red"}' },
  { name: "create/an-empty-body", method: "POST", path: NOTES, body: "{}" },
  // A note whose body links to another by title, which is what the graph reads.
  { name: "create/a-note-that-links", method: "POST", path: NOTES, body: '{"title":"Delta note","body":"see [[Alpha note]] and [[Nothing at all]]"}' },
  { name: "create/with-tags-and-aliases", method: "POST", path: NOTES, body: '{"title":"Epsilon note","body":"e","tags":["  one  ","two"],"aliases":["eps"]}' },
  { name: "create/a-blank-tag", method: "POST", path: NOTES, body: '{"title":"Zeta note","tags":["   "]}' },
  { name: "create/a-tag-that-is-a-number", method: "POST", path: NOTES, body: '{"title":"Eta note","tags":[7]}' },
  { name: "create/too-many-tags", method: "POST", path: NOTES, body: `{"title":"Theta note","tags":[${Array.from({ length: 101 }, (_, i) => `"t${i}"`).join(",")}]}` },
  { name: "create/a-source-key", method: "POST", path: NOTES, body: '{"title":"Iota note","body":"i","sourceKey":"linear:ABC-1"}' },
  { name: "create/a-blank-source-key", method: "POST", path: NOTES, body: '{"title":"Kappa note","sourceKey":"   "}' },
  { name: "create/project-paths", method: "POST", path: NOTES, body: '{"title":"Lambda note","body":"l","projectPaths":["/tmp/one","/tmp/two"]}' },
  // Two titles that sort one way by locale and the other way by byte value.
  // `list()` orders items with `localeCompare`, which compares base letters
  // first and only then case — so these two are decided by ` lowercase` versus
  // ` uppercase` and the lowercase one leads. Ordering them by `str::cmp`
  // instead puts `B` (66) ahead of `b` (98) and reverses them. Every other
  // title in this fixture is capitalised, which is exactly why the difference
  // would otherwise never show.
  { name: "create/a-lowercase-title", method: "POST", path: NOTES, body: '{"title":"beta lowercase","body":"l"}' },
  { name: "create/an-uppercase-title", method: "POST", path: NOTES, body: '{"title":"Beta uppercase","body":"u"}' },
  // Two titles that differ *only* by case, so the comparison reaches its
  // tertiary level and the lowercase-first tie-break is what decides. The pair
  // above cannot show it: they differ at `l` vs `u` long before case matters.
  { name: "create/a-case-tie", method: "POST", path: NOTES, body: '{"title":"Sigma","body":"upper"}' },
  { name: "create/the-other-case-tie", method: "POST", path: NOTES, body: '{"title":"sigma","body":"lower"}' },
  // A tag that is not lowercase. A query is lowercased before it is used, so a
  // haystack that is *not* lowercased in turn stops matching — and only a tag
  // can show that, because a note's `path` is its title already slugged to
  // lowercase and matches either way.
  { name: "create/an-uppercase-tag", method: "POST", path: NOTES, body: '{"title":"Omega note","body":"o","tags":["Urgent"]}' },
  // Two items that answer to the same name, so a wiki link to it is ambiguous
  // and resolves to neither.
  //
  // The name they share is an **alias**, not their title, and that is not a
  // stylistic choice: the listing is ordered by title, so two notes with the
  // same title tie all the way down and fall back to the order the vault
  // directory happened to be scanned in — which differs between two runtimes,
  // and between two runs of the same one. An alias collides for the link
  // lookup without colliding for the sort.
  { name: "create/an-ambiguous-name", method: "POST", path: NOTES, body: '{"title":"Twin one","body":"first","aliases":["Twin"]}' },
  { name: "create/the-other-ambiguous-name", method: "POST", path: NOTES, body: '{"title":"Twin two","body":"second","aliases":["Twin"]}' },
  // Links that resolve to something still present, unlike Delta's, whose target
  // is renamed out from under it later on.
  { name: "create/links-that-resolve", method: "POST", path: NOTES, body: '{"title":"Linker","body":"see [[Omega note]], [[Twin]] and [[SIGMA]]","projectPaths":["/tmp/one"]}' },
  { name: "create/the-listing-afterwards", method: "GET", path: CONTEXT },

  // --- reading ---------------------------------------------------------------
  { name: "read/a-note", method: "GET", path: `${NOTES}/{{ID:Alpha note}}` },
  { name: "read/an-unknown-note", method: "GET", path: `${NOTES}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` },
  // The id rule is `[a-zA-Z0-9-]{8,100}`, checked *before* the lookup.
  { name: "read/an-id-that-is-too-short", method: "GET", path: `${NOTES}/abc` },
  { name: "read/an-id-with-an-underscore", method: "GET", path: `${NOTES}/abc_defgh` },
  { name: "read/an-id-with-a-slash", method: "GET", path: `${NOTES}/abcd%2Fefgh` },
  { name: "read/an-id-that-is-badly-encoded", method: "GET", path: `${NOTES}/abcd%zzefgh` },
  { name: "read/wrong-method", method: "PATCH", path: `${NOTES}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` },

  // --- updating --------------------------------------------------------------
  // Every array is required on an update, unlike on a create.
  { name: "update/without-the-arrays", method: "PUT", path: `${NOTES}/{{ID:Alpha note}}`, body: '{"title":"Alpha note","body":"x","revision":"{{REV:Alpha note}}"}' },
  { name: "update/a-note", method: "PUT", path: `${NOTES}/{{ID:Alpha note}}`, body: '{"title":"Alpha renamed","body":"rewritten","projectPaths":[],"tags":["kept"],"aliases":[],"revision":"{{REV:Alpha note}}"}' },
  { name: "update/the-listing-afterwards", method: "GET", path: CONTEXT },
  // A stale revision is a 409, and the body carries the note as it now is.
  { name: "update/a-stale-revision", method: "PUT", path: `${NOTES}/{{ID:Alpha renamed}}`, body: `{"title":"Alpha again","body":"y","projectPaths":[],"tags":[],"aliases":[],"revision":"${STALE_REVISION}"}` },
  { name: "update/a-revision-that-is-not-a-sha", method: "PUT", path: `${NOTES}/{{ID:Alpha renamed}}`, body: '{"title":"Alpha again","body":"y","projectPaths":[],"tags":[],"aliases":[],"revision":"nope"}' },
  // Hexadecimal and the wrong length, which `nope` cannot show: a version that
  // dropped the length check would still refuse a revision carrying letters
  // that are not hex digits.
  { name: "update/a-revision-that-is-short-hex", method: "PUT", path: `${NOTES}/{{ID:Alpha renamed}}`, body: '{"title":"Alpha again","body":"y","projectPaths":[],"tags":[],"aliases":[],"revision":"abcdef"}' },
  // Omits one array and sends the rest, so a version that made *that* one
  // optional would go through. Omitting all three cannot show it — the next
  // required field refuses first either way.
  { name: "update/without-project-paths", method: "PUT", path: `${NOTES}/{{ID:Alpha renamed}}`, body: '{"title":"Alpha again","body":"y","tags":[],"aliases":[],"revision":"{{REV:Alpha renamed}}"}' },
  { name: "update/an-uppercase-revision", method: "PUT", path: `${NOTES}/{{ID:Alpha renamed}}`, body: `{"title":"Alpha again","body":"y","projectPaths":[],"tags":[],"aliases":[],"revision":"${"A".repeat(64)}"}` },
  // `sourceKey` is accepted on a create and refused on an update.
  { name: "update/a-source-key", method: "PUT", path: `${NOTES}/{{ID:Alpha renamed}}`, body: '{"title":"Alpha again","body":"y","projectPaths":[],"tags":[],"aliases":[],"sourceKey":"x","revision":"{{REV:Alpha renamed}}"}' },
  { name: "update/an-unknown-note", method: "PUT", path: `${NOTES}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, body: `{"title":"Ghost","body":"y","projectPaths":[],"tags":[],"aliases":[],"revision":"${STALE_REVISION}"}` },

  // --- pinning ---------------------------------------------------------------
  { name: "pins/set", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"note","id":"{{ID:Alpha renamed}}"}]}' },
  { name: "pins/the-listing-afterwards", method: "GET", path: CONTEXT },
  { name: "pins/an-unknown-kind", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"widget","id":"x"}]}' },
  { name: "pins/a-blank-id", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"note","id":"   "}]}' },
  { name: "pins/an-unknown-key", method: "PUT", path: "/api/context/pins", body: '{"refs":[],"colour":"red"}' },
  { name: "pins/a-ref-with-an-extra-key", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"note","id":"abcdefgh","extra":1}]}' },
  // A pin does not have to resolve to anything.
  { name: "pins/a-ref-that-resolves-to-nothing", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"note","id":"does-not-exist"}]}' },
  // The **kind** is half the key. This names a real note's id under the wrong
  // kind, so nothing is pinned — and a version that matched on the id alone
  // would light up that note in the listing.
  { name: "pins/a-real-id-under-the-wrong-kind", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"incident","id":"{{ID:Gamma note}}"}]}' },
  { name: "pins/the-listing-under-the-wrong-kind", method: "GET", path: CONTEXT },
  // Pin something the graph will have to sort first.
  { name: "pins/a-project", method: "PUT", path: "/api/context/pins", body: '{"refs":[{"kind":"note","id":"{{ID:Omega note}}"}]}' },
  { name: "pins/cleared", method: "PUT", path: "/api/context/pins", body: '{"refs":[]}' },

  // --- filtering -------------------------------------------------------------
  { name: "filter/a-query", method: "GET", path: `${CONTEXT}?q=beta` },
  { name: "filter/a-query-that-matches-nothing", method: "GET", path: `${CONTEXT}?q=zzzzz` },
  { name: "filter/a-blank-query", method: "GET", path: `${CONTEXT}?q=` },
  // An empty query matches everything by accident — `"".contains` is true of
  // any string — so only a query that is *whitespace* can show whether it was
  // trimmed before it was used.
  { name: "filter/a-whitespace-query", method: "GET", path: `${CONTEXT}?q=%20%20` },
  // Matches only through a tag, and only if the haystack is lowercased too.
  { name: "filter/a-query-that-matches-a-tag", method: "GET", path: `${CONTEXT}?q=urgent` },
  // Matches a title whose slugged path does *not* contain the query, so the
  // title is the only haystack that can answer.
  { name: "filter/a-query-with-a-space", method: "GET", path: `${CONTEXT}?q=omega%20note` },
  // Lambda note is filed under `/tmp/one` via its `projectPaths` **list**, not
  // via the single `projectPath` a derived item carries — the filter has to
  // match either, or a note filed under three repositories shows up under none.
  { name: "filter/a-project-path", method: "GET", path: `${CONTEXT}?projectPath=%2Ftmp%2Fone` },
  { name: "filter/the-other-project-path", method: "GET", path: `${CONTEXT}?projectPath=%2Ftmp%2Ftwo` },
  // The workspace is a registered repository, so this one selects the derived
  // project row and the services under it rather than any note.
  { name: "filter/a-project-that-is-registered", method: "GET", path: `${CONTEXT}?projectPath=%2Ftmp%2Fnothing` },
  { name: "filter/a-project-and-a-kind", method: "GET", path: `${CONTEXT}?projectPath=%2Ftmp%2Fone&kinds=note` },
  { name: "filter/one-kind", method: "GET", path: `${CONTEXT}?kinds=note` },
  // An unrecognised kind is dropped rather than refused, which leaves an empty
  // filter — and an empty filter matches nothing.
  { name: "filter/an-unknown-kind", method: "GET", path: `${CONTEXT}?kinds=widget` },
  { name: "filter/a-known-and-an-unknown-kind", method: "GET", path: `${CONTEXT}?kinds=note,widget` },
  { name: "filter/a-blank-kinds", method: "GET", path: `${CONTEXT}?kinds=` },
  { name: "filter/repeated-kinds", method: "GET", path: `${CONTEXT}?kinds=note&kinds=service` },
  { name: "filter/the-graph-filtered", method: "GET", path: `/api/context/graph?kinds=note` },
  // The whole graph, which is the only shape that has edges in it: `kinds=note`
  // filters out every project and service, and those are what notes and
  // services draw `belongs-to` edges *to*. Ordering matters here too — pinned
  // first, then by kind, then by title — and a pinned note is in the fixture by
  // the time this runs.
  { name: "filter/the-whole-graph", method: "GET", path: "/api/context/graph" },
  { name: "filter/the-graph-for-one-project", method: "GET", path: "/api/context/graph?projectPath=%2Ftmp%2Fone" },

  // --- previewing ------------------------------------------------------------
  { name: "preview/one-note", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[{"kind":"note","id":"{{ID:Alpha renamed}}"}],"includePinned":false}}' },
  { name: "preview/nothing", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[],"includePinned":false}}' },
  { name: "preview/a-missing-ref", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[{"kind":"note","id":"does-not-exist"}],"includePinned":false}}' },
  { name: "preview/without-include-pinned", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[]}}' },
  { name: "preview/a-duplicate-ref", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[{"kind":"note","id":"{{ID:Alpha renamed}}"},{"kind":"note","id":"{{ID:Alpha renamed}}"}],"includePinned":false}}' },
  // `projectPath` marks a resolved item as belonging to *another* project, so it
  // only says anything when the attachment actually resolves to something with a
  // project of its own. An empty attachment cannot show it, which is why this
  // names the note filed under `/tmp/one` and then asks again under a project it
  // does not belong to.
  { name: "preview/scoped-to-its-own-project", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[{"kind":"note","id":"{{ID:Lambda note}}"}],"includePinned":false},"projectPath":"/tmp/one"}' },
  { name: "preview/scoped-to-another-project", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[{"kind":"note","id":"{{ID:Lambda note}}"}],"includePinned":false},"projectPath":"/tmp/nowhere"}' },
  { name: "preview/scoped-to-a-registered-project", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[{"kind":"service","id":"workspace:stray"}],"includePinned":false},"projectPath":"/tmp/one"}' },
  { name: "preview/with-a-project-path", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[],"includePinned":true},"projectPath":"/tmp/one"}' },
  { name: "preview/an-unknown-key", method: "POST", path: "/api/context/preview", body: '{"attachment":{"refs":[],"includePinned":false},"colour":"red"}' },
  { name: "preview/no-attachment", method: "POST", path: "/api/context/preview", body: "{}" },

  // --- deleting --------------------------------------------------------------
  { name: "delete/a-stale-revision", method: "DELETE", path: `${NOTES}/{{ID:Alpha renamed}}`, body: `{"revision":"${STALE_REVISION}"}` },
  { name: "delete/no-revision", method: "DELETE", path: `${NOTES}/{{ID:Alpha renamed}}`, body: "{}" },
  { name: "delete/an-unknown-key", method: "DELETE", path: `${NOTES}/{{ID:Alpha renamed}}`, body: `{"revision":"{{REV:Alpha renamed}}","colour":"red"}` },
  { name: "delete/a-note", method: "DELETE", path: `${NOTES}/{{ID:Alpha renamed}}`, body: '{"revision":"{{REV:Alpha renamed}}"}' },
  { name: "delete/the-same-note-again", method: "DELETE", path: `${NOTES}/{{ID:Alpha renamed}}`, body: `{"revision":"${STALE_REVISION}"}` },
  { name: "delete/the-listing-afterwards", method: "GET", path: CONTEXT },

  // --- a note copied on disk -------------------------------------------------
  // Two files claiming the same id is what copying a Markdown note looks like,
  // and no endpoint can produce it — the id is generated per create. Both
  // copies are hidden rather than one being chosen, because an invisible note
  // with a diagnostic beside it is recoverable where a silently picked one is a
  // lost edit.
  {
    name: "duplicate/the-listing",
    method: "GET",
    path: CONTEXT,
    mutate: async (runtime) => {
      const notes = join(runtime.home, ".nomoreide", "context-vault", "Notes");
      const original = (await readdir(notes)).find((name) => name.startsWith("gamma-note--"));
      if (!original) return;
      const body = await readFile(join(notes, original), "utf8");
      await writeFile(join(notes, `copy-of-${original}`), body);
    },
  },
  { name: "duplicate/reading-one-of-them", method: "GET", path: `${NOTES}/{{ID:Gamma note}}` },
  { name: "duplicate/the-graph", method: "GET", path: "/api/context/graph" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function credentialFor(runtime: Runtime): Promise<Record<string, string>> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

/**
 * The note with a given title, as this runtime currently holds it. Both the id
 * and the revision come from the same read, so a case that sends one with the
 * other is sending a consistent pair.
 */
async function noteByTitle(
  runtime: Runtime,
  title: string,
): Promise<{ id: string; revision: string }> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${CONTEXT}`, {
    headers: await credentialFor(runtime),
  });
  const payload = (await response.json()) as {
    items?: Array<{ title: string; ref: { id: string }; revision?: string }>;
  };
  const found = payload.items?.find((item) => item.title === title);
  return { id: found?.ref.id ?? "missing-note-id", revision: found?.revision ?? "0".repeat(64) };
}

/** Replace every `{{ID:…}}` / `{{REV:…}}` with this runtime's own values. */
async function resolve(runtime: Runtime, text: string): Promise<string> {
  const titles = new Set(
    [...text.matchAll(/\{\{(?:ID|REV):([^}]+)\}\}/g)].map((match) => match[1]),
  );
  let resolved = text;
  for (const title of titles) {
    const note = await noteByTitle(runtime, title);
    resolved = resolved.split(`{{ID:${title}}}`).join(note.id);
    resolved = resolved.split(`{{REV:${title}}}`).join(note.revision);
  }
  return resolved;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.mutate) await step.mutate(runtime);
  const path = await resolve(runtime, step.path);
  const body = step.body === undefined ? undefined : await resolve(runtime, step.body);
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: step.method,
    headers: { ...(await credentialFor(runtime)), "content-type": "application/json" },
    body: step.method === "GET" ? undefined : body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

/**
 * Keys whose value is generated rather than decided.
 *
 * A *note's* id is a uuid, its revision hashes a file containing that uuid and
 * two timestamps, and its filename is built from both — all three differ
 * between two runtimes that did exactly the same thing.
 *
 * A **derived** item's id is nothing of the sort. A project's is its path, a
 * service's is `<project>:<name>`, a file's is a hash of the repository path
 * and the relative path. Those are worth comparing, and blanket-scrubbing `id`
 * would hide a service ref built as `workspace:api` where it should be
 * `/path/to/repo:api`. So a uuid is redacted for being a uuid, not for sitting
 * under a key called `id`.
 */
const VOLATILE = new Set(["revision"]);
/**
 * A timestamp is masked rather than redacted: every digit becomes `#` and the
 * punctuation stays. Two runs a millisecond apart compare equal, and a runtime
 * that writes `2026-08-26T11:14:12.433824+00:00` where the other writes
 * `2026-08-26T11:14:12.428Z` still fails — which is the divergence this found
 * on its first run. Redacting the whole value by key would have hidden it.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A note's file, which is named `<slug>--<first 8 of the uuid>.md`. */
const NOTE_FILE = /--[0-9a-f]{8}\.md/gi;

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    if (TIMESTAMP.test(value)) return value.replace(/\d/g, "#");
    // Globally, not just when the whole string is one: a preview's rendered
    // context embeds a note's id inside its `<context-item>` tag, and a value
    // that merely *contains* a uuid is just as unstable as one that is a uuid.
    return value
      .replace(UUID, "<uuid>")
      .replace(NOTE_FILE, "--<uuid8>.md");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        VOLATILE.has(key) ? [key, "<volatile>"] : [key, scrub(item)],
      ),
    );
  }
  return value;
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  const erased = JSON.stringify(answer.body)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
  return { ...answer, body: scrub(JSON.parse(erased)) };
}

const root = await mkdtemp(join(tmpdir(), "nmi-context-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        // A registered service is a *derived* context item, so the library has
        // something in it before a single note is written — and `kinds=service`
        // has something to select.
        services: [
          { name: "api", command: "true", cwd: partial.workspace, port: 4599 },
          // Outside every registered repository, so its derived ref id falls
          // back to `workspace:` — a default nothing else in the fixture can
          // reach, since a service under a repo takes that repo's path.
          { name: "stray", command: "true", cwd: "/tmp/elsewhere", port: 4598 },
        ],
        bundles: [],
        databases: [],
        gitRepositories: [
          { name: "demo", path: partial.workspace },
          // A repository with an active worktree, so the project row's excerpt
          // says `Active worktree: …` rather than repeating the path. With only
          // the first repository, both branches of that read the same.
          {
            name: "worktreed",
            path: "/tmp/one",
            activeWorktreePath: "/tmp/one-wt",
          },
        ],
        selectedGitRepository: "demo",
      }),
      () => [],
    );
    // The transcript reader falls back to `process.env.CODEX_HOME` when nothing
    // overrides it, so without this a Codex installation on the developer's own
    // machine contributes `session` items to the listing — and the gate stops
    // being about the fixture.
    await harness.startDaemon(runtime, { CODEX_HOME: join(runtime.home, ".codex") });
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
    };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      assert.deepStrictEqual(
        normalize(answers.candidate, candidate),
        normalize(answers.reference, reference),
      );
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\ncontext parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ncontext parity: ${steps.length} cases match`);
