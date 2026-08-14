import { PerfectWS as ConditionalPerfectWS } from 'perfect-ws';
import { PerfectWS as ExplicitBrowserPerfectWS } from 'perfect-ws/browser';

if (ConditionalPerfectWS !== ExplicitBrowserPerfectWS) {
  throw new Error('The package browser condition and explicit browser entry resolved differently');
}

const app = document.querySelector<HTMLElement>('#app');
if (app) app.textContent = 'PerfectWS browser import ready';
