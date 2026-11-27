import { EventEmitter } from 'node:events';
import type { TrafficSummary } from '@mokie/shared';

export type BusEvents = {
  traffic: [TrafficSummary];
  state: [string[]];
  config: [string];
};

/** In-process pub/sub used to push live updates to the admin UI (SSE). */
export class Bus extends EventEmitter<BusEvents> {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
}
