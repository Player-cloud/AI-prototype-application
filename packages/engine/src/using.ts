/** The one line shown before a task starts, e.g. "Using: Sonnet 5.5, file edits, shell". */
export function usingLine(model: string, tools: string[]): string {
  const short = model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
  const name = short.charAt(0).toUpperCase() + short.slice(1);
  return `Using: ${[name, ...tools].join(', ')}`;
}
