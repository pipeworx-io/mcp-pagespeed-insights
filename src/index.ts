interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Google PageSpeed Insights — runs Lighthouse against any public URL and returns the performance scores, the real-user field data, and the ranked list of fixes.
 *
 * It is Google's public web-performance analysis API: the page is loaded on
 * Google's own infrastructure and you get back both the LAB result (a
 * controlled synthetic test, with the specific opportunities that would make
 * the page faster) and the FIELD result (the real-user Chrome UX Report
 * measurements for that page and its origin).
 *
 * WHAT THIS ANSWERS THAT crux DOES NOT. The `chrome-ux-report` pack reports
 * what real visitors experienced; it cannot tell you WHY, because field data
 * has no diagnostics. PageSpeed Insights runs the page and names the causes —
 * render-blocking resources, unused JavaScript, images without dimensions,
 * uncompressed responses — each with the milliseconds or bytes it costs. Use
 * crux for "is this site fast for real users", use this for "what specifically
 * is making it slow, and what do I fix first".
 *
 * CREDENTIALS — READ THIS BEFORE FILING A BUG
 * -------------------------------------------
 * PageSpeed Insights documents a keyless path, and it genuinely exists: the
 * API accepts a request with no `key` parameter. In practice it is unusable.
 * Unkeyed requests are billed to a single shared Google anonymous consumer
 * project, and that project's daily quota is exhausted. Verified live
 * 2026-09-17: three consecutive unkeyed calls, all HTTP 429, "Quota exceeded
 * for quota metric 'Queries' ... for consumer 'project_number:583797351490'".
 * That project number is the same for every anonymous caller on the internet,
 * so the quota is not ours to nurse and retrying does not help.
 *
 * So this pack TRIES the keyless path first and falls back to a refusal that
 * says a key is needed. A caller can bring their own as `_apiKey`; the gateway
 * supplies `PLATFORM_GOOGLE_API_KEY` when that secret is set. A key is free,
 * instant and needs no billing account: create one at
 * https://console.cloud.google.com/apis/credentials and enable the PageSpeed
 * Insights API at
 * https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com
 * (25,000 requests/day, 240/minute).
 *
 * TRAPS, VERIFIED LIVE 2026-09-17
 * -------------------------------
 * 1. A CALL TAKES 10-40 SECONDS. Google actually loads the page, twice for a
 *    cold origin. The default fetch bound is too short, so an explicit 60s
 *    budget is passed. A caller batching ten URLs should expect minutes.
 * 2. THE LAB SCORE AND THE FIELD DATA DISAGREE ROUTINELY, AND BOTH ARE RIGHT.
 *    The lab run is one load on a throttled emulated phone from a Google data
 *    centre; the field block is 28 days of real visits on real devices and
 *    networks. A 95 lab score with failing field CWV means real users are on
 *    worse hardware than the emulation, and it is the FIELD number that Search
 *    uses. Both are returned, labelled, never blended.
 * 3. `loadingExperience` IS THE PAGE, `originLoadingExperience` IS THE SITE.
 *    For a low-traffic URL the page block is absent entirely while the origin
 *    block is present — and Google marks that by setting
 *    `loadingExperience.origin_fallback: true` while still populating it with
 *    the ORIGIN's numbers. Reading that as page data attributes the whole
 *    site's performance to one URL. This pack reports the fallback explicitly.
 * 4. CATEGORY SCORES ARE 0-1 FLOATS, NOT 0-100. `performance: 0.62` is the
 *    familiar "62". They are also NULLABLE — a category that errored comes
 *    back with a null score and an error audit, not a zero.
 * 5. AN UNREACHABLE TARGET IS AN HTTP 400 FROM GOOGLE, not a 404 or a 5xx, and
 *    the useful part is buried in error.errors[].reason. A caller reading only
 *    the status sees "bad request" for what is actually "your site returned a
 *    500 to Google's crawler".
 */


const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const UA = 'pipeworx-mcp-pagespeed-insights/1.0 (+https://pipeworx.io)';
const KEY_URL = 'https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com';
/** Trap 1. */
const TIMEOUT_MS = 60_000;

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

/** CrUX metric ids as PageSpeed Insights spells them, with their units. */
const FIELD_METRICS: Record<string, { label: string; unit: 'ms' | 'score' }> = {
  LARGEST_CONTENTFUL_PAINT_MS: { label: 'Largest Contentful Paint', unit: 'ms' },
  INTERACTION_TO_NEXT_PAINT: { label: 'Interaction to Next Paint', unit: 'ms' },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { label: 'Cumulative Layout Shift', unit: 'score' },
  FIRST_CONTENTFUL_PAINT_MS: { label: 'First Contentful Paint', unit: 'ms' },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: { label: 'Time to First Byte', unit: 'ms' },
};

