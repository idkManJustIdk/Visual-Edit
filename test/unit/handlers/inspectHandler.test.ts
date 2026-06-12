import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock vscode ───────────────────────────────────────────────────────────────

const mockOpenTextDocument     = vi.fn();
const mockShowTextDocument     = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockExecuteCommand       = vi.fn();
const mockClipboardWrite       = vi.fn();

class Position { constructor(public line: number, public character: number) {} }
class Selection { constructor(public anchor: any, public active: any) {} }
class Range { constructor(public start: any, public end: any) {} }
class WorkspaceEdit { delete = vi.fn(); }

vi.mock('vscode', () => ({
  Position,
  Selection,
  Range,
  WorkspaceEdit,
  window: {
    showTextDocument:       mockShowTextDocument,
    showInformationMessage: mockShowInformationMessage,
    tabGroups: { all: [] },
  },
  workspace: {
    openTextDocument:       mockOpenTextDocument,
    applyEdit:              vi.fn().mockResolvedValue(true),
  },
  commands: {
    executeCommand: mockExecuteCommand,
  },
  env: {
    clipboard: { writeText: mockClipboardWrite },
  },
}));

const { handleInspectElement } = await import('../../../src/utils/handlers/inspectHandler');
const ANTIGRAVITY_CHAT_FOCUS = 'antigravity.toggleChatFocus';

// ── Helpers ───────────────────────────────────────────────────────────────────

function richMsg(overrides: Record<string, any> = {}) {
  return {
    tag: 'button',
    id: 'submit',
    classes: ['btn', 'btn-primary'],
    attributes: { type: 'submit', 'data-testid': 'go' },
    selector: 'form > button#submit',
    outerHTML: '<button id="submit" class="btn btn-primary">Go</button>',
    text: 'Go',
    rect: { x: 10, y: 20, width: 80, height: 30 },
    parentSummary: 'form#login',
    prevSibling: '<label> "Name"',
    nextSibling: '<a.link> "Help"',
    computed: { display: 'flex', padding: '8px 16px', color: 'rgb(0, 0, 0)' },
    parentComputed: { display: 'flex', 'flex-direction': 'column', gap: '12px' },
    viewport: { width: 1280, height: 720, dpr: 2 },
    pageUrl: 'http://localhost:3000/login',
    ...overrides,
  };
}

let lastEditor: any;

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenTextDocument.mockImplementation(({ content }: { content: string }) =>
    Promise.resolve({ positionAt: (n: number) => new Position(0, n), getText: () => content, uri: { toString: () => "untitled:1" }, _content: content }),
  );
  lastEditor = { selection: undefined, revealRange: vi.fn() };
  mockShowTextDocument.mockResolvedValue(lastEditor);
  mockExecuteCommand.mockResolvedValue(undefined);
});

// ── Happy path: hand off to Antigravity chat ──────────────────────────────────

describe('handleInspectElement — Antigravity handoff', () => {
  it('stages context in an untitled markdown doc and selects it', async () => {
    await handleInspectElement(richMsg());
    expect(mockOpenTextDocument).toHaveBeenCalledOnce();
    const arg = mockOpenTextDocument.mock.calls[0][0];
    expect(arg.language).toBe('markdown');
    expect(lastEditor.selection).toBeInstanceOf(Selection);
    expect(lastEditor.revealRange).toHaveBeenCalledOnce();
  });

  it('invokes the Ctrl+L chat command and skips the clipboard', async () => {
    await handleInspectElement(richMsg());
    expect(mockExecuteCommand).toHaveBeenCalledWith(ANTIGRAVITY_CHAT_FOCUS);
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('calls restoreFocus after handing off, to cover the temp doc', async () => {
    const restoreFocus = vi.fn();
    await handleInspectElement(richMsg(), undefined, restoreFocus);
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it('includes rich context (selector, attributes, outer HTML, url) in the staged doc', async () => {
    await handleInspectElement(richMsg());
    const content: string = mockOpenTextDocument.mock.calls[0][0].content;
    expect(content).toContain('form > button#submit');       // selector
    expect(content).toContain('`type` = `submit`');           // attribute
    expect(content).toContain('```html');                     // outer HTML fence
    expect(content).toContain('http://localhost:3000/login'); // url
    expect(content).toContain('form#login');                  // parent summary
  });

  it('renders the new template sections (styles, siblings, viewport)', async () => {
    await handleInspectElement(richMsg());
    const content: string = mockOpenTextDocument.mock.calls[0][0].content;
    expect(content).toContain('## Layout/Styles');
    expect(content).toContain('- display: flex');
    expect(content).toContain('flex-direction: column');
    expect(content).toContain('Viewport:');
    expect(content).toContain('1280x720 (dpr 2)');
    expect(content).toContain('Next sibling: <a.link>');
    expect(content).toContain('Box: 80x30 at (10, 20)');
  });

  it('prefers the realUrl argument over the page URL from the payload', async () => {
    await handleInspectElement(richMsg(), 'http://localhost:5173/real');
    const content: string = mockOpenTextDocument.mock.calls[0][0].content;
    expect(content).toContain('http://localhost:5173/real');
    expect(content).not.toContain('http://localhost:3000/login');
  });
});

// ── Fallback: command unavailable / throws ────────────────────────────────────

describe('handleInspectElement — clipboard fallback', () => {
  it('falls back to clipboard when the chat command throws', async () => {
    mockExecuteCommand.mockRejectedValue(new Error('command not found'));
    await handleInspectElement(richMsg());
    expect(mockClipboardWrite).toHaveBeenCalledOnce();
    expect(mockShowInformationMessage).toHaveBeenCalledOnce();
  });

  it('still copies to clipboard when staging the doc fails', async () => {
    mockOpenTextDocument.mockRejectedValue(new Error('no editor'));
    await handleInspectElement(richMsg());
    expect(mockExecuteCommand).not.toHaveBeenCalled(); // never staged a selection
    expect(mockClipboardWrite).toHaveBeenCalledOnce();
  });
});

// ── Sparse element ────────────────────────────────────────────────────────────

describe('handleInspectElement — minimal element', () => {
  it('handles an element with only a tag', async () => {
    await handleInspectElement({ tag: 'span' });
    const content: string = mockOpenTextDocument.mock.calls[0][0].content;
    expect(content).toContain('- Tag: span');
    expect(mockExecuteCommand).toHaveBeenCalledWith(ANTIGRAVITY_CHAT_FOCUS);
  });
});
