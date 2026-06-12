import * as vscode from 'vscode';

/**
 * The Antigravity command bound to Ctrl+L ("Open Chat with Agent"). It opens the
 * agent chat and picks up the active editor's selection as context — so staging
 * our element context as a selection makes it land in the chat as a mention.
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

/**
 * Sends the clicked element's context to the Antigravity AI chat.
 *
 * Stages the context in an untitled markdown document, selects all of it, focuses
 * it (the chat command reads the focused editor's selection), then invokes the
 * Ctrl+L command. Once the chat has the context, `restoreFocus` is called to send
 * focus back to the browser panel so the user isn't left on the temp document.
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

    // Chat now has the context — return focus to the browser panel so the user
    // isn't stranded on the temp document.
    if (restoreFocus) {
      setTimeout(() => { try { restoreFocus(); } catch { /* ignore */ } }, 60);
    }
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
