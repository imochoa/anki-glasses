/**
 * Turning a failure into something a wearer can act on.
 *
 * The display is 576x288 and sits in the corner of your eye, so an http status
 * and a json body are worse than useless there. The full message still goes to
 * the console for debugging.
 */

export interface CodedError {
  code?: string;
  message?: string;
}

export function explainFailure(error: unknown): string {
  const code = (error as CodedError | null)?.code;
  switch (code) {
    case 'anki-unreachable':
      return 'Anki is not answering.\nOpen Anki on the desktop.';
    case 'bad-key':
      return 'This link is missing its key.\nOpen the paired link again.';
    case 'server-error':
      return 'The card server hit an error.\nCheck its window.';
    default:
      break;
  }

  // fetch rejects with a TypeError when it cannot reach the host at all.
  if (error instanceof TypeError) return 'No connection to the card server.';

  const message = String(error instanceof Error ? error.message : error);
  return message.length <= 90 ? message : `${message.slice(0, 89)}...`;
}