/** Lab metric audits worth surfacing by default, in reporting order. */
const LAB_METRIC_AUDITS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'speed-index',
  'total-blocking-time',
  'cumulative-layout-shift',
  'interactive',
];

interface PsiAudit {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  numericUnit?: string;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number; items?: unknown[] };
}
interface PsiResponse {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> };
  id?: string;
  analysisUTCTimestamp?: string;
  lighthouseResult?: {
    requestedUrl?: string;
    finalUrl?: string;
    lighthouseVersion?: string;
    fetchTime?: string;
    configSettings?: { formFactor?: string; emulatedFormFactor?: string };
    categories?: Record<string, { id?: string; title?: string; score?: number | null; auditRefs?: Array<{ id: string; group?: string; weight?: number }> }>;
    audits?: Record<string, PsiAudit>;
  };
  loadingExperience?: PsiLoadingExperience;
  originLoadingExperience?: PsiLoadingExperience;
}
interface PsiLoadingExperience {
  id?: string;
  origin_fallback?: boolean;
  overall_category?: string;
  initial_url?: string;
  metrics?: Record<string, { percentile?: number; category?: string; distributions?: Array<{ min?: number; max?: number; proportion?: number }> }>;
}

async function runPagespeed(args: Record<string, unknown>, categories: string[]): Promise<PsiResponse> {
  const url = String(args.url ?? '').trim();
  if (!url) throw new Error('`url` is required — the full page URL to analyse, including the scheme.');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`\`url\` must include the scheme, e.g. https://example.com — got "${url}".`);
  }
  const strategy = args.strategy ? String(args.strategy).trim().toLowerCase() : 'mobile';
  if (!['mobile', 'desktop'].includes(strategy)) {
    throw new Error(`\`strategy\` must be "mobile" or "desktop" — got "${strategy}".`);
  }
  const locale = args.locale ? String(args.locale).trim() : null;
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';

  const qs = new URLSearchParams();
  qs.set('url', url);
  qs.set('strategy', strategy);
  for (const c of categories) qs.append('category', c);
  if (locale) qs.set('locale', locale);
  if (key) qs.set('key', key);

  const res = await fetchWithTimeout(
    `${API}?${qs.toString()}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    'PageSpeed Insights API (Google)',
    TIMEOUT_MS,
  );
  const text = await res.text();
  let json: PsiResponse;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PageSpeed Insights returned HTTP ${res.status} with a non-JSON body: ${summarizeErrorBody(text)}`);
  }

  if (res.ok && json.lighthouseResult) return json;

  const message = json.error?.message ?? summarizeErrorBody(text);
  if ((res.status === 429 || res.status === 403) && !key) {
    throw new Error(
      `PageSpeed Insights requires an API key in practice. The documented keyless path exists but every unkeyed caller on the internet shares one Google anonymous project whose daily quota is exhausted, so it answers HTTP ${res.status}. Get a free key (no billing account, 25,000 requests/day) at https://console.cloud.google.com/apis/credentials, enable the API at ${KEY_URL}, and pass it as _apiKey. Upstream said: ${message}`,
    );
  }
  if (res.status === 400 && /API key not valid/i.test(message)) {
    throw new Error(`The API key was rejected as invalid by Google. Upstream said: ${message}`);
  }
  if (res.status === 429) {
    throw new Error(`The API key's PageSpeed Insights quota is exhausted (HTTP 429). Upstream said: ${message}`);
  }
  // Trap 5.
  const reason = json.error?.errors?.[0]?.reason ?? null;
  if (res.status === 400) {
    throw new Error(
      `Google could not analyse ${url}. This is reported as HTTP 400 even when the cause is the TARGET SITE — a redirect loop, a 5xx, a robots block or a page that never finished loading — not a malformed request. Reason: ${reason ?? 'unspecified'}. Upstream said: ${message}`,
    );
  }
  throw new Error(`PageSpeed Insights returned HTTP ${res.status}${reason ? ` (${reason})` : ''}: ${message}`);
}

/** Trap 4: scores are 0-1 floats and may be null. */
function pct(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return Math.round(score * 100);
}

