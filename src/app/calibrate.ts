/**
 * Calibration page. Draws rulers on the glasses so the real character and line
 * capacity can be read off a screenshot instead of guessed.
 *
 * Query parameters:
 *   cols  characters per ruler line (default 48)
 *   rows  number of ruler lines (default 9)
 */

import { CreateStartUpPageContainer, TextContainerProperty, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

function ruler(width: number): string {
  // Repeating 0..9 so a screenshot shows exactly where the cut happens.
  let out = '';
  for (let i = 0; i < width; i += 1) out += String(i % 10);
  return out;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const cols = Number.parseInt(params.get('cols') ?? '48', 10);
  const rows = Number.parseInt(params.get('rows') ?? '9', 10);

  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push(`${String.fromCharCode(65 + row)}${ruler(cols - 1)}`);
  }

  const bridge = await waitForEvenAppBridge();
  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          containerID: 1,
          containerName: 'ruler',
          paddingLength: 6,
          borderWidth: 0,
          borderColor: 0,
          isEventCapture: 1,
          textColor: 4,
          content: lines.join('\n'),
        }),
      ],
    }),
  );
  console.log(`calibrate cols=${cols} rows=${rows} create=${result}`);
}

void main().catch((error) => console.log(`calibrate failed: ${String(error)}`));
