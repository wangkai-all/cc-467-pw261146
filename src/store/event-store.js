import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 仅追加（append-only）事件存储。
 * 所有状态变更都以事件落盘，当前状态与历史快照均由事件折叠得到，
 * 因此新血缘永远不会覆盖历史版本。
 */
export class EventStore {
  constructor(dir) {
    this.dir = dir;
    this.filePath = path.join(dir, 'events.jsonl');
    this._seq = 0;
    // 串行化追加，保证全局序号与写入顺序一致
    this._chain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    const events = await this.readAll();
    for (const ev of events) this._seq = Math.max(this._seq, ev.seq);
    return events;
  }

  append(type, payload) {
    const result = this._chain.then(async () => {
      const seq = this._seq + 1;
      const event = {
        eventId: randomUUID(),
        seq,
        type,
        at: new Date().toISOString(),
        payload,
      };
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`);
      this._seq = seq;
      return event;
    });
    // 保证下一次 append 排在本次之后，即使本次失败也不中断链条
    this._chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async readAll() {
    let txt;
    try {
      txt = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    return txt
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
