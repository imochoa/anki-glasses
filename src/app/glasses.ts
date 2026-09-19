/**
 * Drawing on the G2 display.
 *
 * The page is three text containers: a header with the deck and progress, the
 * card body, and a footer that spells out what each gesture will do. They are
 * created once and then updated in place, because rebuilding the whole page on
 * every card is a lot of traffic for a narrow BLE link.
 */

import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';

export const SCREEN = { width: 576, height: 288 } as const;

export const CONTAINER = {
  header: 1,
  body: 2,
  footer: 3,
} as const;

export interface Frame {
  header: string;
  body: string;
  footer: string;
}

const REGIONS = {
  header: { xPosition: 0, yPosition: 0, width: SCREEN.width, height: 34 },
  body: { xPosition: 0, yPosition: 36, width: SCREEN.width, height: 206 },
  footer: { xPosition: 0, yPosition: 244, width: SCREEN.width, height: 44 },
} as const;

function textContainer(
  id: number,
  name: string,
  region: { xPosition: number; yPosition: number; width: number; height: number },
  content: string,
  options: { capture?: boolean; brightness?: number } = {},
): TextContainerProperty {
  return new TextContainerProperty({
    ...region,
    containerID: id,
    containerName: name,
    content,
    paddingLength: 6,
    borderWidth: 0,
    borderColor: 0,
    isEventCapture: options.capture ? 1 : 0,
    textColor: options.brightness ?? 4,
  });
}

function containersFor(frame: Frame): TextContainerProperty[] {
  return [
    // Only one container captures input, so a gesture has one owner.
    textContainer(CONTAINER.header, 'header', REGIONS.header, frame.header, { brightness: 2 }),
    textContainer(CONTAINER.body, 'body', REGIONS.body, frame.body, { capture: true }),
    textContainer(CONTAINER.footer, 'footer', REGIONS.footer, frame.footer, { brightness: 2 }),
  ];
}

export class GlassesDisplay {
  private created = false;
  private last: Frame | null = null;

  constructor(private readonly bridge: EvenAppBridge) {}

  async create(frame: Frame): Promise<void> {
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: containersFor(frame),
      }),
    );
    // StartUpPageCreateResult.success is 0.
    if (result !== 0) {
      throw new Error(`createStartUpPageContainer refused the page (code ${result})`);
    }
    this.created = true;
    this.last = frame;
  }

  /**
   * Update only the regions that changed. Falls back to a full rebuild if the
   * in place update is rejected, so a firmware that dislikes the upgrade path
   * still shows the right card.
   */
  async render(frame: Frame): Promise<void> {
    if (!this.created) {
      await this.create(frame);
      return;
    }

    const previous = this.last;
    const changed: Array<keyof Frame> = (['header', 'body', 'footer'] as const).filter(
      (key) => !previous || previous[key] !== frame[key],
    );
    if (changed.length === 0) return;

    for (const key of changed) {
      const ok = await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER[key],
          containerName: key,
          content: frame[key],
          contentOffset: 0,
          contentLength: frame[key].length,
        }),
      );
      if (!ok) {
        await this.rebuild(frame);
        return;
      }
    }
    this.last = frame;
  }

  private async rebuild(frame: Frame): Promise<void> {
    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: containersFor(frame),
      }),
    );
    this.last = frame;
  }

  async close(): Promise<void> {
    await this.bridge.shutDownPageContainer(0);
  }
}