function shapeField(exp: PsiLoadingExperience | undefined, kind: 'page' | 'origin') {
  if (!exp || !exp.metrics) return null;
  const metrics: Record<string, unknown> = {};
  for (const [id, m] of Object.entries(exp.metrics)) {
    const def = FIELD_METRICS[id];
    // CLS arrives multiplied by 100 as an integer in this API (unlike the CrUX
    // API, which returns a decimal string). 5 here is a CLS of 0.05.
    const raw = m.percentile ?? null;
    const p75 = raw === null ? null : def?.unit === 'score' ? raw / 100 : raw;
    metrics[id] = {
      label: def?.label ?? id,
      unit: def?.unit ?? null,
      p75,
      assessment: m.category ? m.category.toLowerCase().replace(/_/g, '-') : null,
      distribution: (m.distributions ?? []).map((d) => ({ min: d.min ?? null, max: d.max ?? null, proportion: d.proportion ?? null })),
    };
  }
  return {
    scope: kind,
    // Trap 3.
    is_origin_fallback: exp.origin_fallback === true,
    id: exp.id ?? null,
    overall_assessment: exp.overall_category ? exp.overall_category.toLowerCase().replace(/_/g, '-') : null,
    metrics,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'pagespeed_audit',
    description:
      "Run Google's PageSpeed Insights (Lighthouse) against any public URL and get back the performance, accessibility, best-practices and SEO scores, the lab timing metrics behind them, and the RANKED list of specific fixes with the milliseconds or bytes each one would save — render-blocking resources, unused JavaScript and CSS, unoptimised images, missing text compression. AUTHORITATIVE for \"why is this page slow and what do I fix first\": this is Google's own analyser running the page on Google's infrastructure, which is what no amount of reading a site's HTML can substitute for. Works on any public site, including a competitor's. A call takes 10-40 seconds because the page is genuinely loaded.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full page URL to analyse, including the scheme, e.g. https://www.example.com/pricing.' },
        strategy: {
          type: 'string',
          description: 'Device to emulate: mobile (the default, and what Google indexes with) or desktop.',
          enum: ['mobile', 'desktop'],
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which Lighthouse categories to run. Defaults to performance only, which is much faster. Options: performance, accessibility, best-practices, seo.',
        },
        max_opportunities: { type: 'number', description: 'How many ranked improvement opportunities to return (default 10, max 30).' },
        locale: { type: 'string', description: 'BCP-47 locale for the audit titles, e.g. en, fr, ja. Defaults to English.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'pagespeed_field_metrics',
    description:
      "Real-user Core Web Vitals for a page AND for its whole origin in one call, from Google's Chrome UX Report as PageSpeed Insights serves it — 75th-percentile Largest Contentful Paint, Interaction to Next Paint, Cumulative Layout Shift and Time to First Byte, with the good/needs-improvement/poor split behind each and Google's own pass/fail verdict. AUTHORITATIVE for whether a page passes Core Web Vitals, and it says plainly when a low-traffic page has no data of its own and Google substituted the origin's — a substitution that otherwise reads as page data and misattributes the whole site's performance to one URL.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full page URL, including the scheme, e.g. https://www.example.com/pricing.' },
        strategy: {
          type: 'string',
          description: 'Device class for the field data: mobile (the default) or desktop.',
          enum: ['mobile', 'desktop'],
        },
      },
      required: ['url'],
    },
  },
];

