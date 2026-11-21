// Used only by the Playwright scale runner. All live frames use the normal worker pump.
import { growTo, plantValley } from './valley-layout';
import { startSimulation } from '../src/worker/sim.worker';

const dispatch = self.onmessage!;
let town: ReturnType<typeof plantValley>;
self.onmessage = (event: MessageEvent) => {
  if (event.data.type === 'init') {
    town = plantValley();
    growTo(town, 150);
    startSimulation(town.session, 8);
  } else if (event.data.type === 'growTo') {
    growTo(town, event.data.target);
    self.postMessage({ type: 'zoningChanged', edits: town.session.edits });
    dispatch.call(
      self,
      new MessageEvent('message', { data: { type: 'setSpeed', speed: event.data.target === 500 ? 8 : 1 } }),
    );
  } else dispatch.call(self, event);
};
