import * as vscode from 'vscode';

/** The Antigravity command bound to Ctrl+L ("Open Chat with Agent"). */
const ANTIGRAVITY_CHAT_FOCUS = 'antigravity.toggleChatFocus';

// ── Source-location lookup ────────────────────────────────────────────────────

/** Framework-generated class patterns that won't exist in user source code. */
const FRAMEWORK_CLASS_PATTERNS = [
  /^_ng(?:host|content)-/,
  /^ng-(?:star|scope|binding|isolate|pristine|dirty|valid|invalid|touched|untouched)/,
  /^cdk-/,
  /^mat-mdc-/,
  /^v-b-/,
];

/** Strips bundler/CSS-Modules hash suffixes to recover the original source class name. */
function stripHash(cls: string): string {
  let s = cls.replace(/^_+/, '');
  s = s.replace(/(?:_+|-{2,})[a-zA-Z0-9]*(?:[a-zA-Z][0-9]|[0-9][a-zA-Z])[a-zA-Z0-9]*(?:_\d+)?$/, '');
  return (s && s !== cls) ? s : cls;
}

interface SearchTerm { type: 'id' | 'class' | 'attr'; value: string; }
interface SourceInfo { relPath?: string; line?: number; matched?: string; searched: string[]; }

/** Builds prioritized, source-realistic search terms from the clicked element. */
function buildSearchTerms(msg: Record<string, any>): SearchTerm[] {
  const id: string = msg.id ?? '';
  const classes: string[] = Array.isArray(msg.classes) ? msg.classes : [];
  const attributes: Record<string, string> = msg.attributes ?? {};
  const isFramework = (c: string) => FRAMEWORK_CLASS_PATTERNS.some(r => r.test(c));

  const terms: SearchTerm[] = [];
  if (id) { terms.push({ type: 'id', value: id }); }
  if (attributes['data-testid']) { terms.push({ type: 'attr', value: attributes['data-testid'] }); }
  for (const c of classes) {
    if (isFramework(c)) { continue; }
    const clean = stripHash(c);
    if (clean) { terms.push({ type: 'class', value: clean }); }
  }
  const seen = new Set<string>();
  return terms.filter(t => (seen.has(t.value) ? false : (seen.add(t.value), true)));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A pattern that matches the term as it would appear in source (id=, class=, etc.). */
function termPattern(t: SearchTerm): RegExp {
  const v = escapeRe(t.value);
  if (t.type === 'id')    { return new RegExp('\\bid\\s*=\\s*["\'{`]?' + v + '\\b'); }
  if (t.type === 'class') { return new RegExp('(?:class|className)\\s*=\\s*["\'{`][^"\'`}]*\\b' + v + '\\b'); }
  return new RegExp('\\b' + v + '\\b');
}

// ── Caches (persist across clicks; invalidated on workspace changes) ───────────

const MARKUP_GLOB = '**/*.{html,htm,jsx,tsx,vue,svelte,astro,php,erb,hbs,ejs}';
const SCRIPT_GLOB = '**/*.{js,ts,mjs,cjs}';
const EXCLUDE_GLOB = '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/out/**,**/.next/**,**/.nuxt/**,**/coverage/**}';
const FILE_CAP = 1500;        // max files enumerated per group
const READ_CONCURRENCY = 32;  // parallel fs reads
const TIME_BUDGET_MS = 500;   // hard ceiling for the whole search
const MAX_CACHE_BYTES = 200_000; // don't cache files larger than this
const MAX_CACHE_ENTRIES = 4000;

let _markupFiles: vscode.Uri[] | null = null;
let _scriptFiles: vscode.Uri[] | null = null;
const _textCache = new Map<string, string>();
let _cacheWired = false;

function wireCacheInvalidation(): void {
  if (_cacheWired) { return; }
  _cacheWired = true;
  try {
    vscode.workspace.onDidSaveTextDocument(d => _textCache.delete(d.uri.toString()));
    vscode.workspace.onDidCreateFiles(() => { _markupFiles = null; _scriptFiles = null; });
    vscode.workspace.onDidDeleteFiles(() => { _markupFiles = null; _scriptFiles = null; _textCache.clear(); });
    vscode.workspace.onDidRenameFiles(() => { _markupFiles = null; _scriptFiles = null; });
  } catch { /* listeners unavailable in some hosts — non-fatal */ }
}

async function readTextCached(uri: vscode.Uri): Promise<string> {
  const key = uri.toString();
  const hit = _textCache.get(key);
  if (hit !== undefined) { return hit; }
  let txt = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.length <= MAX_CACHE_BYTES) {
      txt = Buffer.from(bytes).toString('utf8');
      if (_textCache.size < MAX_CACHE_ENTRIES) { _textCache.set(key, txt); }
    } else {
      // Too big to cache; read transiently so we can still match it.
      txt = Buffer.from(bytes).toString('utf8');
    }
  } catch { /* ignore unreadable files */ }
  return txt;
}