async function audit(args: Record<string, unknown>) {
  const requested = Array.isArray(args.categories) ? (args.categories as unknown[]).map((c) => String(c).trim().toLowerCase()) : ['performance'];
  const bad = requested.filter((c) => !CATEGORIES.includes(c));
  if (bad.length) throw new Error(`Unknown categor(ies): ${bad.join(', ')}. Valid: ${CATEGORIES.join(', ')}.`);
  const maxOpps = Math.min(Math.max(Number(args.max_opportunities) || 10, 1), 30);

  const json = await runPagespeed(args, requested);
  const lh = json.lighthouseResult!;
  const audits = lh.audits ?? {};

  const categories: Record<string, unknown> = {};
  for (const [id, c] of Object.entries(lh.categories ?? {})) {
    categories[id] = { title: c.title ?? id, score: pct(c.score), score_raw: c.score ?? null };
  }

  const labMetrics: Record<string, unknown> = {};
  for (const id of LAB_METRIC_AUDITS) {
    const a = audits[id];
    if (!a) continue;
    labMetrics[id] = {
      title: a.title ?? id,
      display_value: a.displayValue ?? null,
      numeric_value: a.numericValue ?? null,
      numeric_unit: a.numericUnit ?? null,
      score: pct(a.score),
    };
  }

  // Opportunities and diagnostics that actually carry a saving, ranked by it.
  const opportunities = Object.values(audits)
    .filter((a) => a.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) > 0)
    .sort((a, b) => (b.details?.overallSavingsMs ?? 0) - (a.details?.overallSavingsMs ?? 0))
    .slice(0, maxOpps)
    .map((a) => ({
      id: a.id ?? null,
      title: a.title ?? null,
      description: a.description ?? null,
      estimated_savings_ms: a.details?.overallSavingsMs ?? null,
      estimated_savings_bytes: a.details?.overallSavingsBytes ?? null,
      display_value: a.displayValue ?? null,
      affected_item_count: Array.isArray(a.details?.items) ? a.details!.items!.length : null,
    }));

  const failing = Object.values(audits)
    .filter((a) => a.scoreDisplayMode === 'binary' && a.score === 0)
    .slice(0, maxOpps)
    .map((a) => ({ id: a.id ?? null, title: a.title ?? null, display_value: a.displayValue ?? null }));

  const field = shapeField(json.loadingExperience, 'page');

  return {
    url: lh.requestedUrl ?? String(args.url),
    final_url: lh.finalUrl ?? null,
    strategy: lh.configSettings?.formFactor ?? lh.configSettings?.emulatedFormFactor ?? (args.strategy ?? 'mobile'),
    analysed_at: json.analysisUTCTimestamp ?? lh.fetchTime ?? null,
    lighthouse_version: lh.lighthouseVersion ?? null,
    category_scores: categories,
    lab_metrics: labMetrics,
    opportunity_count: opportunities.length,
    opportunities,
    failing_audits: failing,
    field_data_summary: field
      ? { is_origin_fallback: field.is_origin_fallback, overall_assessment: field.overall_assessment }
      : null,
    // Trap 2.
    lab_vs_field_note:
      'Scores and lab_metrics are a single synthetic load on a throttled emulated device from a Google data centre. They are diagnostics, not the assessment Google Search uses — that is the FIELD data (pagespeed_field_metrics or the chrome-ux-report pack), which is 28 days of real visits. A high lab score alongside failing field vitals is common and both numbers are correct.',
    source: 'PageSpeed Insights (Lighthouse), Google',
    source_url: 'https://developers.google.com/speed/docs/insights/v5/get-started',
  };
}

async function fieldMetrics(args: Record<string, unknown>) {
  // The field blocks come back whatever category is requested; performance is
  // the cheapest run that still returns them.
  const json = await runPagespeed(args, ['performance']);
  const page = shapeField(json.loadingExperience, 'page');
  const origin = shapeField(json.originLoadingExperience, 'origin');

  if (!page && !origin) {
    return {
      found: false,
      url: String(args.url),
      note: 'The Chrome UX Report has no real-user data for this page or its origin. That is the normal answer below Google\'s traffic threshold — the dataset only publishes once a site has enough opted-in Chrome visits to be statistically sound and non-identifying. The lab audit (pagespeed_audit) still works on any reachable page.',
      source: 'Chrome UX Report via PageSpeed Insights, Google',
      source_url: 'https://developers.google.com/speed/docs/insights/v5/get-started',
    };
  }

  return {
    found: true,
    url: json.lighthouseResult?.requestedUrl ?? String(args.url),
    strategy: args.strategy ?? 'mobile',
    analysed_at: json.analysisUTCTimestamp ?? null,
    page: page,
    origin: origin,
    // Trap 3.
    page_data_note: page?.is_origin_fallback
      ? 'This page has too little traffic for its own Chrome UX Report entry, so the "page" block below carries the ORIGIN\'s numbers, not this URL\'s. Google flags that with origin_fallback and it is reported here as is_origin_fallback: true — do not attribute these figures to this page.'
      : 'The page block is this URL\'s own real-user data; the origin block is the whole site.',
    assessed_at_p75_note:
      'Core Web Vitals is assessed at the 75th percentile of real visits over a trailing 28 days, and Google Search requires LCP, INP and CLS all "good" to pass. CLS is a unitless score here (already converted from the integer the API returns); every other metric is milliseconds.',
    source: 'Chrome UX Report via PageSpeed Insights, Google',
    source_url: 'https://developers.google.com/speed/docs/insights/v5/get-started',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'pagespeed_audit':
      return audit(args);
    case 'pagespeed_field_metrics':
      return fieldMetrics(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
