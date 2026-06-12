import * as vscode from 'vscode';

/**
 * The Antigravity command bound to Ctrl+L ("Open Chat with Agent"). It opens the
 * agent chat and picks up the active editor's selection as context — so staging
 * our element context as a selection makes it land in the chat as a mention,
 * without the agent auto-running anything.
 */
const ANTIGRAVITY_CHAT_FOCUS = 'antigravity.toggleChatFocus';

/** Builds a human + AI friendly markdown block describing the clicked element. */
function formatElementContext(msg: Record<string, any>, realUrl?: string): string {
  const tag: string                 = msg.tag ?? 'unknown';
  const id: string                  = msg.id ?? '';
  const classes: string[]           = Array.isArray(msg.classes) ? msg.classes : [];
  const attributes: Record<string, string> = msg.attributes ?? {};
  const selector: string            = msg.selector ?? '';
  const outerHTML: string           = msg.outerHTML ?? '';
  const text: string                = msg.text ?? '';
  const rect = msg.rect ?? {};
  const parentSummary: string       = msg.parentSummary ?? '';
  const url = realUrl || msg.pageUrl || '';

  const attrLines = Object.entries(attributes)
    .map(([k, v]) => `- \`${k}\`${v ? ` = \`${v}\`` : ''}`)
    .join('\n');

  const lines = [
    `I clicked this element in the browser preview. Here is its context — please help me with it:`,
    ``,
    `**Element:** \`<${tag}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}>\``,
    selector ? `**CSS selector:** \`${selector}\`` : '',
    parentSummary ? `**Parent:** \`${parentSummary}\`` : '',
    url ? `**Page URL:** ${url}` : '',
    (rect.width || rect.height) ? `**Position/size:** ${rect.width}×${rect.height} at (${rect.x}, ${rect.y})` : '',
    text ? `\n**Visible text:**\n> ${text}` : '',
    attrLines ? `\n**Attributes:**\n${attrLines}` : '',
    outerHTML ? `\n**Outer HTML:**\n\`\`\`html\n${outerHTML}\n\`\`\`` : '',
  ].filter(Boolean);

  return lines.join('\n');
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
 * Stages the context in an untitled preview document, selects all of it, focuses
 * it (the chat command reads the focused editor's selection), then invokes the
 * Ctrl+L command. Immediately after, `restoreFocus` covers the temp document with
 * the browser and focuses the chat input; 10ms later the temp doc is closed.
 * Falls back to the clipboard if the command isn't available.
 */
export async function handleInspectElement(
  msg: Record<string, any>,
  realUrl?: string,
  restoreFocus?: () => void,
) {
  const context = formatElementContext(msg, realUrl);

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

    // Clean up the temp document shortly after the handoff.
    setTimeout(() => { void closeTempDoc(doc); }, 10);
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