/** Scans one file group for the terms (priority order), reading in parallel chunks. */
async function scanGroup(files: vscode.Uri[], terms: SearchTerm[], deadline: number): Promise<SourceInfo | null> {
  const patterns = terms.map(t => ({ t, re: termPattern(t) }));
  for (const { t, re } of patterns) {
    for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
      if (Date.now() > deadline) { return null; }
      const chunk = files.slice(i, i + READ_CONCURRENCY);
      const texts = await Promise.all(chunk.map(readTextCached));
      for (let j = 0; j < chunk.length; j++) {
        const txt = texts[j];
        if (!txt) { continue; }
        const m = re.exec(txt);
        if (m) {
          const line = txt.slice(0, m.index).split('\n').length;
          return { relPath: vscode.workspace.asRelativePath(chunk[j]), line, matched: t.value, searched: [] };
        }
      }
    }
  }
  return null;
}

/**
 * Best-effort: searches workspace source files for where the clicked element is
 * defined, preferring id/test-id matches over class matches. Markup files are
 * scanned first; results, the file list, and file contents are cached.
 */
async function findSourceLocation(msg: Record<string, any>): Promise<SourceInfo> {
  const terms = buildSearchTerms(msg);
  const searched = terms.map(t => t.value);
  if (terms.length === 0) { return { searched }; }

  wireCacheInvalidation();
  const deadline = Date.now() + TIME_BUDGET_MS;

  try {
    if (_markupFiles === null) { _markupFiles = await vscode.workspace.findFiles(MARKUP_GLOB, EXCLUDE_GLOB, FILE_CAP); }
    let hit = await scanGroup(_markupFiles, terms, deadline);

    if (!hit && Date.now() < deadline) {
      if (_scriptFiles === null) { _scriptFiles = await vscode.workspace.findFiles(SCRIPT_GLOB, EXCLUDE_GLOB, FILE_CAP); }
      hit = await scanGroup(_scriptFiles, terms, deadline);
    }

    if (hit) { return { ...hit, searched }; }
  } catch { /* best effort */ }

  return { searched };
}

// ── Context formatting ────────────────────────────────────────────────────────

function renderStyles(obj?: Record<string, string>): string {
  if (!obj) { return ''; }
  const entries = Object.entries(obj);
  return entries.length ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : '';
}

/** Builds the markdown context block following the agreed template. */
function formatElementContext(msg: Record<string, any>, realUrl?: string, source?: SourceInfo): string {
  const tag: string                 = msg.tag ?? 'unknown';
  const id: string                  = msg.id ?? '';
  const classes: string[]           = Array.isArray(msg.classes) ? msg.classes : [];
  const attributes: Record<string, string> = msg.attributes ?? {};
  const selector: string            = msg.selector ?? '';
  const outerHTML: string           = msg.outerHTML ?? '';
  const text: string                = msg.text ?? '';
  const rect = msg.rect ?? {};
  const parentSummary: string       = msg.parentSummary ?? '';
  const prevSibling: string         = msg.prevSibling ?? '';
  const nextSibling: string         = msg.nextSibling ?? '';
  const computed                    = msg.computed as Record<string, string> | undefined;
  const parentComputed              = msg.parentComputed as Record<string, string> | undefined;
  const viewport                    = msg.viewport as { width: number; height: number; dpr: number } | undefined;
  const url = realUrl || msg.pageUrl || '';

  let filePath = 'unknown';
  if (url.startsWith('file://')) {
    try { filePath = vscode.Uri.parse(url).fsPath; } catch { filePath = url; }
  } else if (source?.relPath) {
    filePath = source.relPath;
  }

  const sourceLoc = (source?.relPath && source?.line)
    ? `${source.relPath}:${source.line}${source.matched ? ` (matched "${source.matched}")` : ''}`
    : `not found (searched: ${source?.searched.length ? source.searched.join(', ') : 'none'})`;

  const attrLines = Object.entries(attributes)
    .map(([k, v]) => `- \`${k}\`${v ? ` = \`${v}\`` : ''}`)
    .join('\n');
  const box = (rect.width || rect.height)
    ? `${rect.width}x${rect.height} at (${rect.x}, ${rect.y})`
    : 'unknown';
  const vp = viewport ? `${viewport.width}x${viewport.height} (dpr ${viewport.dpr})` : 'unknown';

  return [
    `the context below is about a specific element in the code/website. I clicked this element in a browser preview. Use this as the selected UI target (i might mention more elements, so treat them based on context from the prompt itself).`,
    ``,
    `## Element`,
    `- Tag: ${tag}`,
    `- ID: ${id}`,
    `- Classes: ${classes.join(' ')}`,
    `- Selector: ${selector}`,
    `- Page URL: ${url}`,
    `- File path: ${filePath}`,
    `- Source Location: ${sourceLoc}`,
    `- Box: ${box}`,
    ``,
    `## Content`,
    text || '(no visible text)',
    ``,
    `## DOM Context`,
    `- Parent: ${parentSummary || '(none)'}`,
    `- Previous sibling: ${prevSibling || '(none)'}`,
    `- Next sibling: ${nextSibling || '(none)'}`,
    ``,
    `## Layout/Styles`,
    `Element computed styles:`,
    renderStyles(computed) || '(unavailable)',
    ``,
    `Parent computed styles:`,
    renderStyles(parentComputed) || '(unavailable)',
    ``,
    `Viewport:`,
    vp,
    ``,
    `## Attributes`,
    attrLines || '(none)',
    ``,
    `## Outer HTML`,
    '```html',
    outerHTML || '(unavailable)',
    '```',
  ].join('\n');
}

/** Clears and closes the staged untitled doc without a "save?" prompt. */
async function closeTempDoc(doc: vscode.TextDocument): Promise<void> {
  try {
    // Empty the buffer first — an empty untitled doc closes silently (no save prompt).
    const full = new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, full);
    await vscode.workspace.applyEdit(edit);

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input: any = tab.input;
        if (input?.uri && input.uri.toString() === doc.uri.toString()) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  } catch { /* best effort — ignore */ }
}

/**
 * Sends the clicked element's context to the Antigravity AI chat.
 *
 * Looks up the element's source location, stages the context in an untitled
 * preview document, selects all of it, focuses it (the chat command reads the
 * focused editor's selection), then invokes the Ctrl+L command. `restoreFocus`
 * then covers the temp document with the browser and focuses the chat input.
 * Falls back to the clipboard if the command isn't available.
 */
export async function handleInspectElement(
  msg: Record<string, any>,
  realUrl?: string,
  restoreFocus?: () => void,
) {
  const source = await findSourceLocation(msg);
  const context = formatElementContext(msg, realUrl, source);

  let lastError: unknown;
  try {
    const doc = await vscode.workspace.openTextDocument({ content: context, language: 'markdown' });
    const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });

    const start = new vscode.Position(0, 0);
    const end = doc.positionAt(context.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end));

    // Let the editor focus + selection settle before invoking the command.
    await new Promise((resolve) => setTimeout(resolve, 1));

    await vscode.commands.executeCommand(ANTIGRAVITY_CHAT_FOCUS);

    // Cover the temp document with the browser and focus the chat input right away.
    restoreFocus?.();

    // Once the handoff is fully done, close the temp document.
    setTimeout(() => { void closeTempDoc(doc); }, 3);
    return;
  } catch (err) {
    lastError = err;
  }

  // Fallback — keep the context on the clipboard and report why the auto-open failed.
  await vscode.env.clipboard.writeText(context);
  const detail = lastError instanceof Error && lastError.message ? ` (reason: ${lastError.message})` : '';
  vscode.window.showInformationMessage(
    `Element context copied to clipboard — open the Antigravity chat and paste it (Ctrl+V).${detail}`,
  );
}
